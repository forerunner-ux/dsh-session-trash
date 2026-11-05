# dsh-session-trash

给 DeepSeek Harness 桌面版加的「会话回收站」：把侧边栏里的会话移出列表（可恢复），并在侧边栏的**回收站**页里查看、恢复或永久删除。

## 功能

- **移入回收站**：会话行「⋯」/ 右键菜单里多一项「移入回收站」。它把 `<DSH_HOME>/sessions/<项目目录>/<会话 id>/` 整个目录移动到 `<DSH_HOME>/trash/sessions/<时间戳>-<会话 id>/`，同时清掉这条会话的摘要缓存；日志文件本身完整保留。
- **空会话也能移入**：有的会话只在侧边栏里出现，`sessions` 下却没有日志目录（新建后没发过消息，或日志被外部删掉/移走）。这类条目没有标题，看上去是「未命名」，以前会被拒绝（`SESSION_NOT_FOUND`）；现在同样能移入回收站——插件把它从工作区的会话登记里摘掉，恢复时再放回原来的位置。回收站面板里这类条目显示为「空会话（无日志）」。
- **回收站面板**：侧边栏图标栏里的垃圾桶图标，打开后列出所有已移入回收站的会话（标题、原目录、大小、移入时间），可逐条「恢复」「彻底删除」，或「清空回收站」（永久删除前需要二次点击确认）。
- **恢复**：把会话目录放回原来的项目目录，再刷新侧边栏即可重新出现；它原来的工作区归属仍然保留。

## 安装（任何桌面端都能装）

插件是纯 JavaScript，没有构建步骤，装完重启即可用；在 DSH 0.2.2-rc.1 上验证过。

```powershell
# 从 GitHub 安装
dsh plugin --profile desktop add git+https://github.com/forerunner-ux/dsh-session-trash.git

# 或从 Gitee 安装（国内访问更快）
dsh plugin --profile desktop add git+https://gitee.com/zpcsgsg/dsh-session-trash.git
```

也可以先克隆再按路径安装，方便改代码：

```powershell
git clone https://github.com/forerunner-ux/dsh-session-trash.git
dsh plugin --profile desktop add .\dsh-session-trash
```

安装后重启 DeepSeek Harness（Host 与浏览器页面都需要重新加载客户端 bundle），侧边栏图标栏会多出垃圾桶图标。

## 卸载

桌面端「设置 → 插件」里关闭并移除 `dsh-session-trash`，或：

```powershell
dsh plugin --profile desktop remove dsh-session-trash
```

移除后回收站里的文件仍在 `<DSH_HOME>\trash\sessions` 下，可手动放回 `sessions\<项目目录>\<会话 id>`。

## 数据位置

| 内容 | 路径 |
|---|---|
| 会话日志 | `<DSH_HOME>\sessions\<项目目录>\<会话 id>\session.vN.jsonl.zstd` |
| 回收站 | `<DSH_HOME>\trash\sessions\<时间戳>-<会话 id>\{meta.json, session\}` |
| 摘要缓存 | `<DSH_HOME>\storages\session_projcache\sessions\<会话 id>.json` |
| 工作区会话登记 | `<DSH_HOME>\storages\workspace.json`（`tables.workspaces[*].sessionIds`） |

`DSH_HOME` 缺省为 `%USERPROFILE%\.dsh`。

## 安全边界

- 正在运行的会话（其 Agent 状态为 `running`）会被拒绝移动，先把会话停下来。
- 移动失败（例如文件仍被占用）会原样返回错误，不会留下半截状态。
- 恢复时若目标位置已存在同名会话目录，会拒绝并提示，不覆盖。
- 移入回收站会同时把会话 id 从工作区登记里摘掉（优先通过 Host 的 `workspace` 存储域在内存与磁盘上一起改，失败才退化为改写 `workspace.json`；退化路径要刷新或重启侧边栏才会消失）。目录移动失败时会回滚登记。
- 插件只做目录移动、工作区登记更新与 JSON 读写，不解析会话内容；永久删除是真正的文件删除，只能用备份或「恢复」之外的途径找回。
- 只有「日志目录 + 工作区登记」都不存在的 id 才会报 `SESSION_NOT_FOUND`；只存在于归档/置顶列表、不属于任何工作区的孤立 id 不在本插件的处理范围内。

## 实现

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半包：注册 `GET/POST /api/session-trash`，负责移动、恢复、清理、列目录，以及工作区会话登记摘除/回写。 |
| `lib/client.js` | 浏览器半包：会话行菜单项、`main` 面板页、`sidebar.panellist` 图标。 |
| `cordis.patch.yml` | bundle 层：插入 `session-trash` 这一行 loader 条目。 |
| `test/test-host.mjs` | Host 半包离线测试：临时 DSH_HOME（含 `workspace.json`）上跑移入/列表/恢复/彻底删除、空会话摘除与回写、存储域路径、错误码。 |
| `test/test-client.mjs` | 浏览器半包离线测试：假 `__ModuleLoader__`/React/ctx，断言菜单、面板、toast、请求体。 |
| `test/test-real-home.mjs` | 真实家目录往返：对指定会话执行 移入回收站 → 列表 → 恢复。 |

Host 从不导入 DSH 内部包，只用 Node 内置模块 + `<DSH_HOME>` 约定路径；需要判断会话是否在跑时读 `ctx.agents`，需要同步侧边栏时借 `ctx.storageDomain.get('workspace')`（没有就直接改 `workspace.json`）。

## 验证记录（本机 2026-11-05，DSH 0.2.2-rc.1）

- 插件以 `link:` 装入 `desktop` profile 并加入 `dsh.profile.bundles`；`plugin_manager` 报告 `application: applied`，Loader 条目 `include:session-trash` 状态 `active`。
- 浏览器实际拉取并编译过 `plugins/??dsh-session-trash/client.js&rev=...`（Chromium JS 代码缓存里 4 个不同 revision）。
- 实机截图确认：侧边栏出现「回收站」图标；面板显示「回收站 / 暂无条目」且无错误提示（说明带 cookie 的 `GET /api/session-trash` 返回成功）；会话行「⋯」菜单出现「移入回收站」（位于「在文件夹显示」与「归档会话」之间，红色）。
- 真实家目录往返：`test-real-home.mjs` 对 `session-dd47732b…`（E:\DS，18 天前）执行 移入回收站 → 列表（标题、cwd、106895 字节）→ 恢复，日志回到原位、回收站条目清空。
- v1.1.0（空会话）：`毕设` 工作区里 `session-53fbd4d5…` 只在 `workspace.json` 有登记、`sessions` 下没有目录，侧边栏因此显示一条没有标题的行，旧版插件对它报 `SESSION_NOT_FOUND`。现在移入/恢复/彻底删除都覆盖这种条目，且普通会话移入时也会同步摘除工作区登记（不再是「目录没了但登记还在」的悬空行）。
- 两个半包的离线测试共 67 项断言全部通过（40 host + 27 client）。

## 运行测试

```powershell
$node = "D:\DeepSeek-Harness-Desktop\deepseek harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node test\test-host.mjs lib\index.js
& $node test\test-client.mjs lib\client.js
& $node test\test-real-home.mjs <会话id> lib\index.js   # 会真的移动该会话，随后自动恢复
```
