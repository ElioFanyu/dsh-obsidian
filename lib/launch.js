/**
 * Resolve the bundled MCP server's entry script.
 *
 * The server is vendored under `server/node_modules/obsidian-mcp`, which means
 * the patch file has to name a path *inside* a package directory. Writing that
 * path as a literal is the fragile part: it breaks when the package is hoisted,
 * when a different workspaces layout installs it, and when the plugin directory
 * moves. So the launch row asks this module for the absolute path at load time
 * instead of hard-coding one.
 *
 * A missing server is reported, not thrown: a plugin whose optional MCP server
 * is absent should leave the rest of the harness running.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Plugin root: the directory that holds `package.json` and `server/`. */
export const pluginRoot = path.dirname(here);

/** The vendored runtime's own package directory. */
export const serverRoot = path.join(pluginRoot, "server");

/**
 * Absolute path to `obsidian-mcp/dist/main.js`, or `undefined` when the
 * vendored runtime is not present.
 *
 * Resolution order matters: the explicit vendored location first (that is what
 * this bundle ships), then the package resolver (a workspace install may hoist
 * it), so a plugin installed either way finds its server.
 *
 * @returns {string | undefined}
 */
export function resolveServerEntry() {
  const vendored = path.join(serverRoot, "node_modules", "obsidian-mcp", "dist", "main.js");
  if (existsSync(vendored)) return vendored;

  try {
    const require = createRequire(path.join(serverRoot, "package.json"));
    return require.resolve("obsidian-mcp/dist/main.js");
  } catch {
    return undefined;
  }
}

/**
 * The directory the server must run from.
 *
 * `command` is DSH's own Node (`process.execPath`), and the entry script is
 * passed relative to this — so it has to be the vendored server root, not the
 * plugin root.
 *
 * @returns {string}
 */
export function resolveServerCwd() {
  return serverRoot;
}

/** Compare two paths the way this Host's filesystem does. */
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  // Windows paths are case-insensitive, so a merely re-cased patch file must
  // not be reported as a different directory.
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Describe how the loader row would actually start the bundled server, and
 * whether that agrees with where this package keeps it.
 *
 * The YAML row states `cwd` and the entry script, and DSH runs the server from
 * exactly those — while this module knows where the package really is. The two
 * can drift apart (the plugin moved, a patch was copied between machines), and
 * the symptom is the one this bundle exists to catch: the tools are simply
 * absent. Comparing them here turns that into a sentence.
 *
 * Nothing is thrown: a malformed row is reported as a mismatch, not as a crash.
 *
 * @param {any} config the MCP row's `config` object
 */
export function describeLaunch(config) {
  const args = Array.isArray(config?.args) ? config.args.map((value) => String(value)) : [];
  const cwd = typeof config?.cwd === "string" ? config.cwd : "";
  const declaredEntry = args[0];
  const expectedCwd = resolveServerCwd();
  const bundledEntry = resolveServerEntry();

  // The SDK resolves a relative entry against `cwd`; an empty `cwd` means "the
  // harness's own working directory", which is never what this bundle wants.
  let absoluteEntry;
  if (typeof declaredEntry === "string" && path.isAbsolute(declaredEntry)) absoluteEntry = declaredEntry;
  else if (typeof declaredEntry === "string" && cwd !== "") absoluteEntry = path.resolve(cwd, declaredEntry);

  const cwdMatchesBundled = cwd !== "" && samePath(cwd, expectedCwd);
  const entryMatchesBundled =
    absoluteEntry !== undefined && bundledEntry !== undefined && samePath(absoluteEntry, bundledEntry);

  return {
    transport: config?.transport,
    command: config?.command,
    cwd,
    expectedCwd,
    declaredEntry,
    absoluteEntry,
    bundledEntry,
    cwdMatchesBundled,
    entryMatchesBundled,
    entryExists: absoluteEntry !== undefined && existsSync(absoluteEntry),
  };
}
