# TaskPulse · 安装说明（macOS）

一个常驻屏幕边缘的窄条，显示你在某个 Agent 会话平台上的任务状态，点一下就能跳到对应标签页。

要求：macOS 13 或更新（Intel / Apple Silicon 都可以）、装有 Microsoft Edge、能访问你的 Agent 平台。
后台取数用 Python 跑，脚本会自动准备（本机有 `uv` 就直接用，没有就装一个）。

---

## 两条安装路径，选一条

### A. 团队内部渠道给的包（零配置，推荐）

包名通常带 `-internal`。解压后**双击 `install.command`**，全程不问任何问题：

- 自动装运行依赖（首次联网约 30 秒）
- 自动写入包内自带的配置
- 自动注册开机自启并拉起小窗

装完小窗会自己出现在屏幕右上角，并弹一个**扩展安装引导**：选 Edge 或 Chrome，
它会替你打开扩展页、把扩展目录递到 Finder，你按提示点两下，「检查一下」通过就完成。

### B. 自己配置

解压后**双击 `install.command`**，脚本会问三个问题：

1. **会话页链接** —— 在浏览器里打开任意一个会话，把地址栏那一整串贴进来。
   脚本从中读出域名和 agentId（链接里没有 agentId 时会再问一次）。
2. **API 前缀** —— 回车用默认 `/api/v1`。
3. **认证方式** —— 「令牌文件」或「不需要认证」。

答完生成 `~/.taskpulse/config.json`，之后所有行为都由这份文件决定。

> Gatekeeper 提示「无法验证开发者」时：右键 `install.command` → 打开 → 再点「打开」。

---

## 装完之后：扩展安装引导

小窗首次启动会弹「TaskPulse 已装好」，选你平时看会话的浏览器：

- **Edge** → 打开 `edge://extensions`
- **Chrome** → 打开 `chrome://extensions`

引导会自动做掉三件小事：打开扩展页、把扩展目录路径复制到剪贴板、
在 Finder 里把 `edge-ext` 文件夹选中，并把引导窗口挪到屏幕右下角让出落点。

你只需要两步：

1. 在浏览器扩展页右上角打开「开发人员模式」。
2. 把 Finder 里选中的 `edge-ext` 拖到扩展页中间的空区域。

> 拖拽不生效的版本，点「加载解压缩的扩展」→ 按 ⌘⇧G 粘贴路径（已复制）→ 回车。

装好之后引导会自己轮询到扩展上报，自动变成「已连接」，不用点任何按钮。
判定按你选的那个浏览器来做——Edge 装了不会被当成 Chrome 也装好了。

想重新走一遍引导：

```bash
defaults delete com.taskpulse.ui onboarded
launchctl kickstart -k gui/$(id -u)/com.taskpulse.ui
```

扩展做两件事：上报目标站点标签页的标题 / 分组名 / 标签 id、执行「切到某个标签」的命令；
另外可选地在页面里用**你自己的登录态**读一次会话状态（见下方「取数来源」）。
它只允许访问 `127.0.0.1` 和你配置的那个站点，不读取页面内容、不外传数据。
站点范围由安装脚本按 `config.json` 里的 `extension.scope` 生成 `edge-ext/config.js` 与
`edge-ext/manifest.json`（仓库里只有中性的 `manifest.template.json`，不含任何域名）。
**所以改完配置要重新运行一次 `install.command`，然后在扩展页点一次 ⟳。**

### 取数来源：API / WEB

展开面板顶部计数行右侧有个 `API` / `WEB` 开关，也可以改 `config.json` 的 `source`：

| 来源 | 怎么取数 | 什么时候选它 |
| --- | --- | --- |
| `api` | 本机用 `auth` 配置直连接口 | 默认。机器上有可用凭据时最省事 |
| `web` | 浏览器里开着的页面用自己的 cookie 取，扩展把结果报给本机 | 本机凭据过期 / 不想配凭据时 |

`web` 模式依赖至少一个目标站点标签页开着（扩展不保活，也不会替你开页面）；
页面关掉后界面会显示「浏览器里的页面没有上报数据」。

> 为什么不做成全自动？macOS 上的 Chromium 只接受商店来源的静默安装
> （本地 crx 的 External Extensions 通道实测不生效），装解压缩目录必须由人点一次。

## 授权与登录

- 第一次点任务行（或右上角提示条）跳转时，系统会弹「TaskPulse 想要控制 Microsoft Edge」，点**允许**。
- 认证沿用你浏览器里已登录的账号，不用另填 token。
  取数失败不会让进程退出，日志会写「取数线程中断」并在 1 分钟后重试，间隔逐步拉长到 30 分钟。

---

## 怎么用

- 窄条上的三个数字：**进行中 / 待我处理 / 卡住**，点任意数字只看那一类（再点一次恢复）。
- 鼠标悬停 → 展开成完整列表；移开 0.15s 后自动收起。
- **点任务行** → 浏览器切到该会话的标签页（不会新开）。
- 行尾的勾选框 = 这个任务处理完了，彻底从列表移除，不再提醒。
- 右上角会弹「Agent 回话了」提示条，**点一下直接跳过去**，15 秒自动消失。
- 双击卡片顶部标题栏 = 展开 / 收起；右上角图钉 = 固定常展开。
- 拖到屏幕边缘松手 = 立即收成窄条。

---

## 配置说明（`~/.taskpulse/config.json`）

脚本生成的是能跑的最小集合，其余字段走内置默认值。想改就改这份文件，改完重启后台：

```bash
launchctl kickstart -k gui/$UID/com.taskpulse.poller
```

| 字段 | 作用 |
|---|---|
| `platform.base_url` | 平台地址，如 `https://agent.example.com` |
| `platform.api_prefix` | 接口前缀，如 `/api/v1` |
| `platform.agent_ids` | 要监视的 agent id 列表 |
| `platform.conversation_url` | 点任务行跳转的地址模板，可用 `{host} {agent} {cid}` |
| `platform.endpoints.conversations` | 会话列表接口 |
| `platform.endpoints.queue` | 队列快照接口，`{cid}` 会被替换成会话 id |
| `platform.endpoints.messages` | 取最后一条消息的接口（只用来识别「限流失败」） |
| `platform.conversations_body` | 会话列表的请求体；值写 `"{agent_ids}"` 会替换成上面的数组 |
| `platform.queue_fields` | 队列返回里哪个字段是状态、哪个是排队数、哪些值算空闲 |
| `platform.messages_list_key` | 消息接口返回里存放消息数组的字段名 |
| `auth.provider` | `none` / `token_file` / `module` |
| `auth.token_file` | `token_file` 时读这个文件的首行当令牌，每次请求重读 |
| `auth.env` | `module` 时在建会话前注入的环境变量（有些 SDK 靠环境变量决定去哪换凭据）；留空即可 |
| `poll.interval_seconds` | 取数间隔，默认 60 |
| `poll.stuck_seconds` | 同一轮跑过多久算「卡住」，默认 1800（30 分钟） |
| `poll.window_limit` | 窄条最多显示几条，默认 10 |
| `poll.watch_limit` | 只对最近更新的 N 个会话查队列，默认 20 |
| `poll.archive_hours` | 已读且 N 小时没有新动作就自动归档，默认 48 |
| `ui.port` | 本地 HTTP 端口，默认 8899 |
| `extension.scope` | 扩展监视的站点，如 `https://agent.example.com/*` |
| `failure_marks` | 命中这些关键词的回复算「被限流打断」，留空则不判定 |

环境变量可临时覆盖，不必改文件：`TP_POLL_SECONDS` / `TP_WATCH_LIMIT` / `TP_ARCHIVE_HOURS` / `TP_PORT`。

想先看看界面长什么样：`uv run ~/Applications/TaskPulse/poller.py --demo`（示例数据，不联网）。

---

## 卸载

双击 `uninstall.command`。
彻底清空历史：`rm -rf ~/.taskpulse`。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 提示「已损坏，无法打开」 | `xattr -dr com.apple.quarantine ~/Applications/TaskPulse.app` |
| 启动就报「TaskPulse 还不能开始工作」 | 按提示补 `~/.taskpulse/config.json`，或重跑 `install.command` |
| 窄条不见了 | `launchctl kickstart -k gui/$UID/com.taskpulse.ui` |
| 数字一直不变 | `curl 127.0.0.1:8899/state` 看 `poller_error`；再看 `~/Library/Logs/taskpulse.log` |
| 点任务不跳转 | 确认扩展已加载；`curl 127.0.0.1:8899/state` 里 `extension.ok` 应为 `true` |
| 引导点了「检查一下」不通过 | 确认扩展在扩展页是「已启用」状态，且浏览器里至少开着一个会话标签 |
| 有两个 TaskPulse 在跑 | 老版本留下的 `com.hyj.taskpulse.*` 标签，卸掉旧的再重跑 `install.command` |
| 想改刷新间隔 | 改 `config.json` 的 `poll.interval_seconds`，或临时 `TP_POLL_SECONDS=30` |
| 想看明细日志 | `~/Library/Logs/taskpulse.log`（行为日志）、`taskpulse.poll.out`（每轮快照） |
