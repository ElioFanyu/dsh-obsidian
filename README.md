# dsh-obsidian

一个把本机 Obsidian 仓库通过 MCP 接入 DSH 的单一插件包。

它取代了原来的双目录方案（`dsh-obsidian-mcp` + 独立的 `obsidian-mcp-runtime` 安装目录）。
MCP 服务端现在内置在本包中，安装这一个 bundle 即可，无需额外步骤。

## 它做什么

DSH 以 stdio 方式启动 `obsidian-mcp` 2.0.1 作为 MCP 服务端，并把它的工具以
`mcp__obsidian__<tool>` 的形式暴露给模型：

| 工具 | 作用 |
| --- | --- |
| `obsidian_list_vaults` | 列出已配置的仓库 id |
| `obsidian_read_note` | 分页读取笔记，返回 SHA-256 `etag` |
| `obsidian_create_note` | 原子创建笔记，绝不覆盖已有文件 |
| `obsidian_edit_note` | 追加、前插或精确替换内容 |
| `obsidian_delete_note` | 移入 MCP 回收站，或经确认后永久删除 |
| `obsidian_move_note` | 移动/重命名，并更新无歧义的反向链接 |
| `obsidian_create_directory` | 事务式创建目录 |
| `obsidian_search_vault` | 搜索内容、文件名或标签 |
| `obsidian_add_tags` / `obsidian_remove_tags` / `obsidian_rename_tag` / `obsidian_manage_tags` | 标签操作 |

服务端直接读写磁盘上的 Markdown 文件，因此 Obsidian 本体不需要处于运行状态。

### 宿主侧：vault 配置自检

工具在模型看来只有两种状态：在，或者不在。配置写错时（路径打错、目录还不是仓库、
两个仓库互相嵌套）服务端会在子进程里失败，你看到的现象只是「`mcp__obsidian__` 这些工具不见了」。

本包的 `lib/` 补上这一段：插件加载时读取 MCP 那一行真实的 `--vault` 参数，
用与服务端相同的规则校验一遍，并把结果发布在一个只读路由上：

```
<DSH 地址>/plugins/dsh-obsidian/health
# 例如 http://127.0.0.1:1235/plugins/dsh-obsidian/health
```

```jsonc
{
  "ok": false,
  "vaultConfig": { "found": true, "row": "obsidian-mcp", "args": ["node_modules/obsidian-mcp/dist/main.js", "serve", "--vault", "main=D:/Workspace/Obsidian"] },
  "vaults": [
    {
      "ok": false,
      "code": "VAULT_NOT_INITIALIZED",
      "problem": "仓库「main」里没有 .obsidian 目录：D:/Workspace/Obsidian",
      "fix": "先用 Obsidian 把这个目录打开为一个仓库，等它初始化完成"
    }
  ],
  "problem": "仓库「main」里没有 .obsidian 目录：D:/Workspace/Obsidian",
  "fix": "先用 Obsidian 把这个目录打开为一个仓库，等它初始化完成"
}
```

校验的错误码与服务端一致（`VAULT_PATH_NOT_FOUND`、`VAULT_NOT_INITIALIZED`、
`VAULT_ROOTS_OVERLAP`、`DUPLICATE_VAULT_ID` 等），所以报告里的原因就是服务端会给出的原因。
路由只读、只用 GET、不写仓库、不额外开端口——它挂在 DSH 已有的 web 服务上。

## 目录结构

```
dsh-obsidian/
  package.json          bundle 清单（dsh.bundle.patch）
  cordis.patch.yml      插入 obsidian-mcp（MCP 服务端）与 dsh-obsidian（宿主侧自检）
  lib/
    index.js            宿主入口：加载时自检 + 健康路由
    vaults.js           --vault 解析与校验（规则与服务端一致）
    launch.js           定位内置服务端入口
  test/host.test.js     校验与路由的测试（node --test）
  icon.svg
  locale/{en,zh}.json
  server/
    package.json        内置运行时的清单
    package-lock.json
    node_modules/       obsidian-mcp 2.0.1 及其依赖（18 MB）
```

`server/` 采用内置方式（vendored），因此本包是自包含的：启动时不访问网络，
也不需要额外维护一个运行时目录。

## 配置

编辑 `cordis.patch.yml`：

```yaml
- insert:
    - id: obsidian-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: obsidian
        transport: stdio
        command: !!js process.execPath
        cwd: D:/Workspace/DeepSeek Harness/dsh-obsidian/server
        args:
          - node_modules/obsidian-mcp/dist/main.js
          - serve
          - --vault
          - main=D:/Workspace/Obsidian
    - id: dsh-obsidian
      name: dsh-obsidian
```

- **仓库** —— 修改 `main=D:/Workspace/Obsidian` 这一项参数。使用正斜杠和绝对路径；
  该仓库必须已包含 `.obsidian` 目录。
- **多仓库** —— 追加更多 `--vault <id>=<绝对路径>` 参数（最多十个）。
  仓库 id 只能用小写字母、数字、`_`、`-`，且必须以字母开头。
  两个仓库不能相同或互相嵌套。
- **`command`** —— `!!js process.execPath` 表示用 DSH 自带的 Node 运行服务端，
  这里是 24.x，满足 obsidian-mcp 对 Node ≥ 22 的要求。
- **`cwd`** —— 内置的服务端目录。如果移动了插件位置，需要同步修改此项；
  `args` 里的入口脚本是相对它解析的。
- **`failOnStartupError`** —— 设为 `true` 时，若仓库或服务端无法启动，DSH 会直接
  报错失败。若你希望仓库不可用时仍能启动 DSH（只是没有 Obsidian 工具），
  将其改为 `false`。

修改后重启 DSH 生效；改完先看一眼 `/plugins/dsh-obsidian/health`，比翻日志快。

## 安全行为

- 仓库访问在进程启动时即被白名单限定。
- 所有路径均为仓库相对路径，逐段校验，并禁止符号链接。
- 写操作带日志、按 etag 做冲突检测（冲突返回 `REVISION_CONFLICT`），
  并作为一个事务整体回滚。
- 默认删除是移入仓库内的 `.obsidian-mcp/trash`。
- 健康路由只读，不接受写入、不返回笔记内容，只返回配置与校验结果。
- 服务端从不监听网络端口，也不发送任何遥测。

## 测试

```bash
npm test
```

测试覆盖 `--vault` 解析、各条校验规则（不存在的路径、非目录、未初始化的目录、
重复 id、嵌套仓库、超过十个仓库）以及健康路由的三种响应。

## 事务恢复

事务记录位于 `<仓库>/.obsidian-mcp/transactions`，默认保留 30 天、上限 1 GiB。
在 MCP 服务端已停止的情况下：

```bash
node server/node_modules/obsidian-mcp/dist/main.js recovery list --vault main=D:/Workspace/Obsidian
node server/node_modules/obsidian-mcp/dist/main.js recovery restore --vault main=D:/Workspace/Obsidian --id <transaction-id>
```

## 故障排查

脱离 DSH 单独检查仓库配置是否可用：

```bash
npm run doctor
# 等价于
node server/node_modules/obsidian-mcp/dist/main.js doctor --vault main=D:/Workspace/Obsidian
```

仓库正常时会返回 `"ok": true`，且 `readable` 与 `writable` 均为 true。

## 许可证

本 bundle 的元数据归你所有。内置的 `obsidian-mcp` 为 MIT 许可，版权归其作者；
`@modelcontextprotocol/*`、`zod`、`yaml` 各自保留其许可，位于
`server/node_modules/` 下。
