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
 * ## Failure policy: this plugin must never be able to stop DSH
 *
 * A diagnostic add-on is not worth a dead harness, and DSH makes that failure
 * mode unusually sharp: `installFailLoud` turns any unhandled rejection or
 * uncaught exception into `exit(1)` ("fatal load failure"), and `apply()` runs
 * inside the loader's startup path. A single stray property read here once took
 * the whole desktop host down on every launch.
 *
 * So the rules below are deliberate and not defensive noise:
 *
 *   - reading an absent service from a Cordis context **throws** rather than
 *     yielding `undefined`, so every service lookup goes through {@link serviceOf};
 *   - `buildReport` catches its own failures and returns a report describing the
 *     failure, instead of rejecting;
 *   - the startup check attaches a rejection handler, because a floating
 *     promise is exactly what `installFailLoud` waits to kill the process over;
 *   - `apply` itself never throws.
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
 * Read a service without letting an absent one become an exception.
 *
 * `ctx.<service>` is a proxy `get` trap that throws for unknown names, and
 * `ctx.get(name)` returns `undefined` for absent services without throwing. Both
 * are tried: the first keeps the normal path cheap and honours any per-context
 * override, the second is the one that cannot fail.
 *
 * @param {any} ctx
 * @param {string} serviceName
 */
function serviceOf(ctx, serviceName) {
  try {
    const direct = ctx?.[serviceName];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* absent or inactive: fall through to the non-throwing lookup */
  }
  try {
    const viaGet = ctx?.get?.(serviceName);
    return viaGet ?? undefined;
  } catch {
    return undefined;
  }
}

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
  const loader = serviceOf(ctx, "loader");
  if (loader === undefined || loader === null) return undefined;

  let entries;
  try {
    entries = typeof loader.entries === "function" ? [...loader.entries()] : [];
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    let options;
    try {
      options = entry?.options;
      if (options === undefined || options === null) continue;
    } catch {
      continue;
    }
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
 * Never rejects. A failure inside the diagnosis is reported *as* a diagnosis,
 * because a rejected `buildReport` would either surface as a 500 on the route or
 * — worse, when called from `apply` — as an unhandled rejection that ends the
 * harness.
 *
 * @param {any} ctx
 */
async function buildReport(ctx) {
  const report = {
    plugin: name,
    server: undefined,
    launch: undefined,
    vaultConfig: { found: false, row: undefined, args: [] },
    vaults: [],
    ok: false,
  };

  try {
    const row = mcpRow(ctx);
    const entry = resolveServerEntry();
    const launch = describeLaunch(row?.config);

    report.server = {
      bundled: entry !== undefined,
      entry,
      cwd: resolveServerCwd(),
      dir: serverRoot,
      maxVaults: MAX_VAULTS,
    };
    report.launch = launch;
    report.vaultConfig = {
      found: row !== undefined,
      row: row?.id,
      args: row === undefined ? [] : (row.config?.args ?? []),
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
  } catch (error) {
    // Reaching here means this plugin is wrong, not the user's configuration.
    // Say so plainly instead of dying, and keep whatever was gathered.
    report.ok = false;
    report.internalError = error?.message ?? String(error);
    report.problem = `自检本身失败了：${report.internalError}`;
    report.fix = "这通常是插件与当前 DSH 版本不匹配，请更新 dsh-obsidian。";
    return report;
  }
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

  // Validate once at load so a wrong path is reported at startup rather than
  // discovered later, when a model tries to call a tool that does not exist.
  //
  // The `.catch` is load-bearing, not tidiness: an unhandled rejection here is
  // what turns a broken diagnostic into a harness that will not start.
  try {
    buildReport(ctx)
      .then((report) => {
        try {
          if (report.ok === true) {
            const ids = report.vaults.filter((vault) => vault.ok === true).map((vault) => vault.id);
            log(`vault config ok: ${ids.join(", ")}`);
            return;
          }
          log(`${report.problem ?? "vault config unknown"} ${report.fix ?? ""}`.trim());
        } catch {
          /* reporting must never throw */
        }
      })
      .catch((error) => {
        try {
          log(`self-check failed: ${error?.message ?? String(error)}`);
        } catch {
          /* reporting must never throw */
        }
      });
  } catch (error) {
    try {
      log(`self-check failed: ${error?.message ?? String(error)}`);
    } catch {
      /* reporting must never throw */
    }
  }

  if (resolveServerEntry() === undefined) {
    log("bundled obsidian-mcp server is missing; the plugin will expose no tools");
  }

  const webServer = serviceOf(ctx, "webServer");
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
  try {
    if (typeof ctx.effect === "function") ctx.effect(() => webServer.register(route), `${name}: ${HEALTH_PATH}`);
    else webServer.register(route);
  } catch (error) {
    // A duplicate path means another copy of this plugin already owns the route.
    // That is worth a line in the log, never a failed activation.
    log(`health route not registered: ${error?.message ?? String(error)}`);
  }
}
