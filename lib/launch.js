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
