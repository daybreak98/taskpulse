# TaskPulse · 安装说明（macOS）

一个常驻屏幕边缘的窄条，显示你在某个 Agent 会话平台上的任务状态，点一下就能跳到对应标签页。

要求：macOS 13 或更新（Intel / Apple Silicon 都可以）、装有 Microsoft Edge、能访问你的 Agent 平台。
后台取数用 Python 跑，脚本会自动准备（本机有 `uv` 就直接用，没有就装一个）。

---

## 两条安装路径，选一条

### A. 团队内部渠道给的包（零配置）

包名通常带 `-internal`。解压后**双击 `install.command`**，脚本检测到包里已带配置就直接沿用，不再问任何问题。

### B. 自己配置

解压后**双击 `install.command`**，脚本会问三个问题：

1. **会话页链接** —— 在浏览器里打开任意一个会话，把地址栏那一整串贴进来。
   脚本从中读出域名和 agentId（链接里没有 agentId 时会再问一次）。
2. **API 前缀** —— 回车用默认 `/api/v1`。
3. **认证方式** —— 「令牌文件」或「不需要认证」。

答完生成 `~/.taskpulse/config.json`，之后所有行为都由这份文件决定。

> Gatekeeper 提示「无法验证开发者」时：右键 `install.command` → 打开 → 再点「打开」。

装好后 Finder 会定位到 App，屏幕边缘出现一条 44pt 宽的窄条。

---

## 还需要手动做两件事

### ① 加载浏览器扩展

Edge 地址栏输入 `edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→
选择 `~/Applications/TaskPulse/edge-ext`。

扩展只做两件事：上报目标站点标签页的标题 / 分组名 / 标签 id，以及执行「切到某个标签」的命令。
它只允许访问 `127.0.0.1`，不读取页面内容、不外传数据。

扩展的站点范围由安装脚本按 `config.json` 里的 `extension.scope` 写进 `edge-ext/config.js`，
`manifest.json` 的 `host_permissions` 也只放 `127.0.0.1`——不声明 `<all_urls>`。
**所以改完配置要重新运行一次 `install.command`，然后在 `edge://extensions` 点一次 ⟳。**

### ② 授权与登录

- 第一次点任务行（或右上角提示条）跳转时，系统会弹「TaskPulse 想要控制 Microsoft Edge」，点**允许**。
- 如果服务需要登录，按日志里给出的提示完成一次即可（`~/Library/Logs/taskpulse.log`）。
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
| `poll.interval_seconds` | 取数间隔，默认 60 |
| `poll.stuck_seconds` | 同一轮跑过多久算「卡住」，默认 600 |
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
| 点任务不跳转 | 确认扩展已加载；`curl 127.0.0.1:8899/diag` 里 `ext_seen_age` 应在 0~10 秒内 |
| 想改刷新间隔 | 改 `config.json` 的 `poll.interval_seconds`，或临时 `TP_POLL_SECONDS=30` |
| 想看明细日志 | `~/Library/Logs/taskpulse.log`（行为日志）、`taskpulse.poll.out`（每轮快照） |
