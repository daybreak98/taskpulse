# API 模式 401：问题上报

记录时间：2026-11-24 23:10 · 上报人：huyingjie · 相关提交：`3c61e34`

## 一句话

同一份安装包、同一份配置，A 机器（本人）API 模式正常取到会话；B 机器（同事
yuan）调用 `/conversations/list` 返回 **HTTP 401**，而 WEB 模式在 B 机器上正常。
需要判断这张票为什么不被数据平台接受。

## 两台机器的对照

| | A（正常） | B（401） |
|---|---|---|
| 客户端 | MyFlicker（票据 `claw_id_issuer=MyFlicker`） | 客户端在运行（3459 有响应） |
| 票据的 username | `huyingjie` | 未采集到 |
| `pypi.corp` 可达 | HTTP 200 | HTTP 200 |
| `127.0.0.1:3459/api/open/ap-token` | HTTP 200 | HTTP 200 |
| 直接取数 `/conversations/list` | 成功，69 个会话 | **HTTP 401** |
| WEB 模式 | 正常 | 正常 |

B 机器 `api_check.command` 的完整输出：

```
配置     provider=module  KS_AGENT_PLATFORM=codeflicker
内网源   可达（HTTP 200）
凭据服务  在线（HTTP 200）
直接取数  FAIL HTTPError: /conversations/list 返回 HTTP 401
结论     服务在线（端口 8899），但取数未就绪，上游报错：HTTPError: /conversations/list 返回 HTTP 401
```

## 已排除

- 内网不通：`pypi.corp` 200，依赖安装成功
- 依赖缺失：`ks-aimate` 能导入（否则 `api_check` 会报 `ModuleNotFoundError`）
- 客户端没起：3459 有响应
- 配置缺字段：`provider=module`、`KS_AGENT_PLATFORM=codeflicker` 都在
- 代码差异：两台用同一个 zip、同一个 `poller.py`

## 涉及代码

认证入口（[poller.py:463](/Users/hyj/taskpulse/poller.py:463)）：

```python
def make_session():
    a = CFG.get("auth") or {}
    # 有些 SDK 靠环境变量决定去哪换凭据；在导入模块之前注入
    for k, v in (a.get("env") or {}).items():
        os.environ[str(k)] = str(v)
    if provider == "module":
        return _ModuleSession(module, factory, extra_config, ctor_kwargs)
```

`_ModuleSession` 把 `extra_config` 透传给 SDK 的 `request()`（若是签名里有该参数）：

```python
class _ModuleSession:
    def request(self, method: str, url: str, **kw):
        if self._takes_extra and self._extra:
            kw["extra_config"] = self._extra
        return self._s.request(method, url, **kw)
```

配置（安装包内 `config.json`）：

```json
"auth": {
  "provider": "module",
  "module": "ks_aimate.sso_login_client",
  "factory": "SmartSSOSession",
  "extra_config": { "obo_required": true },
  "env": { "KS_AGENT_PLATFORM": "codeflicker" }
}
```

A 机器上解码 `ap-token` 拿到的身份（供对照）：

```
username       = huyingjie
claw_id_issuer = MyFlicker
iss            = kssso-session
```

## 需要专家判断的点

1. `ks_aimate.sso_login_client.SmartSSOSession` + `extra_config={"obo_required": true}`
   在什么条件下会换出**非 OBO** 的票？B 机器是否可能静默降级成普通 session 票，
   导致 `dataagent` 侧 401。
2. `/conversations/list` 的 401 是「票无效」还是「票有效但 interface 未授权」？
   如果是后者，返回 403 还是 401。
3. `KS_AGENT_PLATFORM` 取值（`codeflicker` / `myflicker` / 其他）是否影响票的
   audience。A 机器用 `codeflicker` 而票由 MyFlicker 签发且可用，说明二者并非一一对应；
   是否存在「换票路径名」与「签发方」两套概念。
4. 账号维度：B 机器的内网账号是否需要单独开通 DataAgent 权限，还是只要网页能登录即可。
   若是前者，需要哪个系统里给权限。
5. 是否存在 OBO 需要「先有一次网页登录」的前置条件（B 机器 WEB 正常，说明网页侧登录过）。

## 已提供的一次性诊断工具

安装包自带 `api_check.command`（[packaging/api_check.command](/Users/hyj/taskpulse/packaging/api_check.command)），
在 B 机器上双击即可输出上述对照信息，并在 API 不可用时自动切到 WEB 保证可用。
它也会打印票据所属的 `username` 与 `claw_id_issuer`，可直接判定「是不是登错账号」。
