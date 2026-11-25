# 纯扩展版（pilot）· 已冻结

状态：**冻结**，不继续开发，不参与打包，不影响现有的 App 版（`TaskPulse.app` + `poller.py`）。

目标读者：后续接手这块的人。

---

## 为什么要做

现有版本安装链路重：Gatekeeper 放行未签名脚本 + 解压 130MB 运行时 + 终端跑脚本。
纯扩展是唯一能做到「解压 → 加载扩展 → 能用」的形态（扩展是 JS，不受签名/公证限制）。

## 做了什么

代码在 `taskpulse-ext/`，约 600 行，无任何本机依赖：

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3，`side_panel` + `tabs` / `tabGroups` / `alarms` / `storage` |
| `background.js` | 选主（几十个标签只一个采集）、标签快照（cid → tabId + 组名）、落 `chrome.storage.local` |
| `web-bridge.js` | 从现有 `edge-ext/web-bridge.js` 原样搬来，多一个 `tp-nudge` 处理（对抗后台标签定时器节流） |
| `panel.html/css/js` | 侧边栏：状态判定（running / attention / stuck / seen / done）+ 渲染 + 点行切标签 + 勾选完成 |

打包产物：`dist/TaskPulse-ext.zip`（16 KB，9 文件）。

## 与 App 版的差别（已确认接受）

1. **没有屏幕边缘浮窗** —— 只能在浏览器侧边栏看，切到别的 App 就看不见
2. **必须开着至少一个 DataAgent 页面** —— 所有数据从页面同源接口取
3. **没有 API 模式** —— 扩展拿不到 dataagent 的 userToken（只有 Python 侧 SDK 能换）
4. 没有提示条、截止时间、批量关标签

## 已验证到什么程度

- `node --check` 三个 JS 全通过
- 状态判定逻辑用 node 单测覆盖五态：

```
["正在跑:running:营销号:-","等我回:attention:组A:42","已看过:seen:-:-","卡住了:stuck:-:-"]
{"running":1,"attention":1,"stuck":1,"seen":1}
```

- **未做**：真实浏览器加载验证（需要人在 `edge://extensions` 点「加载解压缩的扩展」）

## 继续做的话，从哪开始

1. 在 Edge 里加载 `taskpulse-ext/`，刷新一个 DataAgent 页面，确认 sidePanel 能出数据
2. 补「Agent 回话了」的提示：background 里比较前后快照，`chrome.notifications` 弹
3. 补截止时间 / 批量关标签：迁移 `poller.py` 里的 `close_conversation_tabs` 逻辑
4. MV3 的坑：service worker 30 秒闲置会被回收，所有状态必须落 `chrome.storage`，定时靠 `chrome.alarms`（最小 30 秒）

## 与 App 版的关系

- 两套并存，互不干扰：扩展版写 `chrome.storage`，App 版写 `~/.taskpulse/`
- 但**同一个页面**会同时被两个扩展注入 `web-bridge.js`，采集请求翻倍。测试时只启用一个
- App 版仍然是主形态（屏幕边缘浮窗 + API 模式）
