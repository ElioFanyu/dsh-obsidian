/**
 * Vault definition parsing and pre-flight validation.
 *
 * The MCP server (`obsidian-mcp`) already validates its `--vault` arguments at
 * startup, but it does it inside a child process whose only output is one line
 * on stderr. That is a poor place to discover that a path is wrong: by then the
 * plugin looks installed, the tools are simply missing, and the cause is three
 * lines up in a log.
 *
 * So this module repeats the same checks in the host process, before or beside
 * the child, and reports them where a person can see them. The rules mirror
 * `obsidian-mcp/dist/utils/vault.js` deliberately — the point is to agree with
 * the server, not to invent a second policy. If the upstream rules change, this
 * file has to change with them; the codes are the server's on purpose.
 */

import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Same grammar the server enforces: a letter, then up to 63 lowercase-safe chars. */
const VAULT_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

/** The server refuses more than this; catching it here gives a better message. */
export const MAX_VAULTS = 10;

/**
 * Parse `--vault <id>=<path>` pairs out of an MCP `args` array.
 *
 * Returns every pair plus the malformed ones rather than throwing: a submission
 * or a hand-edited patch file may contain `--vault` with no value, and the
 * useful answer is "this specific argument is wrong", not silence.
 *
 * @param {unknown} args
 * @returns {{ vaults: Array<{ id: string, root: string }>, malformed: string[] }}
 */
export function parseVaultArgs(args) {
  const list = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const vaults = [];
  const malformed = [];
  for (let index = 0; index < list.length; index += 1) {
    // `--vault x` and `--vault=x` are both accepted by the server's parser.
    let value;
    if (list[index] === "--vault") {
      value = list[index + 1];
      index += 1;
    } else if (list[index].startsWith("--vault=")) {
      value = list[index].slice("--vault=".length);
    } else {
      continue;
    }
    if (typeof value !== "string") {
      malformed.push(`--vault 缺少值`);
      continue;
    }
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      malformed.push(`--vault ${value} 不是 <id>=<绝对路径> 形式`);
      continue;
    }
    vaults.push({ id: value.slice(0, separator), root: value.slice(separator + 1) });
  }
  return { vaults, malformed };
}

/**
 * Check one vault the way the server will.
 *
 * `ok: false` carries a machine-readable `code` (the server's own diagnostic
 * code where one exists) and a sentence a person can act on.
 *
 * @param {{ id: string, root: string }} definition
 * @param {string[]} taken ids already claimed by earlier definitions
 */
export async function inspectVault(definition, taken = []) {
  const { id, root } = definition;
  if (!VAULT_ID.test(id)) {
    return {
      ok: false,
      code: "INVALID_VAULT_ID",
      problem: `仓库 id「${id}」不合法`,
      fix: "用 1-64 个小写字母、数字、下划线或连字符，并以字母开头",
    };
  }
  if (taken.includes(id)) {
    return { ok: false, code: "DUPLICATE_VAULT_ID", problem: `仓库 id「${id}」重复`, fix: `改名，例如 ${id}-2` };
  }
  if (!path.isAbsolute(root)) {
    return {
      ok: false,
      code: "VAULT_PATH_NOT_ABSOLUTE",
      problem: `仓库「${id}」的路径不是绝对路径：${root}`,
      fix: `改成绝对路径，例如 ${path.resolve(root)}`,
    };
  }

  let resolved;
  try {
    resolved = await realpath(root);
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return {
      ok: false,
      code: missing ? "VAULT_PATH_NOT_FOUND" : "VAULT_PATH_UNREADABLE",
      problem: missing ? `仓库「${id}」的路径不存在：${root}` : `仓库「${id}」的路径无法解析：${root}`,
      fix: missing ? "修正 cordis.patch.yml 里的 --vault 路径" : "检查目录权限后重启 DSH",
    };
  }

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return { ok: false, code: "VAULT_PATH_UNREADABLE", problem: `仓库「${id}」无法读取：${resolved}`, fix: "检查目录权限后重启 DSH" };
  }
  if (!info.isDirectory()) {
    return {
      ok: false,
      code: "VAULT_PATH_NOT_DIRECTORY",
      problem: `仓库「${id}」指向的是文件而不是目录`,
      fix: "指向 Obsidian 仓库目录本身，而不是里面的某个文件",
    };
  }

  // A directory only counts as a vault once Obsidian has initialized it. Without
  // this check the server starts and every write lands in a folder Obsidian will
  // never open.
  try {
    const marker = await stat(path.join(resolved, ".obsidian"));
    if (!marker.isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ok: false,
      code: "VAULT_NOT_INITIALIZED",
      problem: `仓库「${id}」里没有 .obsidian 目录：${resolved}`,
      fix: "先用 Obsidian 把这个目录打开为一个仓库，等它初始化完成",
    };
  }

  try {
    await access(resolved, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return {
      ok: false,
      code: "VAULT_PERMISSION_DENIED",
      problem: `仓库「${id}」不可读写：${resolved}`,
      fix: "给 DSH 进程读写这个目录的权限",
    };
  }

  return { ok: true, id, root: resolved };
}

/** One root nested inside another makes the same note reachable under two ids. */
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Validate a whole `--vault` set, including the cross-definition rules.
 *
 * @param {Array<{ id: string, root: string }>} definitions
 */
export async function inspectVaults(definitions) {
  const results = [];
  const taken = [];
  for (const definition of definitions) {
    const result = await inspectVault(definition, taken);
    results.push(result);
    if (result.ok === true) taken.push(result.id);
  }

  if (results.length > MAX_VAULTS) {
    results.push({
      ok: false,
      code: "TOO_MANY_VAULTS",
      problem: `配置了 ${results.length} 个仓库，上限是 ${MAX_VAULTS}`,
      fix: "删掉不需要的 --vault 参数",
    });
  }

  // Overlap can only be judged between roots that resolved successfully.
  const roots = results.filter((result) => result.ok === true);
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left];
      const b = roots[right];
      if (a === undefined || b === undefined) continue;
      if (contains(a.root, b.root) || contains(b.root, a.root)) {
        results.push({
          ok: false,
          code: "VAULT_ROOTS_OVERLAP",
          problem: `仓库「${a.id}」与「${b.id}」的路径互相重叠或相同`,
          fix: "去掉其中一个 --vault，或改用两个互不包含的目录",
        });
      }
    }
  }

  return {
    ok: results.every((result) => result.ok === true),
    vaults: results,
  };
}
