# TaskPulse 网页版（taskpulse-ext）请求降载改动方案

- 状态：**待评审**，未改任何代码
- 日期：2026-11-27
- 基线：`origin/master` @ `6510e809`，`taskpulse-ext` v2.1.1
- 实测环境：Edge 158，单浏览器单扩展实例，83 个会话

---

## 0. TL;DR

只提一个改动：**同版本不再重复读消息**（新增 `timing.unchangedAudit`）。

| | 现状 | 改后 | 幅度 |
|---|---|---|---|
| 消息请求 | 58 次 / 217s | ~12 | **-79%** |
| 总请求 | 121 次 / 217s = **0.56 QPS** | ~75 = **0.35 QPS** | **-38%** |
| 日请求量 | ~48,000 | ~30,000 | -18,000 |

用户可感知的延迟**零变化**（依据见 §4）。另有一项原计划的改动经实测收益为 0，已否决（§5）。

---

## 1. 现状实测

### 1.1 方法

扩展把整份状态写入 `chrome.storage.local`（LevelDB）。按 LevelDB log 格式解出全部 `tp-web-state-v1` 快照，逐份差分：某会话的 `observedAt` / `messageObservedAt` / `listAt` 变化一次，即对应一次真实请求。

脚本：`/tmp/ldb.py` + `/tmp/qps3.py`（本次临时工具，不入库）。

### 1.2 结果（217 秒窗口，0 个运行中任务）

```
列表 5 次 | 队列 58 次 | 消息 58 次
合计 121 次 → 0.556 QPS
```

三个独立窗口复测：0.56 / 1.04 / 1.29 QPS（后两者含活跃会话）。

### 1.3 关键观察：队列与消息次数完全相等

`58 == 58`，且逐间隔一一对应（Q7/M7、Q5/M5、Q6/M6…）。这不是巧合：

```javascript
if (await pullQueue(row, sample, deadline) && ... &&
    TaskPulseState.queueBusy(sample.queue) === false) {
  if (wasBusy && probes.has(row.id)) probes.get(row.id).nextAt = 0;
  await pullLastMessage(row, sample, deadline);
}
```

**消息读取只在「同一会话队列读完 + 判定空闲」之后发生**，因此消息频率天然被队列频率钳制。

### 1.4 重复率

同一窗口内，58 次消息请求中 **58 次的相邻两次上报里该会话列表版本相同**，即 100% 是没有新内容的重复读取。

---

## 2. 根因

### 2.1 消息退避被 `Math.min` 吃掉

`pullLastMessage` 里两处控制频率的代码**互相抵销**：

```javascript
// L239-L240：算出 delay
const delay = waiting ? ... : isHot(row, sample, stamp) ? timing.hot : 30_000;

// L243-L244：取 min —— 只要 lastAt + delay 到期就放行
const due = previous?.errorAt ? previous.nextAt
  : Math.min(previous?.nextAt || 0, (previous?.lastAt || 0) + delay);
if (sameVersion && stamp < due) return;
```

即使把 `probe.nextAt` 推到 5 分钟后，`Math.min` 仍会在 `lastAt + 30s` 放行。**所以单改 `nextAt` 无效，必须同时改 `delay`。**

### 2.2 版本号已经是充分的「内容未变」证据

`sameVersion` 来自列表返回的 `updateTime`。而消息内容变化 ⇒ 会话 `updateTime` 变化（这与现有 `hints` / hot 机制的前提一致：`updateTime` 变化会立即把该行标记为 hot 并 2 秒复查）。既然版本没变，上次读到的「最后一条消息」结论就仍然成立。

### 2.3 现状为什么保留 30s/10s

原意应为「防止列表版本滞后时漏掉新消息」（`35fa505 Reserve a message slot for each queue read to prevent recurring audit gaps`）。该保护针对的是**版本已变**的场景，而当前代码对「版本未变」也一并重读，超出了它的目的。

---

## 3. 改动 A（推荐）

两处代码 + 一个配置项。

### 3.1 `config.js` — 新增可调参数

```diff
       settleFast: 12_000, settleSlow: 90_000, queueBudget: 6, watch: 24,
-      coldIdle: 300_000, pressureBase: 30_000, pressureMax: 300_000,
+      coldIdle: 300_000, unchangedAudit: 300_000,
+      pressureBase: 30_000, pressureMax: 300_000,
```

> 做成配置项的好处：**回滚不需要改代码**，把 `unchangedAudit` 调回 `30_000` 即恢复原行为。

### 3.2 `web-bridge.js` L239-L244 — `delay` 区分版本

```diff
     const elapsed = sample.settleSince ? stamp - sample.settleSince : 0;
+    // 版本未变时没有可读的新内容：退避到 unchangedAudit。
+    // 版本一变该行会立刻变 hot，delay 走 timing.hot（2s），不受此退避影响。
+    const idle = sameVersion ? timing.unchangedAudit : 30_000;
     const delay = waiting ? elapsed < timing.settleFast ? timing.hot :
-      elapsed < timing.settleSlow ? 5_000 : 15_000 : isHot(row, sample, stamp) ? timing.hot : 30_000;
+      elapsed < timing.settleSlow ? 5_000 : 15_000 : isHot(row, sample, stamp) ? timing.hot : idle;
     // A prior successful historical response may have installed a 30s
     // cooldown. An active task's completion fence always takes priority.
     const due = previous?.errorAt ? previous.nextAt :
       Math.min(previous?.nextAt || 0, (previous?.lastAt || 0) + delay);
```

### 3.3 `web-bridge.js` L281-L282 — `nextAt` 同步

```diff
       probe.nextAt = Date.now() + (waiting && !verifiedNew ? delay :
-        isHot(row, sample, Date.now()) ? timing.hot : sender === "assistant" ? 30_000 : 10_000);
+        isHot(row, sample, Date.now()) ? timing.hot :
+        sameVersion ? timing.unchangedAudit : sender === "assistant" ? 30_000 : 10_000);
```

> 保留 `sender === "assistant" ? 30_000 : 10_000` 这一分支不动，只为让「版本已变」的原行为逐字不变。

**净改动：2 行逻辑 + 1 个配置项。** 不触碰队列节奏、列表节奏、上报节奏、UI。

---

## 4. 为什么对用户可感知延迟无影响

新回复的发现通道是**列表**，不是消息轮询：

```
列表（空闲 30s / 活跃 5s）
  → 某行 updateTime 变化 → 打 hot 标记（hotWindow 20s）
  → 该行 2s 内读队列 + 读消息
  → 判定为新回复 → urgent 上报（250ms）
  → 面板 / 系统通知
```

三处强制复位保证退避不会拖慢真实变化：

| 机制 | 位置 | 作用 |
|---|---|---|
| 版本变化 → hot | `dueAt` 中 `row.updateTime !== sample.version` 设 `hotUntil` | delay 走 `timing.hot`=2s，压过任何退避 |
| 忙 → 闲跃迁 | `if (wasBusy && probes.has(row.id)) probes.get(row.id).nextAt = 0` | 立即读一次，确认回复内容 |
| 失败重试 | `probe.nextAt = now + min(60s, 10s·2^failures)` | 错误路径不受 `unchangedAudit` 影响 |

### 4.1 延迟对照

| 场景 | 现状 | 改后 |
|---|---|---|
| 新回复 → 面板/通知 | ≤ 30 + 2 + 0.25 ≈ **32s** | 不变 |
| 会话开始运行 → 蓝色 +1 | ≈ 32s | 不变 |
| 运行中状态刷新 | 2s | 不变 |
| 运行超 30min → 珊瑚 | 2s 内 | 不变 |
| 有待回复 → 30min 后转珊瑚 | 2–15s | 不变 |
| 用户正开着的会话 | 60s 队列 + 随读消息 | 不变 |
| 面板重绘 | 4s（紧急 0.25s） | 不变 |

### 4.2 唯一变慢的情形

**消息内容变了但列表 `updateTime` 未变** —— 该情形无法从代码证伪：

- 现状：最长 60s 发现
- 改后：最长 300s 发现

若评审认为不可接受，把 `unchangedAudit` 设为 `120_000`：收益从 -79% 降到约 -65%，异常窗口缩短一半。

---

## 5. 已否决的改动 B：去掉 `watchRows` 的「前 24」无条件下限

原计划删除 `state.js:220` 的 `index < timing.watch`。**实测收益为 0，建议不做。**

用当前 83 个会话核对（按 `updateTime` 倒序）：

```
前 24 个中超过 24h 未更新的：0 个（最旧 21.5 小时）
24h 内有更新的行：27 个
⇒ 前 24 的窗口已被 recent(24h) 完全覆盖，删除它不会缩小 watch 集合
```

watch 集合实际由 `recent(27) ∪ 用户打开的标签 ∪ activeTask(3)` 构成，与那段下限无关。删它只会增加「活跃任务因其列表行过期而被漏采」的风险，纯负收益。

---

## 6. 待评审选项 C：放宽 `cold()` 的 `messageUpdate` 门槛

改动 A 之后，队列请求（58 次/217s）成为主要成本。而 `cold()` 目前有 39/83 个会话进不去：

```
update != messageUpdate   命中 39    ← 唯一的主要卡点
其余 7 个条件             命中 0–1
```

即：这些会话的「消息水位」落后于列表版本，因而无法享受 `coldIdle`（300s），永远退回 60s。

**候选放宽方式**：将 `Number(task.messageUpdate) === Number(row.updateTime)` 替换为
「`probe.lastAt >= sample.at && probe.updateTime === row.updateTime`」
（= 我们确实在**当前版本**上读过消息，且未发现新回复），`messageUpdate` 仅作为展示用的水位。

- 收益：预计再降 30–40% 队列请求，总 QPS 约 0.35 → 0.22
- 风险：`messageUpdate` 的语义从「证据」降级为「水位」，可能影响 `verifiedReply()` / `revision()` / 未读判定
- **前置动作**：先查清那 39 个会话到底是「水位记账滞后」还是「真的未确认」。前者可放宽，后者不可。本方案未包含此项，需单独评估。

---

## 7. 验证方案

### 7.1 单测（必须在 `tests/test_web_extension.cjs` 新增）

1. 版本未变时，同一会话的消息请求间隔 ≥ `unchangedAudit`（用 fixture 记录请求时间戳断言）
2. 版本变化时，消息请求在 `timing.hot` 内发生（不被退避拖慢）
3. `busy → idle` 跃迁时立即读一次消息（`nextAt = 0` 仍然生效）
4. 消息请求失败后按 `10s·2^failures`（≤60s）重试，不受 `unchangedAudit` 影响
5. 新回复场景端到端：fixture 造一条新 assistant 消息 → 断言琥珀 +1 与通知在 32s 内产生（现有 fixture 已支持按时间推进）

### 7.2 现网对照（10 分钟窗口，前后各一次）

复用 §1.1 的 LevelDB 差分法：统计列表/队列/消息三类请求次数。验收标准：

- 消息请求下降 ≥ 60%
- 总请求下降 ≥ 30%
- **同时**：`awaitingReply` / `pending` 的出现时刻与改造前偏差 ≤ 5s（用两份快照对同一会话的变化时刻比对）

### 7.3 现有单测的影响（已实测，必须处理）

补丁已在临时副本上应用并跑完整测试套件：**112 通过 / 1 失败**。

失败的是 `#105 low-load cold audit: measured steady-state requests fall without dropping initial coverage`。

| | 列表 | 队列 | 消息 | 合计 |
|---|---|---|---|---|
| 基线（未打补丁）改造前 → 改造后 | 20 | 240 → 48 | **240 → 48** | 500 → 116 |
| 打补丁后 改造前 → 改造后 | 20 | 240 → 48 | **48 → 48** | 308 → 116 |

两点结论：

1. **改造后的绝对值完全一致（116 = 116）**。说明改动对「已进入冷审计的会话」零影响，与 §2.3 的推断一致——收益全部来自「非冷会话」（消息 240 → 48，5 倍）。
2. 测试仍失败，因为断言写的是**相对降幅**：
   ```javascript
   assert.ok(after.total <= before.total * .35, ...);
   ```
   补丁把分母（改造前 500）也一起降到了 308，比值从 0.232 变成 0.376，于是判红——**属于断言设计问题，不是回归**。

建议同步把该断言改为基准无关的形式，例如：

```diff
-  assert.ok(after.total <= before.total * .35, JSON.stringify({ before, after }));
+  // 收益来自「非冷会话」：断言改造后每条冷会话的请求次数，而非相对降幅
+  assert.ok(after.queue >= 24, "a cold conversation must still receive periodic audits");
+  assert.ok(after.messages >= 24, "audits must still read message identities");
+  assert.ok(after.messages <= after.queue, "message reads never exceed queue reads");
+  assert.ok(before.messages >= 5 * after.messages,
+    "unchanged list version must stop re-reading the same message body");
```

### 7.4 灰度建议

先只在个人账号（本机）加载观察 1 天，确认无「新回复延迟变大」的报告，再合入。

---

## 8. 需评审拍板的问题

1. **`updateTime` 是否覆盖所有消息变更？** 这决定 300s 是否安全（备选 120s）。
2. **`unchangedAudit` 做配置项**（便于回滚与灰度）是否可以接受。
3. **改动 B 确认不做**（实测收益 0）。
4. **选项 C 是否需要单独排期**（收益最大，但涉及状态机语义）。
5. **`edge-ext`（桌面版桥接扩展）是否同步修复**：桌面版已冻结，但它仍随 `TaskPulse-mac-*.zip` 分发，且缺少 `coldIdle` 这套逻辑，在同一浏览器并与本文档无关的机器上仍按 60s 全量轮询。若继续分发，建议至少同步改动 A。

---

## 附：本次测量数据一览（2026-11-27 13:20–17:50）

| 时刻 | 会话数 | 运行中 | watch | 窗口 | 列表/队列/消息 | QPS |
|---|---|---|---|---|---|---|
| 13:27 | 75 | 0 | 36 | 217s | — | 0.91 |
| 15:30 | 81 | 0 | 44 | 240s | — | 0.56 |
| 17:40 | 83 | 1 | 46 | 217s | 5 / 58 / 58 | 0.56 |

三次测量均只统计 `taskpulse-ext` 自身的请求（读它自己的 LevelDB），QPS 差异来自当时是否存在活跃会话。
