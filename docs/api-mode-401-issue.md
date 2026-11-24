# API 模式 401：问题上报

记录时间：2026-11-24 23:10 · 上报人：huyingjie · 相关提交：`3c61e34`

## 结论：依赖版本不一致，票的作用域缺 dataagent

安装包只声明了 `ks-aimate>=1.0.29`，**没有上限**，不同机器可能解析出不同版本。
两个版本的换票行为不同：

| SDK 版本 | 换票时带 `trustDomain` | 票的 `aud` | 结果 |
|---|---|---|---|
| 1.0.29 | 否（没有 `token_provider.py`） | `["cloud-claw"]` | `/conversations/list` **401** |
| 1.2.0 / 1.3.0 / 1.4.0 / 1.5.3 | 是 | `["cloud-claw", "dataagent.corp.kuaishou.com"]` | 正常，69 个会话 |

证据（本机实测，同一台机器分别用两个版本跑）：

```
ks-aimate==1.0.29  → 模块内没有 token_provider.py，源码中无 trustDomain，无 OBO 域限票能力
ks-aimate==1.5.3   → 无 trustDomain: aud=['cloud-claw'] token_len=999
                     带 trustDomain: aud=['cloud-claw','dataagent.corp.kuaishou.com'] token_len=1039
```

SDK 里这张域限票的取法是 [token_provider.py:338](/Users/hyj/taskpulse/poller.py)（第三方包，非本仓库）：

```python
def _get_token_codeflicker(self, trust_domain=None, trace_id=None):
    api_url = f"http://localhost:{port}/api/open/ap-token"
    if trust_domain:
        api_url = f"{api_url}?trustDomain={trust_domain}"
```

调用方按请求 URL 的 host 决定 trust_domain（`session.py:4027`）：

```python
target_domain = urlparse(url).netloc
if cfg.get("obo_required"):
    self._probe_obo_token_or_exit(trust_domain=target_domain)
```

## 修复

`packaging/internal/uv-args.txt` 与 `packaging/api_check.command` 的下限从
`ks-aimate>=1.0.29` 提到 `ks-aimate>=1.4.0`（已验证支持 trustDomain）。
新包 `dist/TaskPulse-20261125-internal.zip`。

## 诊断工具

`api_check.command` 现在会打印 SDK 版本与**SDK 实际使用的域限票的 aud**：

```
SDK      ks-aimate 1.5.3
票据范围 cloud-claw,dataagent.corp.kuaishou.com（目标域 dataagent.corp.kuaishou.com，SDK 实际使用的那张）
```

若 `票据范围` 里没有 `dataagent`，它会直接给出「SDK 版本偏低」的判断。

## 仍需确认

同事机器的 `ks-aimate` 版本与票据 aud。若重装后 `SDK` 显示 < 1.4.0，说明
内网源在她的网络环境下解析到了旧版，需要确认是缓存还是源不同。

---

