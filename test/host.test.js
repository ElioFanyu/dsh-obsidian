/**
 * Tests for the host half: argument parsing and vault validation.
 *
 * These run on plain Node with no test framework (`node --test test/host.test.js`).
 * Every case builds a throwaway vault on disk, so the checks are exercised the
 * same way the plugin exercises them at startup — including the failures that
 * are the entire reason this code exists.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectVault, inspectVaults, parseVaultArgs, MAX_VAULTS } from "../lib/vaults.js";
import { describeLaunch, resolveServerCwd, resolveServerEntry } from "../lib/launch.js";
import { apply, HEALTH_PATH } from "../lib/index.js";

/** A directory that looks like an initialized Obsidian vault. */
async function makeVault() {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-obsidian-"));
  await mkdir(path.join(dir, ".obsidian"), { recursive: true });
  return dir;
}

test("parseVaultArgs reads both --vault spellings", () => {
  const parsed = parseVaultArgs(["serve", "--vault", "main=/a/b", "--vault=notes=/c/d"]);
  assert.deepEqual(parsed.vaults, [
    { id: "main", root: "/a/b" },
    { id: "notes", root: "/c/d" },
  ]);
  assert.deepEqual(parsed.malformed, []);
});

test("parseVaultArgs reports malformed definitions instead of dropping them", () => {
  const parsed = parseVaultArgs(["serve", "--vault", "novalue", "--vault", "= /x", "--vault"]);
  assert.deepEqual(parsed.vaults, []);
  assert.equal(parsed.malformed.length, 3);
});

test("parseVaultArgs tolerates a non-array", () => {
  assert.deepEqual(parseVaultArgs(undefined), { vaults: [], malformed: [] });
});

test("a real vault passes", async () => {
  const dir = await makeVault();
  try {
    const result = await inspectVault({ id: "main", root: dir });
    assert.equal(result.ok, true);
    assert.equal(result.id, "main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory with no .obsidian is rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-obsidian-plain-"));
  try {
    const result = await inspectVault({ id: "main", root: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "VAULT_NOT_INITIALIZED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an id that is not lowercase-safe is rejected before touching the disk", async () => {
  const result = await inspectVault({ id: "Main Vault", root: "/nonexistent" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_VAULT_ID");
});

test("a relative path is rejected", async () => {
  const result = await inspectVault({ id: "main", root: "vaults/main" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "VAULT_PATH_NOT_ABSOLUTE");
});

test("a missing path is reported as not found", async () => {
  const result = await inspectVault({ id: "main", root: path.join(tmpdir(), "dsh-obsidian-absent", "vault") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "VAULT_PATH_NOT_FOUND");
});

test("a file is not a vault", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-obsidian-file-"));
  const file = path.join(dir, "note.md");
  await writeFile(file, "# note\n");
  try {
    const result = await inspectVault({ id: "main", root: file });
    assert.equal(result.ok, false);
    assert.equal(result.code, "VAULT_PATH_NOT_DIRECTORY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a duplicate id is rejected", async () => {
  const dir = await makeVault();
  try {
    const result = await inspectVault({ id: "main", root: dir }, ["main"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "DUPLICATE_VAULT_ID");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nested vault roots are rejected", async () => {
  const outer = await makeVault();
  const inner = path.join(outer, "inner");
  await mkdir(path.join(inner, ".obsidian"), { recursive: true });
  try {
    const report = await inspectVaults([
      { id: "outer", root: outer },
      { id: "inner", root: inner },
    ]);
    assert.equal(report.ok, false);
    assert.ok(report.vaults.some((vault) => vault.code === "VAULT_ROOTS_OVERLAP"));
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("two independent vaults pass", async () => {
  const first = await makeVault();
  const second = await makeVault();
  try {
    const report = await inspectVaults([
      { id: "first", root: first },
      { id: "second", root: second },
    ]);
    assert.equal(report.ok, true);
    assert.equal(report.vaults.length, 2);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("more vaults than the server allows is reported", async () => {
  const definitions = Array.from({ length: MAX_VAULTS + 1 }, (_, index) => ({
    id: `vault${index}`,
    root: path.join(tmpdir(), `dsh-obsidian-many-${index}`),
  }));
  const report = await inspectVaults(definitions);
  assert.equal(report.ok, false);
  assert.ok(report.vaults.some((vault) => vault.code === "TOO_MANY_VAULTS"));
});

test("the bundled server entry is found and the cwd is its package root", () => {
  const entry = resolveServerEntry();
  assert.ok(typeof entry === "string" && entry.endsWith(path.join("obsidian-mcp", "dist", "main.js")), `entry: ${entry}`);
  assert.equal(path.basename(resolveServerCwd()), "server");
});

test("describeLaunch agrees with the row this bundle ships", () => {
  const config = {
    transport: "stdio",
    cwd: resolveServerCwd(),
    args: ["node_modules/obsidian-mcp/dist/main.js", "serve", "--vault", "main=D:/Workspace/Obsidian"],
  };
  const launch = describeLaunch(config);
  assert.equal(launch.cwdMatchesBundled, true);
  assert.equal(launch.entryMatchesBundled, true);
  assert.equal(launch.entryExists, true);
  assert.equal(launch.absoluteEntry, resolveServerEntry());
});

test("describeLaunch reports a row that points somewhere else", () => {
  const elsewhere = describeLaunch({
    transport: "stdio",
    cwd: path.join(tmpdir(), "some-other-server"),
    args: ["node_modules/obsidian-mcp/dist/main.js"],
  });
  assert.equal(elsewhere.cwdMatchesBundled, false);
  assert.equal(elsewhere.entryMatchesBundled, false);

  const wrongEntry = describeLaunch({
    transport: "stdio",
    cwd: resolveServerCwd(),
    args: ["dist/main.js"],
  });
  assert.equal(wrongEntry.cwdMatchesBundled, true);
  assert.equal(wrongEntry.entryMatchesBundled, false);
});

test("describeLaunch tolerates a row with no launch fields", () => {
  const launch = describeLaunch(undefined);
  assert.equal(launch.cwdMatchesBundled, false);
  assert.equal(launch.entryMatchesBundled, false);
  assert.equal(launch.entryExists, false);
});

/** The args a correct row passes: the bundled entry script first. */
function mcpArgs(...tail) {
  return ["node_modules/obsidian-mcp/dist/main.js", ...tail];
}

/** A cordis context stub with just what `apply` touches. */
function fakeContext({ args, config } = {}) {
  const registered = [];
  const logs = [];
  const ctx = {
    logger: { info: (message) => logs.push(String(message)) },
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    effect(factory, tag) {
      ctx.effectTags.push(tag);
      return factory();
    },
    effectTags: [],
    loader: {
      *entries() {
        yield {
          options: {
            id: "obsidian-mcp",
            config: config ?? { serverName: "obsidian", cwd: resolveServerCwd(), args },
          },
        };
      },
    },
  };
  return { ctx, registered, logs };
}

/** Call the registered route with a minimal req/res pair. */
function invoke(route) {
  return new Promise((resolve) => {
    let status = 0;
    let body = "";
    const res = {
      writeHead(code) {
        status = code;
      },
      end(chunk) {
        body += chunk ?? "";
        resolve({ status, body: JSON.parse(body) });
      },
    };
    const result = route.handler({ method: "GET" }, res);
    if (result !== undefined) result.catch((error) => resolve({ status: -1, body: { error: String(error) } }));
  });
}

test("apply registers exactly one health route and reports a good vault", async () => {
  const dir = await makeVault();
  try {
    const { ctx, registered } = fakeContext({ args: mcpArgs("serve", "--vault", `main=${dir}`) });
    apply(ctx);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].path, HEALTH_PATH);

    const { status, body } = await invoke(registered[0]);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.vaults[0].id, "main");
    assert.equal(body.vaultConfig.found, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the health route explains a wrong vault instead of hiding it", async () => {
  const { ctx, registered } = fakeContext({
    args: mcpArgs("serve", "--vault", `main=${path.join(tmpdir(), "dsh-obsidian-missing", "vault")}`),
  });
  apply(ctx);
  const { status, body } = await invoke(registered[0]);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.vaults[0].code, "VAULT_PATH_NOT_FOUND");
  assert.match(body.problem, /不存在/u);
  assert.ok(typeof body.fix === "string" && body.fix !== "");
});

test("the health route rejects non-GET methods", async () => {
  const { ctx, registered } = fakeContext({ args: mcpArgs("serve", "--vault", "main=D:/Workspace/Obsidian") });
  apply(ctx);
  const { status, body } = await new Promise((resolve) => {
    const res = {
      writeHead(code) {
        resolve({ status: code, body: undefined });
      },
      end(chunk) {
        resolve({ status: 0, body: JSON.parse(chunk) });
      },
    };
    registered[0].handler({ method: "POST" }, res);
  });
  assert.equal(status, 405);
  void body;
});

test("apply survives a context with no web server", () => {
  const logs = [];
  const ctx = { logger: { info: (message) => logs.push(String(message)) } };
  assert.doesNotThrow(() => apply(ctx));
  assert.ok(logs.some((line) => line.includes("health route not registered")));
});

test("a context that throws on a missing service does not break apply", () => {
  // Cordis resolves services through a proxy: reading an absent one throws
  // instead of yielding undefined. `apply` must still report, not crash.
  const logs = [];
  const ctx = new Proxy(
    { logger: { info: (message) => logs.push(String(message)) }, effect: (factory) => factory() },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );
  assert.doesNotThrow(() => apply(ctx));
  assert.ok(logs.some((line) => line.includes("health route not registered")));
});

test("the health route reports a row that starts the wrong server", async () => {
  const { ctx, registered } = fakeContext({
    config: {
      serverName: "obsidian",
      cwd: path.join(tmpdir(), "dsh-obsidian-elsewhere"),
      args: ["node_modules/obsidian-mcp/dist/main.js", "serve", "--vault", "main=D:/Workspace/Obsidian"],
    },
  });
  apply(ctx);
  const { status, body } = await invoke(registered[0]);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.launch.cwdMatchesBundled, false);
  assert.match(body.problem, /cwd/u);
  // The vault itself would pass; the row is what is wrong.
  assert.deepEqual(body.vaults, []);
});

test("the health route reads a nested config.mcp row", async () => {
  const dir = await makeVault();
  try {
    const { ctx, registered } = fakeContext({
      config: {
        mcp: { serverName: "obsidian", cwd: resolveServerCwd(), args: ["node_modules/obsidian-mcp/dist/main.js", "serve", "--vault", `main=${dir}`] },
      },
    });
    apply(ctx);
    const { body } = await invoke(registered[0]);
    assert.equal(body.vaultConfig.found, true);
    assert.equal(body.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
