/**
 * Host half of `dsh-obsidian`.
 *
 * The plugin's actual work happens in a child process: DSH starts the vendored
 * `obsidian-mcp` server over stdio and the model sees its tools as
 * `mcp__obsidian__*`. That half is somebody else's code, and it is deliberately
 * not touched here.
 *
 * What this file adds is the part the bundle was missing: when the configured
 * vault is wrong — or when the MCP row no longer points at the server this
 * package ships — the failure currently shows up as tools that simply are not
 * there. So the host half
 *
 *   1. reads the `--vault` arguments of the MCP row it launched alongside,
 *   2. checks that the row still starts the bundled server, from the bundled
 *      directory, and
 *   3. publishes the result on a read-only route, so "why is `mcp__obsidian__…`
 *      missing?" has an answer that does not require reading a log.
 *
 * It registers no tools, writes nothing to the vault, and opens no socket of its
 * own: removing the plugin removes every trace of it.
 *
 * @module dsh-obsidian
 */

import { parseVaultArgs, inspectVaults, MAX_VAULTS } from "./vaults.js";
import { describeLaunch, resolveServerEntry, resolveServerCwd, serverRoot } from "./launch.js";

export const name = "dsh-obsidian";

/**
 * The health route needs the web server, and Cordis starts this plugin only once
 * every declared service is present. That is the contract DSH 0.2.x still uses
 * (`inject` is a list of required services; there is no "optional" spelling), so
 * a profile without a web server — headless, ACP, the SDK surfaces — leaves this
 * plugin inactive instead of loading it with a dangling route. Those surfaces
 * have no route to publish to, so nothing is lost.
 */
export const inject = ["webServer"];

/** Where the report lives. Namespaced so it cannot collide with the harness. */
export const HEALTH_PATH = "/plugins/dsh-obsidian/health";

/** The loader row id this plugin reads its own launch arguments from. */
const MCP_ENTRY_ID = "obsidian-mcp";

/** The MCP server name this bundle configures. */
const MCP_SERVER_NAME = "obsidian";

/**
 * Pick the MCP config object out of one loader entry.
 *
 * A hand-edited patch may keep `serverName: obsidian` under `config.mcp` instead
 * of directly under `config`, so both shapes are accepted. Returning the nested
 * object keeps `args`/`cwd` reads in one place.
 */
function mcpConfigOf(options) {
  const config = options?.config;
  if (config === undefined || config === null) return undefined;
  return config.mcp ?? config;
}

/**
 * Find the MCP row: its `--vault` arguments plus the launch fields that decide
 * whether the server this package ships is the one that actually runs.
 *
 * The row is read from the loader rather than duplicated in this plugin's own
 * config: one place states the vault, and a validator that can disagree with the
 * thing it validates is worse than none.
 *
 * @param {any} ctx
 * @returns {{ id: string, config: any } | undefined}
 */
function mcpRow(ctx) {
  let loader;
  try {
    // `loader` is a service, so an absent one throws instead of being undefined.
    loader = ctx?.loader ?? ctx?.get?.("loader");
  } catch {
    try {
      loader = ctx?.get?.("loader");
    } catch {
      return undefined;
    }
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
    const config = mcpConfigOf(options);
    if (config === undefined) continue;
    // Match on id, and fall back to the server name, because a hand-edited patch
    // may rename the row but keep `serverName: obsidian`.
    const isTarget = options.id === MCP_ENTRY_ID || config.serverName === MCP_SERVER_NAME;
    if (!isTarget) continue;
    return { id: String(options.id ?? MCP_ENTRY_ID), config };
  }
  return undefined;
}

/**
 * Build the report once. It is pure reading: safe to call on every request.
 *
 * @param {any} ctx
 */
async function buildReport(ctx) {
  const row = mcpRow(ctx);
  const entry = resolveServerEntry();
  const launch = describeLaunch(row?.config);

  const report = {
    plugin: name,
    server: {
      bundled: entry !== undefined,
      entry,
      cwd: resolveServerCwd(),
      dir: serverRoot,
      maxVaults: MAX_VAULTS,
    },
    launch,
    vaultConfig: {
      found: row !== undefined,
      row: row?.id,
      args: row === undefined ? [] : (row.config?.args ?? []),
    },
    vaults: [],
    ok: false,
  };

  if (entry === undefined) {
    report.problem = "内置的 obsidian-mcp 服务端不存在（server/node_modules/obsidian-mcp）。";
    report.fix = "重新安装这个 bundle；内置运行时不应被裁剪。";
    return report;
  }

  if (row === undefined) {
    report.problem = "找不到启动 MCP 服务端的那一行配置（id: obsidian-mcp）。";
    report.fix = "检查 cordis.patch.yml 是否把 obsidian-mcp 那一行包含在打包补丁里。";
    return report;
  }

  // A row that starts some other copy of the server is not a vault problem, and
  // must not be reported as one: the vault checks below would pass while the
  // model still sees no tools.
  if (!launch.cwdMatchesBundled) {
    report.problem = `MCP 那一行的 cwd 不是内置服务端目录：${launch.cwd === "" ? "(未设置)" : launch.cwd}`;
    report.fix = `把 cordis.patch.yml 里的 cwd 改成 ${launch.expectedCwd}`;
    return report;
  }
  if (!launch.entryMatchesBundled) {
    report.problem = `MCP 那一行启动的不是内置服务端入口：${launch.declaredEntry ?? "(未设置)"}`;
    report.fix = "args 的第一项应为 node_modules/obsidian-mcp/dist/main.js";
    return report;
  }

  const parsed = parseVaultArgs(row.config?.args);
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

  // Reading a missing service through the Cordis context throws rather than
  // returning undefined, so the lookup is guarded instead of optional-chained.
  let webServer;
  try {
    webServer = ctx?.webServer;
  } catch {
    webServer = undefined;
  }
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

  // `register` returns the disposer that removes the route, so handing it to
  // `ctx.effect` ties the route to this plugin's lifetime — an HMR reload or a
  // disable now drops it instead of failing later on a duplicate-path error.
  const route = { kind: "exact", path: HEALTH_PATH, handler };
  if (typeof ctx.effect === "function") ctx.effect(() => webServer.register(route), `${name}: ${HEALTH_PATH}`);
  else webServer.register(route);
}
