# API 模式 401：问题上报

记录时间：2026-11-24 23:10 · 上报人：huyingjie · 相关提交：`3c61e34`

## 结论（已在本机隔离环境复现并证伪前一个假设）

**API 模式依赖「本机已完成过一次扫码 SSO 登录」的凭据缓存，不是版本问题。**

同一台机器、同一版本（`ks-aimate 1.5.3`）、同一份 config、同一个安装包，只改凭据缓存：

| 条件 | 结果 |
|---|---|
| `~/.codeflicker/sso/.ks_sso/sso-state.json` 不存在（cookie=0） | `/conversations/list` **401** |
| 把工作机上的同一份缓存拷进去 | **69 个会话，正常** |

SDK 自己的调试日志（`KS_SSO_SESSION_DEBUG_ENABLED=1`）把链路写得很清楚：

```
[Step 1/7 load-cookie] loaded from state, cookies=0, state_exists=False
[Token] codeflicker port=3459 token found, len=1039        ← 票换到了，aud 也含 dataagent
[Token] inject header X-KsSSO-Session-Token, len=1039      ← 头也注入了
[Response] status=401, url=.../conversations/list
[AuthCheck] auth required: status 401
[SmartSSO] post-login API rejected: status=401, target_domain=dataagent.corp.kuaishou.com
           has cookies=True. SSO login chain succeeded but API still rejected
           → fail_stage=post_login_api_401 (not SSO failure)
[Step 7/7 result] post-login-fail
```

也就是说：**换票、注头都成功，是数据平台侧的第三层登录态缺失**，SDK 自己明确标注
`not SSO failure`。

工作机的缓存里有哪些东西（只看名字与域名）：

```
accessproxy_session   .sso.corp.kuaishou.com / .tc.corp.kuaishou.com / .dataagent.corp.kuaishou.com
userToken, dpUserToken, userName, userId   dataagent.corp.kuaishou.com
apdid, ks_security_encrypt, ks_sso_gray_cookie   .kuaishou.com
```

新机器上只有 2 条（`apdid` + 一次请求顺带写下的 `accessproxy_session`），拿不到
`userToken` / `dpUserToken` 这类 dataagent 应用自有的登录凭证。

## 首次登录为什么必须人工

SDK 在缺凭据时会降级去开浏览器走 SSO 登录，这条路需要两件事：

1. 外部命令 `agent-browser`（≥0.27，npm 包，**不是 Python 依赖**，所以
   `--with ks-aimate` 不会带它）
2. 人拿手机扫二维码

实测（装好 agent-browser、`KS_SSO_DISABLE_HTTP_REPLAY=1` 强制走浏览器）：

```
[Step 5/7 auth-path] agentBrowser: first reauth
[Preflight] agent-browser --version OK: agent-browser 0.44.0
→ 二维码已展示
→ SSOAuthRequiredError: 二维码已展示或后台正在认证，扫码完成后请重新发起请求
```

所以它不是「配错」，而是设计上的一次性人工授权。

## 修复

新增 `packaging/api_login.command`：自动装 `agent-browser`（若缺）、强制浏览器路径、
弹出二维码，扫码完成后直接验证取数。一次授权，之后长期可用（会话过期时重跑）。

`packaging/api_check.command` 现在会打印 `登录凭据 N 条 cookie`，并在 401 且
cookie < 5 时直接判定为「需要扫码授权一次」，不再误报成版本问题。

## 更正上一版结论

上一版把原因归到 `ks-aimate` 版本（1.0.29 没有 `trustDomain` 能力）。那个差异真实
存在，但在干净环境里用 **1.5.3** 同样 401，说明它不是本次故障的成因。版本下限提到
`>=1.4.0` 仍然保留（旧版确实缺域限票能力，留着会掩盖真正的问题）。

