# TaskPulse 架构审查与修复交接

审查基准为 2026-11-24 的 `master` 提交 `422200634974286e23a8cb77150e35f0dc2f207c`。范围包括 Python 后台、API/WEB 采集、Edge/Chrome 扩展、AppKit 浮窗、网页看板和安装发布。 [固定提交][commit]

## 结论与实施顺序

最先修状态提交和数据新鲜度。目前用户刚设的截止时间可能被覆盖，WEB 心跳也可能把旧队列状态刷新成「当前」。这两个问题会直接影响日常使用和后续延迟测量。沿用单一后台进程与本机快照，在现有进程内收敛状态写入、采集调度和本地提醒的职责。

| 顺序 | 改动范围 | 合并前验收 |
|---|---|---|
| 1 | 统一状态提交，修 WEB 样本时间与模式切换唤醒。见问题 1、2、16 | 用户操作保留。迟到的旧来源和重复样本无法回写。新来源能持续采样 |
| 2 | 独立调度本机提醒，明确任务身份、监控覆盖和回复、运行语义。见问题 5、7、11–14 | 上游故障期间提醒仍触发。账号切换、短任务、休眠恢复和失败跳转行为正确 |
| 3 | 约束 WEB 采集请求数，统一两种来源的响应契约，补旧会话快探和分组快照。见问题 3、4、6、15、17 | 多标签请求量可控。分别验收新建、重启一轮、结束，能解释每种情况下的延迟 |
| 发布前 | 处理本机鉴权、异常恢复、安装与升级。见问题 8–10 | 权限、数据留存、干净检出出包及安装回滚通过验收 |

按模块提交时，先将问题对应的本地场景写成回归测试，再从真实上游补一份脱敏样本。运行状态、回复证据、已读确认和截止时间可用四类独立字段表达。每次采集携带数据范围、观测时间、来源代数。所有写入通过同一条提交路径，提交后再发布通知和界面快照。

## 已确认的核心问题

### 1. 用户操作可能被重复落盘覆盖

`poll_tick()` 已在锁内合并并保存，`/webstate` 和 `/mode` 的回调还会在锁外保存它的返回值。前次夹具让用户在两次保存中间设置截止时间，随后第二次写入抹掉截止时间。来源切换后，晚返回的 API 样本也能够覆盖已经提交的 WEB 样本。 [状态提交][state-commit] · [WEB 上报与模式切换][web-routes]

改造。移除外层二次写入。一个提交入口先读最新状态，再校验来源代数、每个任务的观测顺序，合并后保存。将当前选择来源与最后成功数据来源写入同一份状态快照。

### 2. WEB 心跳会给旧队列续期

队列请求失败后，页面继续上报之前的队列结果。接收端刷新整个快照的时间戳，读取缓存时又用当前时间生成队列观测。此前夹具中，121 秒前的「运行中」可再次进入实时计数。多次读取可替换的 WEB 缓存，也会引入混合批次。 [页面缓存][bridge-cache] · [WEB Provider][web-provider] · [采样时间][samples]

改造。分别记录采集者在线时间、列表成功时间和每个队列或消息的成功时间。用一次固定的输入快照完成一次合并。心跳负责连接健康，只有新的成功样本推进队列观测时间。旧值可显示为「待确认」。

### 3. WEB 多页重复采集，队列处理缺乏公平性

所有匹配页各自定时拉取，API 模式下也可能继续发送 WEB 请求。单页固定从前向后扫描且每轮最多查 6 个，合成回放 24 个忙任务时，90 秒内末尾 6 个始终没被查。 [脚本注册与上报][bridge-registration] · [页面队列调度][bridge-schedule]

改造。每个账号或监控范围只选一个采集页，切换到 API 时撤销采集权。页面退出后重新选取。按最久未成功观测的时间安排队列，给新会话留配额，在统一限额内处理超时和退避。

### 4. 两种数据来源对平台配置解释不同

API 读取可配置的队列字段、消息路径和消息列表键。WEB 的复查节奏固定检查 `sessionState` 和数组形态的 `pending`，消息端点和键也写死。使用样例 `state` 字段时，合成的忙任务 20 秒内只查了一次。 [API 解析][api-provider] · [WEB 解析][bridge-cache] · [扩展配置生成][extension-config]

改造。让两种采集适配器共享字段约定和脱敏测试样本。业务错误、未知结构、合法空列表、部分成功与超时各有明确结果。

### 5. 回复、限流和待处理超时依赖不充分的证据

8 秒短任务忙转闲且 `updateTime` 未变时会直接标「已查看」。同一条待处理回复在超时转成「卡住」后，下一条空闲采样可重新将其标记为待处理并重置倒计时。旧一轮的限流消息也能被用于判断新一轮。 [回复判断][pending-reply] · [队列样本合并][state-apply] · [消息分类][samples]

改造。以当前轮次、回复版本和错误归属来更新状态。队列空闲且回复证据缺失时显示「回复待确认」。用同一个回复版本决定待处理超时起点。优先用消息 ID、轮次 ID 和结构化错误字段，关键词只作有边界的后备。

### 6. 5 秒轮询周期无法直接作为端到端指标

API 默认每 5 秒发现并只复查最多 2 个既有忙会话，同时与全量和消息检查争用串行采样预算。WEB 默认约 30 秒刷新列表，后台 alarm 也是约 30 秒。此前对相同调度逻辑的合成回放，列表 200 毫秒、队列 120 毫秒、浮窗每 2 秒读取。1、5、10、15 个并行运行时，「结束到可见」P95 约为 6.7、14.8、24.4、34.6 秒。 [API 候选选择][discovery] · [网页采集周期][bridge-schedule] · [后台 alarm][bridge-alarm]

改造。优先确认平台的批量状态或生命周期事件能够覆盖哪些会话，验证可用后再接入。批量每 4 秒一次约 15 次/分钟。逐会话轮询下，15 个会话每 5 秒各查一次已需 180 次队列请求/分钟，需据实限制监控范围。建议把正常网络与明确监控范围内的端到端 P95 ≤ 5 秒设为目标。分别记录提交、新轮次开始、结束这三个入口的上游可见时间、状态提交时间和界面可见时间，并报告请求量和漏报率。

### 7. 切换标签仍可能提前标已读或重复打开

`/open` 入队即标已读，兜底启动后命令仍可被扩展领走。原生聚焦对 AppleScript 非零退出仍判成功。两种浏览器的命令消费者也缺少明确的路由归属。 [跳转入口][open-route] · [原生兜底][open-fallback] · [扩展消费][bridge-focus]

改造。命令携带目标浏览器实例、会话、点击时的回复版本和失效时间。认领与兜底按命令互斥执行。目标标签聚焦成功后确认对应版本，新到的回复保留未读。实际失败反馈到浮窗。

### 8. 回环服务需要可验证的客户端身份

本机路由在接受请求后缺少客户端鉴权，并返回通配跨源响应。WEB 缓存会保存消息片段，当前活跃标签的 URL 也应独立做采集范围校验。目标浏览器对本地网络的实际访问策略仍需实测。 [本机 HTTP 路由][http] · [活跃标签][active-tab] · [WEB 上报与缓存][web-routes]

改造。为原生 App、扩展和网页看板建立本机配对身份，校验路由权限、来源与字段。按完整平台来源和会话 ID 过滤标签。采集端可预先归类失败，只上传必要标识、时间和类别，并为缓存明确权限与清理期限。

### 9. 配置恢复与撤销操作存在缺口

合法 JSON 中的无效轮询间隔可在入口诊断前中断启动，合法但形状不符的状态文件也会让视图读取失败。App 的 `showAll` 默认关闭，当前没有可达切换入口，已完成任务实际很难恢复。 [配置载入][config] · [状态文件][storage] · [浮窗列表][swift-list]

改造。按字段校验配置，给状态文件加版本和恢复诊断。提供可达的「已完成」视图和撤销动作。迁移用旧文件做回归，保留用户设置的截止时间和勾选。

### 10. 打包与健康检查的覆盖不足

打包脚本将二进制写入干净检出里没有的 App Bundle 路径。CI 运行 Swift 编译与脚本语法检查。安装中的健康探针只看命令退出码，模拟服务返回 HTTP 500 时仍可报已就绪。安装还有先替换文件、后验证依赖和启动的问题。 [构建脚本][build] · [CI][ci] · [依赖和安装][install]

改造。把 Bundle 的元数据纳入版本控制，从临时目录组装并签名。检查配置、依赖和产物后再切换安装目录。启动失败回到前一版本。健康探针核对服务身份、HTTP 状态和返回结构，分开显示「进程在线」与「取数就绪」。CI 从干净检出执行一次实际出包。

## 进一步复验的四个架构问题

### 11. 本地截止时间依赖上游成功取数

截止时间存于本机，提醒在 `poll_tick()` 触发。假时钟下，第一次取数前设置第 5 秒到期，随后连续三次取数失败并等待 60、120、240 秒。界面字段已是 `overdue`，提醒直到第 420 秒恢复后才产生。 [提醒检查][deadline] · [退避循环][scheduler]

改造。现有后台内增加独立的截止时间调度，修改截止时间时唤醒。唤醒和恢复时按绝对时间检查，只对同一个截止版本发一次提醒，再按配置处理后续复提醒。

### 12. 会话 ID 缺少数据范围

状态键只有 `cid`。让两个合成数据范围都返回 42，后者继承了前者的勾选和截止时间，队列请求被跳过。影响取决于真实平台对会话 ID 唯一范围的承诺。 [任务合并][task-merge]

改造。按平台、可验证的账号或租户和会话 ID 确定任务身份。API、WEB 同一身份才复用持久状态。用新旧状态文件测试迁移，身份无法确认时保留旧记录并等待明确归属。

### 13. 历史未读与当前覆盖混在一起

最近窗口内的会话才优先采样。离开列表的待处理任务在合成用例中经过 8 天仍占实时计数，也没有被标记过期。对分页、过滤变动、明确删除，应采用不同的回收语义。 [覆盖选择][discovery] · [新鲜度与计数][view]

改造。记录采集范围及其完整性、最后在列表出现的时间。历史待办可保留，实时计数按明确的覆盖规则汇总。分页缺项先标「范围外」或「待核」，明确删除时按保留策略归档。

### 14. 采样中断后沿用旧运行起点

模拟 46 分钟没有观测，恢复后只收到一次忙就沿用之前的起点并报「卡住」。这两次忙采样之间可能已结束一轮、另启一轮。 [运行时长和告警][state-apply]

改造。以同一运行 ID 和可信起跑时间承接连续计时。休眠、重启或长时间断线后从新证据恢复。运行 ID 缺失时，显示「持续时间待确认」，或从重新观测时开始显示本机观测时长。

## 本轮新增发现

### 15. 待处理和空闲型卡住会话重跑时会错过快速发现

`resuming_candidates()` 只接受 `seen`。对还未读的 `attention` 或因限流留在 `stuck`、已无运行起点的会话，即使列表时间更新并且实际已开跑，两个对象在该轮快速发现里都未触发队列查询。合成测试直到全量检查才变为「运行中」。这一缺口直接影响「已有会话新起一轮也要 5 秒发现」。 [重跑候选][resume] · [发现轮次][discovery]

改造。基于列表版本变化和最近运行证据选取候选。对新建、已判忙、可能重跑的任务留对等的预算，并按最近探测时间轮转。时间戳变化作为探测线索，运行状态由队列或权威事件确认。

### 16. 换来源的一次即时刷新无法唤醒旧调度

`/mode` 起线程执行一轮刷新，常驻调度仍在原来的 `sleep()` 里。模拟 API 连续三次失败后，在第 185 秒切至 WEB，第 190 秒切回已恢复的 API。两次即时刷新均成功，下一次常驻采样仍等到第 420 秒。 [模式切换][mode] · [常驻调度][scheduler]

改造。由常驻调度接收来源切换事件并立即重新安排工作。将退避归属到来源或共享的限流范围，按实际平台约定复用限流期限。用回归测试验证模式切换后第二次、第三次采样也按新安排执行。

### 17. 分组和浏览器标签需要一次一致的快照

当前约定是 API 使用浏览器标签组，WEB 使用平台组。合成夹具上报有组的标签后再次发送同浏览器的空标签快照，旧组名和旧 `tabId` 仍保留。`view()` 每行读取一次来源，随后还分别读两次来源信息。模拟读取中途切换后，一份响应同时含 API 浏览器分组和 WEB 平台分组，顶层来源显示为 WEB。 [分组投影][group-project] · [来源回显][view] · [标签快照][tabs]

改造。按浏览器实例替换整份有效快照，区分有效空和采集失败，给旧快照设置期限。每次响应在组装前固定一次来源、状态修订和标签快照，再生成全部任务与计数。

## 回归验收清单

| 场景 | 可观察的通过标准 |
|---|---|
| 慢采样期间完成任务、设置截止时间或反复切换来源 | 本机写入保留。旧代采样无效。同一队列成功观测不会提交多次 |
| 扩展在线、队列超时或浏览器从前台转后台 | 保留上一次已知状态并标记数据年龄。心跳延续连接状态，队列时间稳定 |
| 上游断开、系统休眠后唤醒、已有任务未读时再次运行 | 本地超时提醒独立触发。有真实轮次证据才沿用旧起点。新一轮可进入快探 |
| 短任务、未读状态跨轮和过期的失败消息 | 回复版本和失败归属明确。证据不足时显示待确认。待处理超时稳定 |
| 浏览器跳转失败、双浏览器、关闭标签或移组 | 同一次命令最多由一个执行方处理。聚焦成功才确认对应回复。显式空快照清理旧组 |
| 同 ID 不同账号，会话掉出第一页 | 持久状态按数据范围隔离。历史未读和监控覆盖都能核对 |
| 新建、旧会话再次运行和任务结束 | 分 API、WEB 记录 P50、P95、最大延迟、漏报率和上游请求量。覆盖 1、5、10、15 个并行会话及 WEB 前后台 |
| 干净出包、升级失败、健康检查 | macOS 出包和安装可复现。失败升级按上一个版本回滚。错误服务和取数失败各有明确诊断 |

## 证据范围

在 `4222006` 的干净源码上执行了 18 项仓库回归、扩展 JavaScript 和安装 Bash 语法检查，全部通过。对问题 11–17 另用临时状态目录、假时钟和合成响应验证，问题 17 含关页与渲染中切来源两个用例。问题 1–10 的原审查基于 `e49ace6`，已核对截至本次基准的分组变更。真实平台的字段唯一性、批量和事件契约、Chrome/Edge 实机联动及 macOS 出包安装仍需在目标环境验证。 [从前次审查到本次基准的差异][audit-diff]

[commit]: https://github.com/daybreak98/taskpulse/commit/422200634974286e23a8cb77150e35f0dc2f207c
[state-commit]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L831-L932
[web-routes]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1579-L1635
[bridge-cache]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/edge-ext/web-bridge.js#L31-L108
[web-provider]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L439-L511
[samples]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L630-L704
[bridge-registration]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/edge-ext/background.js#L231-L283
[bridge-schedule]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/edge-ext/web-bridge.js#L110-L145
[bridge-alarm]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/edge-ext/background.js#L161-L198
[api-provider]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L355-L432
[extension-config]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/packaging/install.command#L178-L209
[pending-reply]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L596-L622
[state-apply]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L707-L795
[discovery]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L798-L830
[open-route]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1649-L1670
[open-fallback]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1207-L1275
[bridge-focus]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/edge-ext/background.js#L107-L158
[http]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1498-L1557
[active-tab]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/edge-ext/background.js#L43-L85
[config]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L106-L145
[storage]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L228-L248
[swift-list]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/pulse.swift#L743-L841
[build]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/packaging/build.sh#L13-L39
[ci]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/.github/workflows/verify.yml
[install]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/packaging/install.command#L264-L305
[deadline]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L897-L929
[scheduler]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1745-L1785
[task-merge]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L837-L890
[view]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L963-L1051
[resume]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L555-L570
[mode]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1615-L1635
[group-project]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L937-L1000
[tabs]: https://github.com/daybreak98/taskpulse/blob/422200634974286e23a8cb77150e35f0dc2f207c/poller.py#L1116-L1147
[audit-diff]: https://github.com/daybreak98/taskpulse/compare/e49ace685722ed162a22564be41f46b84ec41d97...422200634974286e23a8cb77150e35f0dc2f207c
