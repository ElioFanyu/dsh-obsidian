/**
 * Host half of `dsh-obsidian`.
 *
 * The plugin's actual work happens in a child process: DSH starts the vendored
 * `obsidian-mcp` server over stdio and the model sees its tools as
 * `mcp__obsidian__*`. That half is somebody else's code, and it is deliberately
 * not touched here.
 *
 * What this file adds is the part the bundle was missing: when the configured
 * vault is wrong, the failure currently shows up as tools that simply are not
 * there. So the host half
 *
 *   1. reads the `--vault` arguments of the MCP row it launched alongside,
 *   2. validates them with the same rules the server uses, and
 *   3. publishes the result on a read-only route, so "why is `mcp__obsidian__…`
 *      missing?" has an answer that does not require reading a log.
 *
 * It registers no tools, writes nothing to the vault, and opens no socket of its
 * own: removing the plugin removes every trace of it.
 *
 * @module dsh-obsidian
 */

import { parseVaultArgs, inspectVaults, MAX_VAULTS } from "./vaults.js";
import { resolveServerEntry, resolveServerCwd, serverRoot } from "./launch.js";

export const name = "dsh-obsidian";

/** The health route needs the web server; without it the plugin is inert. */
export const inject = ["webServer"];

/** Where the report lives. Namespaced so it cannot collide with the harness. */
export const HEALTH_PATH = "/plugins/dsh-obsidian/health";

/** The loader row id this plugin reads its own launch arguments from. */
const MCP_ENTRY_ID = "obsidian-mcp";

/**
 * Find the MCP row's `--vault` arguments.
 *
 * The row is read from the loader rather than duplicated in this plugin's own
 * config: one place states the vault, and a validator that can disagree with the
 * thing it validates is worse than none.
 *
 * @param {any} ctx
 * @returns {{ args: unknown, source: string } | undefined}
 */
function mcpRowArgs(ctx) {
  let loader;
  try {
    loader = ctx?.loader ?? ctx?.get?.("loader");
  } catch {
    return undefined;
  }
  if (loader === undefined || loader === null) return undefined;

  let entries;
  try {
    entries = typeof loader.entries === "function" ? [...loader.entries()] : [];
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const options = entry?.options;
    if (options === undefined || options === null) continue;
    // Match on id, and fall back to the server name, because a hand-edited patch
    // may rename the row but keep `serverName: obsidian`.
    const isTarget =
      options.id === MCP_ENTRY_ID ||
      options.config?.serverName === "obsidian" ||
      options.config?.mcp?.serverName === "obsidian";
    if (!isTarget) continue;
    const args = options.config?.args ?? options.config?.mcp?.args;
    if (args !== undefined) return { args, source: String(options.id ?? MCP_ENTRY_ID) };
  }
  return undefined;
}

/**
 * Build the report once. It is pure reading: safe to call on every request.
 *
 * @param {any} ctx
 */
async function buildReport(ctx) {
  const found = mcpRowArgs(ctx);
  const entry = resolveServerEntry();
  const report = {
    plugin: name,
    server: {
      bundled: entry !== undefined,
      entry,
      cwd: resolveServerCwd(),
      dir: serverRoot,
      maxVaults: MAX_VAULTS,
    },
    vaultConfig: {
      found: found !== undefined,
      row: found?.source,
      args: found === undefined ? [] : found.args,
    },
    vaults: [],
    ok: false,
  };

  if (entry === undefined) {
    report.problem = "内置的 obsidian-mcp 服务端不存在（server/node_modules/obsidian-mcp）。";
    report.fix = "重新安装这个 bundle；内置运行时不应被裁剪。";
    return report;
  }

  if (found === undefined) {
    report.problem = "找不到启动 MCP 服务端的那一行配置（id: obsidian-mcp）。";
    report.fix = "检查 cordis.patch.yml 是否把 obsidian-mcp 那一行包含在打包补丁里。";
    return report;
  }

  const parsed = parseVaultArgs(found.args);
  const inspected = await inspectVaults(parsed.vaults);
  report.vaults = inspected.vaults;
  report.malformed = parsed.malformed;
  report.ok = inspected.ok && parsed.malformed.length === 0 && parsed.vaults.length > 0;

  if (parsed.vaults.length === 0) {
    report.problem = "没有配置任何 --vault 参数。";
    report.fix = "在 cordis.patch.yml 的 args 里加一个 --vault main=<仓库绝对路径>。";
  } else if (parsed.malformed.length > 0) {
    report.problem = `有 ${parsed.malformed.length} 个 --vault 参数格式不对。`;
    report.fix = "每个参数写成 --vault <id>=<绝对路径>。";
  } else if (!inspected.ok) {
    const first = inspected.vaults.find((vault) => vault.ok !== true);
    report.problem = first?.problem ?? "仓库配置未通过校验。";
    report.fix = first?.fix;
  }

  return report;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, undefined, 2);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    /* the socket may already be gone */
  }
}

/**
 * @param {any} ctx cordis context
 */
export function apply(ctx) {
  const log = (message) => {
    for (const method of ["info", "log"]) {
      try {
        const emit = ctx?.logger?.[method];
        if (typeof emit === "function") {
          emit.call(ctx.logger, `dsh-obsidian: ${message}`);
          return;
        }
      } catch {
        /* logging must never throw */
      }
    }
  };

  if (resolveServerEntry() === undefined) {
    log("bundled obsidian-mcp server is missing; the plugin will expose no tools");
  }

  // Validate once at load so a wrong path is reported at startup rather than
  // discovered later, when a model tries to call a tool that does not exist.
  const startup = buildReport(ctx);
  void startup.then((report) => {
    if (report.ok === true) {
      log(`vault config ok: ${report.vaults.filter((vault) => vault.ok === true).map((vault) => vault.id).join(", ")}`);
      return;
    }
    log(`${report.problem ?? "vault config unknown"} ${report.fix ?? ""}`.trim());
  });

  const webServer = ctx?.webServer;
  if (webServer === undefined || typeof webServer.register !== "function") {
    log("no webServer service; health route not registered");
    return;
  }

  const handler = async (req, res) => {
    if (req?.method !== undefined && req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    try {
      sendJson(res, 200, await buildReport(ctx));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: "report failed", message: error?.message ?? String(error) });
    }
  };

  ctx.effect?.(() => webServer.register({ kind: "exact", path: HEALTH_PATH, handler }), `${name}: ${HEALTH_PATH}`);
}
