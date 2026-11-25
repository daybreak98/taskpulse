#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.31.0,<3"]
# ///
"""TaskPulse —— 桌面角落的 Agent 会话监视器（后台服务）。

定期发现会话，并较频繁地复查运行中的队列，维护任务状态：
  running   进行中（agent 还在思考）
  stuck     卡住（本轮思考超过阈值，或这一轮被限流打断）
  attention 待你处理（agent 停下且有新回复）
  done      已完成（你看过了）

对外提供本地 HTTP：/state /ack /open /deadline /（完整看板页）

连接哪个服务、用哪种认证，全部来自 ~/.taskpulse/config.json；
代码本身不含任何具体服务的地址、包名或字段约定。
"""

import fcntl
import hmac
import importlib
import inspect
import json
from collections import deque
import os
import re
import secrets
import subprocess
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import NamedTuple
from urllib.parse import parse_qs, urlparse

import requests

HOME = os.path.expanduser("~")
CONFIG_FILE = os.environ.get("TASKPULSE_CONFIG") or os.path.join(HOME, ".taskpulse", "config.json")
STATE_FILE = os.path.join(HOME, ".taskpulse", "state.json")
# 「用户正在看哪个标签页」要跨进程共享：HTTP 进程收扩展上报，--once 进程算状态
ACTIVE_FILE = os.path.join(HOME, ".taskpulse", "active.json")
# 本机 HTTP 的身份密钥。三方（poller / App / 浏览器扩展）各自独立启动，
# 谁也管不到别人，只有共同家目录里的这个文件能当「谁是同一台机器主人」的唯一真相。
TOKEN_FILE = os.path.join(HOME, ".taskpulse", "token")
TOKEN_HEADER = "X-TP-Token"
LOG_FILE = os.path.join(HOME, "Library", "Logs", "taskpulse.log")

# 全部默认值都指向「不存在的示例服务」，避免任何真实系统痕迹
DEFAULTS = {
    "platform": {
        "base_url": "",
        "api_prefix": "/api/v1",
        "agent_ids": [],
        # {host} {agent} {cid} 三个占位符
        "conversation_url": "{host}/chat?agentId={agent}&conversationId={cid}",
        "endpoints": {
            "conversations": "/conversations/list",
            "queue": "/conversations/{cid}/queue",
            "messages": "/conversations/{cid}/messages?pageNo=1&pageSize=1",
        },
        # 列表请求体，整块替换（不与其他默认值合并）；
        # 值写 "{agent_ids}" 会在请求前被替换成 agent_ids 数组
        "conversations_body": {},
        "queue_fields": {"state": "state", "pending": "pending", "idle": ["IDLE"]},
        "messages_list_key": "list",
    },
    "auth": {
        "provider": "none",          # none | token_file | module
        "module": "",                # provider=module 时必填，如 "acme.auth"
        "factory": "Session",        # 模块里负责建会话的可调用对象
        "extra_config": {},          # 每次请求透传给 SDK 的额外参数
        "ctor_kwargs": {},           # 建会话对象时的构造参数
        "env": {},                   # 建会话前注入的环境变量（SDK 要求的开关/路径）
        "token_file": "",            # provider=token_file 时读哪个文件
        "token_header": "Authorization",
        "token_prefix": "Bearer ",
    },
    "poll": {
        "interval_seconds": 60,
        "discovery_interval_seconds": 5,
        "active_interval_seconds": 5,
        "active_watch_limit": 2,
        "resume_probe_limit": 1,
        "stuck_interval_seconds": 60,
        "rate_limit_probe_seconds": 60,
        "watch_limit": 20,
        "stuck_seconds": 1800,
        "window_limit": 10,
        "archive_hours": 48,
    },
    "ui": {"port": 8899},
    # 数据来源：api=用 auth 配置直连接口；web=用浏览器里开着的页面（cookie 认证）
    "source": "api",
    "extension": {"scope": ""},
    # 识别「被限流打断」的关键词；留空则不启用该判定
    "failure_marks": [],
}


def _deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _apply_env(cfg: dict) -> dict:
    """环境变量可临时覆盖（调试用，不必改文件）；配置缺失时也照样生效。"""
    env = os.environ
    if env.get("TP_POLL_SECONDS"):
        cfg["poll"]["interval_seconds"] = int(env["TP_POLL_SECONDS"])
    if env.get("TP_WATCH_LIMIT"):
        cfg["poll"]["watch_limit"] = int(env["TP_WATCH_LIMIT"])
    if env.get("TP_ARCHIVE_HOURS"):
        cfg["poll"]["archive_hours"] = float(env["TP_ARCHIVE_HOURS"])
    if env.get("TP_PORT"):
        cfg["ui"]["port"] = int(env["TP_PORT"])
    return cfg


# 配置里数值型字段的合法范围：越界就退回默认值并记一条错误，
# 不让一个笔误（0、负数、字符串）在启动后才炸成看不懂的异常
_NUMERIC_FIELDS = {
    ("poll", "interval_seconds"): (1, 86400),
    ("poll", "discovery_interval_seconds"): (0, 3600),
    ("poll", "active_interval_seconds"): (0, 3600),
    ("poll", "active_watch_limit"): (0, 500),
    ("poll", "watch_limit"): (0, 500),
    ("poll", "stuck_seconds"): (30, 86400),
    ("poll", "window_limit"): (1, 200),
    ("poll", "archive_hours"): (1, 24 * 365),
    ("ui", "port"): (1, 65535),
}


def _validate_config(cfg: dict) -> list[str]:
    """按字段校验；不合法的项落回默认值，返回错误清单。"""
    problems: list[str] = []
    # 整段写成了别的类型（"poll": []）时先换回默认值，否则下面按字段访问会崩
    for section in ("poll", "ui", "platform", "auth"):
        if section in cfg and not isinstance(cfg.get(section), dict):
            cfg[section] = json.loads(json.dumps(DEFAULTS[section]))
            problems.append("%s 不是对象，已用默认值" % section)
    for (section, field), (low, high) in _NUMERIC_FIELDS.items():
        bucket = cfg.get(section)
        if not isinstance(bucket, dict):
            continue
        raw = bucket.get(field)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = None
        if value is None or not (low <= value <= high):
            fallback = DEFAULTS[section][field]
            bucket[field] = fallback
            problems.append("%s.%s=%r 无效，已用默认值 %s" % (section, field, raw, fallback))
    if str(cfg.get("source", "api")).lower() not in ("api", "web"):
        cfg["source"] = "api"
        problems.append("source 只能是 api 或 web，已用 api")
    return problems


def _load_config() -> tuple[dict, str]:
    """读配置；文件缺失或损坏时返回默认值 + 一句给人看的错误。"""
    cfg = json.loads(json.dumps(DEFAULTS))       # 深拷贝
    if not os.path.exists(CONFIG_FILE):
        return (_apply_env(cfg),
                "配置文件不存在：%s（运行 install 脚本可自动生成）" % CONFIG_FILE)
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            user = json.load(f)
    except Exception as exc:  # noqa: BLE001
        return _apply_env(cfg), "配置文件读取失败：%s（%s）" % (CONFIG_FILE, exc)
    if not isinstance(user, dict):
        return _apply_env(cfg), "配置文件不是对象：%s" % CONFIG_FILE
    merged = _apply_env(_deep_merge(cfg, user))
    problems = _validate_config(merged)
    return merged, ("；".join(problems) if problems else "")


CFG, CONFIG_ERROR = _load_config()
PLATFORM = CFG["platform"]
HOST = (PLATFORM.get("base_url") or "").rstrip("/")
API = HOST + (PLATFORM.get("api_prefix") or "")
PORT = int(CFG["ui"]["port"])
AGENT_IDS = list(PLATFORM.get("agent_ids") or [])
POLL_SECONDS = max(1, int(CFG["poll"]["interval_seconds"]))
TP_DEBUG = os.environ.get("TP_DEBUG") == "1"
WATCH_LIMIT = max(0, int(CFG["poll"]["watch_limit"]))
# 数据来源可在运行时切换（UI 上那个 API / WEB 按钮）
WEBSTATE_FILE = os.path.join(HOME, ".taskpulse", "webstate.json")
# web 模式下缓存超过这么久没更新，就当作「页面没在报」，别让旧数字看着像新的。
# 页面在后台会被节流，实测有过 80 秒的空档；阈值取 180 秒，避免提示来回闪。
WEB_STALE_SECONDS = max(180, POLL_SECONDS * 3)
# 页面没上报时，后台敲一次的周期；UI 用它显示「约 N 秒后重试」
WEB_RETRY_HINT_SECONDS = 15
# 由 App 拉起时设置：宿主退出后本进程也要退出（不留在后台空转）
EXIT_WITH_PARENT = os.environ.get("TP_EXIT_WITH_PARENT") == "1"
# App 的 PID。不能只看 ppid：进程树是 App → uv → python，
# python 的父进程是 uv（不会被 reparent），父进程死掉时 ppid 也不变
HOST_PID = int(os.environ.get("TP_HOST_PID") or 0)


def source_mode() -> str:
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            v = (json.load(f).get("source") or "api")
    except Exception:
        v = CFG.get("source") or "api"
    v = str(v).lower()
    return v if v in ("api", "web") else "api"


def set_source_mode(mode: str) -> None:
    """只在配置文件里改这一项，其余原样写回。"""
    global _source_epoch
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    cfg["source"] = mode
    _source_epoch += 1          # 版本先加，随后落盘
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_FILE)
ACTIVE_POLL_SECONDS = max(0, int(CFG["poll"]["active_interval_seconds"]))
DISCOVERY_POLL_SECONDS = max(0, int(CFG["poll"].get("discovery_interval_seconds", 5)))
ACTIVE_WATCH_LIMIT = min(WATCH_LIMIT, max(0, int(CFG["poll"]["active_watch_limit"])))
# 已经判定「卡住」的会话放慢复查节奏（分钟级），把 5 秒档留给真正在跑的
STUCK_POLL_SECONDS = max(ACTIVE_POLL_SECONDS,
                         min(POLL_SECONDS, int(CFG["poll"].get("stuck_interval_seconds", 60))))
# 「已查看」的会话又起了新一轮：发现周期顺带查几个，别等到下一分钟
RESUME_PROBE_LIMIT = max(0, int(CFG["poll"].get("resume_probe_limit", 1)))
# 运行中多久没结束就翻一次最后一条消息，看是不是被限流停住了
RATE_LIMIT_PROBE_SECONDS = max(0, int(CFG["poll"].get("rate_limit_probe_seconds", 60)))
RATE_LIMIT_PROBE_GAP_SECONDS = max(30, RATE_LIMIT_PROBE_SECONDS * 2)
RATE_LIMIT_PROBE_ATTEMPTS = 3
# 待回复的结论是「翻最后一条消息」得出的，而限流提示可能比消息本身晚落地：
# 允许在窗口内隔一会儿再看一次，别把「第一次没翻到」当成「没有限流」永久定死。
REPROBE_GAP_SECONDS = max(30, min(60, RATE_LIMIT_PROBE_GAP_SECONDS // 4))
REPROBE_WINDOW_SECONDS = 300
REPROBE_ATTEMPTS = 4
# 多久没再出现在列表里，就只当历史记录、不再计入实时状态
COVERAGE_EXPIRE_SECONDS = 3600
# 跑动结束后先等一个窗口再下结论：列表刷新比队列慢，立刻判「已查看」会吃掉
# 短任务的回复。90 秒覆盖 api（60s）与 web（30s）两种列表周期
REPLY_SETTLE_SECONDS = 90
# 两次成功观测之间断档超过半小时，就不再认为「同一轮一直在跑」。
# 定在半小时而不是几分钟：正常轮询是分钟级，能断到这么久只有休眠/断网/进程停摆，
# 而低于卡住阈值的一半时，重启计时反而会掩盖真实的长时间运行。
RUN_GAP_RESET_SECONDS = max(1800, POLL_SECONDS * 10)
ROUND_BUDGET_SECONDS = 10
DEFAULT_STUCK_SECONDS = int(CFG["poll"]["stuck_seconds"])
DEFAULT_WINDOW_LIMIT = int(CFG["poll"]["window_limit"])
DEADLINE_REMIND_SECONDS = 1800
# 「已查看」超过这么久没有任何新进展 → 自动归档，移出列表
AUTO_ARCHIVE_HOURS = float(CFG["poll"]["archive_hours"])
FAIL_MARKS = tuple(CFG.get("failure_marks") or ())
CONV_URL = PLATFORM.get("conversation_url") or ""



def now_ms() -> int:
    return int(time.time() * 1000)


def log(msg: str) -> None:
    line = f"[{time.strftime('%F %T')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def ensure_token() -> str:
    """确保家目录里有身份密钥，没有就现生成一份（32 字节 urlsafe base64，权限 0600）。

    为什么是文件而不是配置项：安装脚本、App、扩展、poller 四者启动顺序不确定，
    配置里存一份就得四处同步；放到 ~/.taskpulse/token 只需要「读同一个文件」。
    """
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            value = f.read().strip()
        if value:
            return value
    except FileNotFoundError:
        pass
    except OSError as exc:
        log(f"读取本机接口密钥失败：{exc}")
    value = secrets.token_urlsafe(32)
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        try:
            # O_EXCL：谁先建谁算数。安装脚本和 poller 可能同时第一次启动，
            # 各自生成一把的话，扩展里已经写好的那把票就作废了。
            fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            with open(TOKEN_FILE, encoding="utf-8") as f:
                current = f.read().strip()
            if current:
                return current
            # 空文件（上次写到一半被打断）：覆盖重建，别让它一直当「空钥匙」
            fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value + "\n")
        os.chmod(TOKEN_FILE, 0o600)   # 文件已存在时 O_CREAT 的 mode 不生效，补齐
    except OSError as exc:
        log(f"生成本机接口密钥失败：{exc}（本机接口将无法校验调用方）")
        return ""
    log("已生成本机接口密钥：%s" % TOKEN_FILE)
    return value


_TOKEN_CACHE = {"key": None, "value": ""}
_TOKEN_LOCK = threading.Lock()


def read_token() -> str:
    """读当前密钥，按 (路径, mtime) 缓存。

    为什么要缓存：/state 会被 App 每秒拉一次，每次都 stat + open 纯属浪费；
    缓存键带上 mtime 与大小，用户手动换钥匙后能立刻生效。
    """
    try:
        st = os.stat(TOKEN_FILE)
    except OSError:
        # 文件被删了：重生成一把，别让界面一直停在「未授权」
        return ensure_token()
    key = (TOKEN_FILE, st.st_mtime_ns, st.st_size)
    with _TOKEN_LOCK:
        if _TOKEN_CACHE["key"] == key:
            return str(_TOKEN_CACHE["value"])
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            value = f.read().strip()
    except OSError as exc:
        log(f"读取本机接口密钥失败：{exc}")
        return ""
    with _TOKEN_LOCK:
        _TOKEN_CACHE["key"] = key
        _TOKEN_CACHE["value"] = value
    return value


# 通知不再走 osascript：macOS 会把 `display notification` 记在「脚本编辑器」名下，
# 点通知打开的是脚本编辑器而不是会话。改成把事件塞进 /state，由 App 自己的提示条弹出，
# 点一下就直接跳到对应标签页。
_STARTED_AT = int(time.time())
_events: list[dict] = []
_events_seq = 0
_events_lock = threading.Lock()


def notify(title: str, body: str, cid: str | None = None) -> None:
    global _events_seq
    with _events_lock:      # 两个线程都可能推事件，序号必须唯一，否则 App 会当成重复丢掉
        _events_seq += 1
        seq = _events_seq
    _events.append({"seq": seq, "title": title, "body": body, "cid": cid})
    del _events[:-20]


# ── 存储 ────────────────────────────────────────────────────────────

_lock = threading.Lock()
# 唤醒取数循环：来源切换、页面新上报都要立刻重排，不能等原来的 sleep 走完
_wake = threading.Event()
# 每次切换数据来源都递增；用来识别「同一模式但已经换过一轮」——只比 api/web
# 字符串的话，API→WEB→API 往返后旧样本仍会被当成当前来源的
_source_epoch = 0
# 截止时间调度自己的唤醒（改截止时间、撤销时立刻重算，不用等下一个整秒）
_deadline_wake = threading.Event()


# 端到端延迟：会话在列表里露头（update_ms）到本机把状态落定，取最近若干次
_latencies: "deque[int]" = deque(maxlen=200)
STATE_SCHEMA = 2


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except OSError:
        return {}
    except ValueError as exc:
        # 损坏的状态文件留着当证据，然后从空状态重建：视图必须还能打开
        bad = STATE_FILE + ".corrupt"
        try:
            os.replace(STATE_FILE, bad)
            log("状态文件损坏，已备份到 %s：%s" % (bad, exc))
        except OSError:
            pass
        return {}
    if not isinstance(state, dict):
        return {}
    return state


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    state["schema"] = STATE_SCHEMA
    # 临时文件名要唯一：取数循环和 /webstate 会同时写，共用一个 .tmp 时
    # 先 replace 的那个会把文件搬走，另一个就 ENOENT
    tmp = "%s.%d.%d.tmp" % (STATE_FILE, os.getpid(), threading.get_ident())
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_FILE)


# ── 认证 ────────────────────────────────────────────────────────────

class _PlainSession:
    """不带任何认证，适用于已对本地开放的服务。"""

    def __init__(self) -> None:
        self._s = requests.Session()

    def request(self, method: str, url: str, **kw):
        return self._s.request(method, url, **kw)


class _TokenFileSession:
    """把 token 文件的首行当令牌，每次请求重读，方便轮换。"""

    def __init__(self, path: str, header: str, prefix: str) -> None:
        self._path = os.path.expanduser(path)
        self._header = header or "Authorization"
        self._prefix = prefix or ""
        self._s = requests.Session()

    def _token(self) -> str:
        try:
            with open(self._path, encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        return line.strip()
        except OSError:
            pass
        return ""

    def request(self, method: str, url: str, **kw):
        tok = self._token()
        if not tok:
            raise RuntimeError("token 文件为空：%s" % self._path)
        self._s.headers[self._header] = self._prefix + tok
        return self._s.request(method, url, **kw)


class _ModuleSession:
    """用配置指定的 Python 模块建会话；该模块的 request 若支持 extra_config 则透传。"""

    def __init__(self, module: str, factory: str, extra: dict, ctor_kwargs: dict) -> None:
        mod = importlib.import_module(module)
        ctor = getattr(mod, factory)
        self._s = ctor(**(ctor_kwargs or {}))
        self._extra = dict(extra or {})
        try:
            params = inspect.signature(self._s.request).parameters
            self._takes_extra = "extra_config" in params
        except (TypeError, ValueError):
            self._takes_extra = False

    def request(self, method: str, url: str, **kw):
        if self._takes_extra and self._extra:
            kw["extra_config"] = self._extra
        return self._s.request(method, url, **kw)


def make_session():
    a = CFG.get("auth") or {}
    # 有些 SDK 靠环境变量决定去哪换凭据；在导入模块之前注入，配置优先于继承来的环境
    for k, v in (a.get("env") or {}).items():
        os.environ[str(k)] = str(v)
    provider = (a.get("provider") or "none").lower()
    if provider == "module":
        module = a.get("module") or ""
        if not module:
            raise RuntimeError("auth.provider=module，但 auth.module 未配置")
        return _ModuleSession(module, a.get("factory") or "Session",
                              a.get("extra_config") or {}, a.get("ctor_kwargs") or {})
    if provider == "token_file":
        path = a.get("token_file") or ""
        if not path:
            raise RuntimeError("auth.provider=token_file，但 auth.token_file 未配置")
        return _TokenFileSession(path, a.get("token_header") or "Authorization",
                                 a.get("token_prefix") or "")
    if provider == "none":
        return _PlainSession()
    raise RuntimeError("未知的 auth.provider：%s（可选 none / token_file / module）" % provider)


def _render(obj, agent_ids):
    """配置里写 "{agent_ids}" 的字段递归替换成真实数组。"""
    if isinstance(obj, dict):
        return {k: _render(v, agent_ids) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_render(v, agent_ids) for v in obj]
    if obj == "{agent_ids}":
        return list(agent_ids)
    return obj


def conv_page_prefix() -> str:
    """会话页的 URL 前缀，如 https://host/ai/data-agent。

    标签映射与批量关标签都要求 URL 落在这个前缀下：同一域名下还有别的页面，
    只按「URL 里含 conversationId」判断不够严。
    """
    if not CONV_URL:
        return ""
    head = CONV_URL.split("?")[0].replace("{host}", HOST)
    # 模板里可能还有 {agent}/{cid} 等占位，取第一个占位之前的部分
    for mark in ("{", "}"):
        idx = head.find(mark)
        if idx > 0:
            head = head[:idx]
            break
    return head.rstrip("/")


CONV_PAGE_PREFIX = conv_page_prefix()


def _is_conv_page(url: str) -> bool:
    """URL 是否是会话页。前缀后必须结束或紧跟 ? / # / /，
    否则 /ai/data-agent-history 这类也会被误判。"""
    if not CONV_PAGE_PREFIX:
        return True
    if not url.startswith(CONV_PAGE_PREFIX):
        return False
    rest = url[len(CONV_PAGE_PREFIX):]
    return rest == "" or rest[0] in "?#/"


def conv_url(agent_id, cid) -> str:
    if not CONV_URL:
        return ""
    try:
        return CONV_URL.format(host=HOST, agent=agent_id, cid=cid)
    except (KeyError, IndexError, ValueError):
        return ""


# ── 取数 ────────────────────────────────────────────────────────────

class AgentClient:
    def __init__(self) -> None:
        self.session = make_session()
        self.body = _render(PLATFORM.get("conversations_body") or {}, AGENT_IDS)
        ep = PLATFORM.get("endpoints") or {}
        self.ep_conversations = ep.get("conversations") or "/conversations/list"
        self.ep_queue = ep.get("queue") or "/conversations/{cid}/queue"
        self.ep_messages = (ep.get("messages")
                            or "/conversations/{cid}/messages?pageNo=1&pageSize=1")
        self.list_key = PLATFORM.get("messages_list_key") or "list"
        qf = PLATFORM.get("queue_fields") or {}
        self.f_state = qf.get("state") or "state"
        self.f_pending = qf.get("pending") or ""
        self.idle = tuple(qf.get("idle") or ())

    def _request_data(self, method: str, path: str, timeout: float, **kwargs) -> dict:
        response = self.session.request(method, API + path, timeout=timeout, **kwargs)
        status = getattr(response, "status_code", None)
        if isinstance(status, int) and not 200 <= status < 300:
            raise requests.HTTPError(f"{path.split('?')[0]} 返回 HTTP {status}", response=response)
        result = response.json()
        if (not isinstance(result, dict) or result.get("success") is False
                or not isinstance(result.get("data"), dict)):
            raise ValueError(f"{path.split('?')[0]} 返回的数据格式无效")
        return result["data"]

    def conversations(self, timeout: float) -> list[dict]:
        data = self._request_data("POST", self.ep_conversations, timeout, json=self.body)
        if "groups" not in data and "ungrouped" not in data:
            raise ValueError("会话列表缺少 groups 和 ungrouped")

        groups = data.get("groups")
        ungrouped = data.get("ungrouped")
        if groups is None:
            groups = []
        if not isinstance(groups, list):
            raise ValueError("会话分组格式无效")
        if ungrouped is not None:
            groups = [*groups, ungrouped]

        items: list[dict] = []
        for group in groups:
            if not isinstance(group, dict):
                raise ValueError("会话分组格式无效")
            gname = group.get("name") or ""
            conversations = group.get("conversations")
            if conversations is None:
                continue
            if not isinstance(conversations, list):
                raise ValueError("分组会话列表格式无效")
            for conv in conversations:
                items.append({**conv, "groupName": gname or conv.get("groupName", "")})

        seen, out = set(), []
        for c in items:
            cid = int(c.get("id") or 0)
            if not cid or cid in seen:
                continue
            seen.add(cid)
            c["id"] = cid
            c["updateTime"] = int(c.get("updateTime") or 0)
            out.append(c)
        out.sort(key=lambda c: c["updateTime"], reverse=True)
        return out

    def queue(self, cid: int, timeout: float) -> tuple[bool, str | int]:
        data = self._request_data("GET", self.ep_queue.format(cid=cid), timeout)
        raw = data.get(self.f_state)
        if not isinstance(raw, (str, int)) or raw == "":
            raise ValueError(f"队列缺少有效的 {self.f_state}")
        pending = data.get(self.f_pending) if self.f_pending else None
        return bool(pending) or raw not in self.idle, raw

    def last_message(self, cid: int, timeout: float) -> dict:
        """只取最后一条消息（体积小），用于识别「限流失败」这类停摆而不是交付。"""
        data = self._request_data("GET", self.ep_messages.format(cid=cid), timeout)
        messages = data.get(self.list_key)
        return messages[0] if isinstance(messages, list) and messages and isinstance(messages[0], dict) else {}


class NoSample(Exception):
    """缓存里还没有这个会话的样本。不是错误，只是扩展这一轮没报到它。"""


class WebProvider:
    """数据来自浏览器里开着的 DataAgent 页面（cookie 认证，扩展推送过来）。

    与 AgentClient 同接口，但只读本地缓存：不发起任何 HTTP，也不需要 auth 配置。
    """

    def __init__(self) -> None:
        self._round: dict | None = None    # 本轮定格的快照，见 begin_round
        qf = PLATFORM.get("queue_fields") or {}
        self.f_state = qf.get("state") or "state"
        self.f_pending = qf.get("pending") or ""
        self.idle = tuple(qf.get("idle") or ())
        self._mtime = 0.0
        self._data: dict = {}

    def begin_round(self) -> None:
        """一轮采样开始：把缓存定格一份，之后所有读取都来自同一份。

        页面每几秒就替换一次缓存文件；不固定的话，本轮可能拿到「旧队列 +
        新时间」，旧状态会被当成刚刚确认过。
        """
        try:
            with open(WEBSTATE_FILE, encoding="utf-8") as f:
                data = json.load(f)
            self._round = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            self._round = {}

    def _snap(self) -> dict:
        return self._round if self._round is not None else self._load()

    def _load(self) -> dict:
        try:
            mtime = os.path.getmtime(WEBSTATE_FILE)
        except OSError:
            return self._data
        if mtime != self._mtime:
            try:
                with open(WEBSTATE_FILE, encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    self._data = data
                    self._mtime = mtime
            except (OSError, ValueError):
                pass
        return self._data

    def age_seconds(self) -> float | None:
        """缓存多久没更新了；用于判定「页面都关了」。"""
        at = self._load().get("at") or 0
        return None if not at else (now_ms() - int(at)) / 1000

    def last_at(self) -> int | None:
        """浏览器里那份数据的生成时刻（毫秒）。"""
        at = self._load().get("at") or 0
        return int(at) or None

    def conversations(self, timeout: float) -> list[dict]:
        items = self._load().get("conversations") or []
        out: list[dict] = []
        seen = set()
        for c in items:
            try:
                cid = int(c.get("id") or 0)
            except (TypeError, ValueError):
                continue
            if not cid or cid in seen:
                continue
            seen.add(cid)
            out.append({**c, "id": cid,
                        "updateTime": int(c.get("updateTime") or 0),
                        "createTime": int(c.get("createTime") or 0),
                        "name": clean_name(c.get("name")) or f"会话 {cid}",
                        "groupName": c.get("groupName") or ""})
        out.sort(key=lambda c: c["updateTime"], reverse=True)
        return out

    def queue(self, cid: int, timeout: float) -> tuple[bool, str | int]:
        q = (self._snap().get("queues") or {}).get(str(cid))
        if not isinstance(q, dict):
            raise NoSample(str(cid))
        raw = q.get(self.f_state)
        if raw in (None, ""):
            raise NoSample(str(cid))
        pending = q.get(self.f_pending) if self.f_pending else None
        return bool(pending) or raw not in self.idle, raw

    def queue_at(self, cid: int) -> int | None:
        """这条队列的样本是哪一刻取到的；缓存里的旧值不允许当成刚观测。"""
        at = (self._snap().get("queueAt") or {}).get(str(cid))
        try:
            return int(at) if at else None
        except (TypeError, ValueError):
            return None

    def last_message(self, cid: int, timeout: float) -> dict:
        msg = (self._snap().get("lastMessages") or {}).get(str(cid))
        return msg if isinstance(msg, dict) else {}


def make_agent():
    """按当前数据来源建取数对象。web 模式完全不碰 auth 配置。"""
    return WebProvider() if source_mode() == "web" else AgentClient()


# ── 状态机 ──────────────────────────────────────────────────────────

class QueueSample(NamedTuple):
    at: int
    busy: bool | None
    raw: str | int | None = None
    checked_reply: str | None = None
    failed: bool | None = None
    # 真的取数失败（超时/HTTP 错），和「这轮没问到这个会话」要分开：
    # 后者不是故障，不该把会话标成「待确认」
    error: bool = False
    # at 是否来自数据源自己的取到时刻（web 模式的 queueAt）。是的话，同一份
    # 缓存重复上报时 at 不变，可以据此判重；api 模式 at 是本轮时刻，无需判重
    from_source: bool = False


def running(task: dict) -> bool:
    return not task.get("muted") and bool(task.get("running_since"))


def fast_candidates(tasks: dict, stamp: int) -> list[dict]:
    if not ACTIVE_POLL_SECONDS or not ACTIVE_WATCH_LIMIT:
        return []
    retry_ms = max(ACTIVE_POLL_SECONDS, min(POLL_SECONDS, 60)) * 1000
    stuck_ms = STUCK_POLL_SECONDS * 1000
    eligible = []
    for task in tasks.values():
        # 用户标了「完成后提醒我」的会话即使没在跑也要盯：否则它一旦掉出
        # 监控窗口，下一次回话根本取不到，高亮和弹窗都不会发生
        important = bool(task.get("important")) and task.get("status") != "done"
        if not running(task) and not important:
            continue
        checked = task.get("queue_checked_at") or 0
        # 已经判定卡住的，没必要每 5 秒再看一次；按 stuck_interval_seconds 放慢。
        if task.get("status") == "stuck" and stamp - checked < stuck_ms:
            continue
        if task.get("queue_error") and stamp - checked < retry_ms:
            continue
        # 重要会话按「运行中」的节奏复查（retry_ms 是 60 秒，太慢）
        if important and not running(task) and stamp - checked < ACTIVE_POLL_SECONDS * 1000:
            continue
        eligible.append(task)
    # 最久没检查的先查，避免同一批任务一直占满快速复查的名额。
    eligible.sort(key=lambda task: task.get("queue_checked_at") or 0)
    return [{"id": task["id"], "updateTime": task.get("update_ms") or 0}
            for task in eligible[:ACTIVE_WATCH_LIMIT]]


def resuming_candidates(listed: list[dict], tasks: dict, limit: int) -> list[dict]:
    """列表里 updateTime 已经跳变、但还没人取过队列的会话：用户又起了新一轮。

    - 已查看：说明上一轮交完了，新时间就是新一轮
    - 待回复 / 已卡住但已经没有运行起点：同理，新一轮已经开跑
      （以前只认 seen，这两类得等 60 秒的全量轮询才发现，和「5 秒发现」对不上）
    发现周期顺带查一个，把这段长尾压到秒级。
    """
    if limit <= 0:
        return []
    out = []
    for conv in listed:
        task = tasks.get(str(conv["id"]))
        if not task or task.get("muted"):
            continue
        status = task.get("status")
        if status == "seen":
            base = task.get("acked_update") or 0
        elif status in ("attention", "stuck") and not task.get("running_since"):
            base = max(task.get("update_ms") or 0, task.get("acked_update") or 0)
        else:
            continue
        if conv["updateTime"] <= base:
            continue
        out.append({"id": conv["id"], "updateTime": conv["updateTime"]})
        if len(out) >= limit:
            break
    return out


def reprobe_candidates(tasks: dict, stamp: int, limit: int = 1) -> list[dict]:
    """待回复里「翻过一次、结论可能还没落地」的会话：发现周期顺带复查一个，
    免得限流提示晚到、还要等下一分钟的全量轮询才翻成卡住。"""
    if limit <= 0 or not FAIL_MARKS:
        return []
    out = []
    gap = REPROBE_GAP_SECONDS * 1000
    for task in tasks.values():
        if task.get("muted") or task.get("status") != "attention":
            continue
        if not task.get("classified_reply") or task.get("failed"):
            continue
        last = task.get("message_checked_at") or 0
        if stamp - last < gap:
            continue
        if stamp - (task.get("reply_completed_at") or 0) > REPROBE_WINDOW_SECONDS * 1000:
            continue
        out.append({"id": task["id"], "updateTime": task.get("update_ms") or 0})
        if len(out) >= limit:
            break
    return out


def pending_reply(task: dict, update: int, stamp: int) -> str | None:
    started = task.get("running_since") or 0
    is_newer = update > (task.get("acked_update") or 0)
    if started:
        return f"run:{started}" if is_newer or stamp - started >= 20_000 else None

    previous = task.get("reply_version")
    if task.get("reply_completed_at") and update <= task["reply_completed_at"]:
        # 快速复查先看到忙转闲，会话列表随后补到同一轮的时间戳。
        return previous if task.get("reply_pending") else None
    if is_newer:
        return f"update:{update}"
    if task.get("reply_pending"):
        return previous
    if "reply_pending" not in task and task.get("status") == "attention":
        return f"update:{update}"  # 老状态文件没有独立的未读标记
    return None


def mark_seen(task: dict) -> None:
    task["acked_update"] = task.get("update_ms") or 0
    task["acked_at"] = now_ms()
    task["reply_pending"] = False
    task["countdown_since"] = 0
    if task.get("status") in ("attention", "stuck") or task.get("status") is None:
        task["prev"] = task.get("status") or "running"
        task["status"] = "seen"


def request_timeout(deadline: float) -> float:
    # requests 的超时按连接和读取分别计算；到预算边界时停止发起新请求。
    return min(4.0, (deadline - time.monotonic()) / 2)


def sample_queues(agent: AgentClient, convs: list[dict], tasks: dict,
                  deadline: float) -> dict[str, QueueSample]:
    samples = {}
    for conv in convs:
        cid = str(conv["id"])
        task = tasks.get(cid, {})
        update = conv["updateTime"]
        if task.get("muted") and not (task.get("archived") and update > (task.get("acked_update") or 0)):
            continue
        timeout = request_timeout(deadline)
        if timeout < 0.25:
            break
        try:
            busy, raw = agent.queue(conv["id"], timeout)
            # 观测时刻用「真正取到数据的时刻」，不是「这轮处理的时刻」：
            # web 模式下页面可能几分钟没刷新队列，拿旧值当新样本会让
            # 已经停掉的会话重新进入实时计数
            observed = getattr(agent, "queue_at", None)
            at = observed(conv["id"]) if callable(observed) else None
            samples[cid] = QueueSample(at or now_ms(), busy, raw, from_source=bool(at))
        except NoSample:
            samples[cid] = QueueSample(now_ms(), None)
            continue
        except Exception as exc:
            if isinstance(exc, requests.HTTPError) and exc.response is not None:
                if exc.response.status_code in (401, 403, 429):
                    raise  # 认证或限流故障暂停整轮，避免继续发请求
            log(f"queue {cid} failed: {exc}")
            samples[cid] = QueueSample(now_ms(), None, error=True)

    if not FAIL_MARKS:
        return samples
    for conv in convs:
        cid = str(conv["id"])
        sample = samples.get(cid)
        task = tasks.get(cid)
        if not sample or not task or sample.busy is None:
            continue
        if sample.busy:
            # 跑够一段时间还不结束，先怀疑限流：翻最后一条消息确认，别等它转空闲。
            started = task.get("running_since") or sample.at
            if sample.at - started < RATE_LIMIT_PROBE_SECONDS * 1000:
                continue
            last = task.get("message_checked_at") or 0
            if last and sample.at - last < RATE_LIMIT_PROBE_GAP_SECONDS * 1000:
                continue
            reply = f"run:{started}"
        else:
            reply = pending_reply(task, conv["updateTime"], sample.at)
            if not reply:
                continue
        if task.get("classified_reply") == reply:
            # 已确认限流就不用再翻；结论是「没限流」的，消息体可能还没写完，窗口内再看一次
            if task.get("failed") or sample.busy:
                continue
            last = task.get("message_checked_at") or 0
            if sample.at - last < REPROBE_GAP_SECONDS * 1000:
                continue
            if sample.at - (task.get("reply_completed_at") or 0) > REPROBE_WINDOW_SECONDS * 1000:
                continue
        # 运行中多给几次机会；待回复要留出复查窗口
        limit = RATE_LIMIT_PROBE_ATTEMPTS if sample.busy else REPROBE_ATTEMPTS
        if task.get("message_reply") == reply and task.get("message_attempts", 0) >= limit:
            continue
        timeout = request_timeout(deadline)
        if timeout < 0.25:
            break
        failed = None
        try:
            message = agent.last_message(conv["id"], timeout)
            # 扩展在页面里就把关键词匹配做完了，只回一个布尔：消息原文不出浏览器。
            # 老版本扩展回的是截断后的原文，走下面的兼容分支。
            if isinstance(message.get("failed"), bool):
                failed = message["failed"]
            else:
                content = message.get("content")
                if message.get("sender") == "assistant" and isinstance(content, str) and content:
                    failed = any(mark in content for mark in FAIL_MARKS)
        except Exception as exc:
            if isinstance(exc, requests.HTTPError) and exc.response is not None:
                if exc.response.status_code == 429:
                    raise
            log(f"last_message {cid} failed: {exc}")
        samples[cid] = sample._replace(checked_reply=reply, failed=failed)
    return samples


def apply_queue_sample(task: dict, sample: QueueSample, act: dict,
                       notifications: list[tuple[str, str, str]]) -> None:
    # 先把「上一次真正观测到状态」的时刻抓出来：下面几行会把它覆盖成本次，
    # 事后再读就永远读到新值，间隔判断会退化成死代码
    previous = task.get("queue_observed_at") or 0
    task["queue_checked_at"] = sample.at
    # 只有真的取数失败才记为 error；「这轮没问到」保持原状，别把安静的会话
    # 永久标成「待确认」
    if sample.busy is not None:
        task["queue_error"] = False
    elif sample.error:
        task["queue_error"] = True
    if sample.busy is None:
        return
    task["queue_observed_at"] = sample.at
    task["raw_state"] = sample.raw
    # 没翻消息时不再重置 failed，但仍要保证字段存在（下面直接按索引读）
    task.setdefault("failed", False)

    started = task.get("running_since") or 0
    if started and previous and sample.at - previous > RUN_GAP_RESET_SECONDS * 1000:
        # 休眠/断网期间可能已经结束一轮、又起了新一轮。两次观测之间的「忙」
        # 不能当成同一轮持续在跑，否则恢复后立刻报「卡住」
        started = 0
        task["run_restarted_at"] = sample.at
    if sample.busy:
        if not started:
            started = sample.at
            task["running_since"] = started
            task["countdown_since"] = started
        # 运行中也可能被限流卡住：这一轮翻过消息就把结论落在状态上，别等它转空闲。
        run_reply = f"run:{started}"
        checked = sample.checked_reply == run_reply
        if checked:
            seen_before = task.get("message_reply") == run_reply
            task["message_reply"] = run_reply
            task["message_attempts"] = (task.get("message_attempts", 0) if seen_before else 0) + 1
            task["message_checked_at"] = sample.at
            if sample.failed is not None:
                task["classified_reply"] = run_reply
        # 没翻到新消息时保留上一轮结论：否则「已判限流」会被下一次纯队列采样
        # 抹成 False，状态从卡住退回运行中
        if checked:
            task["failed"] = bool(sample.failed)
        task["reply_pending"] = False
        elapsed = (sample.at - started) // 1000
        # 卡住判定看的是「这一阶段」的倒计时：运行中从起跑算，转入待回复后重新起算
        phase = task.get("countdown_since") or started
        waited = (sample.at - phase) // 1000
        task["status"] = "stuck" if (waited >= DEFAULT_STUCK_SECONDS or task["failed"]) else "running"
        if task["failed"] and task.get("failed_notified") != started:
            task["failed_notified"] = started
            notifications.append(("疑似被限流",
                                  f"{task['name']} 已运行 {max(1, elapsed // 60)} 分钟仍未结束，"
                                  "最后一条回复里提到了繁忙/限流", str(task["id"])))
        if task["status"] == "stuck" and task.get("stuck_notified") != started:
            task["stuck_notified"] = started
            notifications.append(("任务疑似卡住", f"{task['name']} 已运行 {elapsed // 60} 分钟，去看看", str(task["id"])))
        return

    update = task["update_ms"]
    reply = pending_reply(task, update, sample.at)
    was_attention = task.get("status") == "attention"
    task["running_since"] = 0
    task["stuck_notified"] = 0

    if not reply:
        # 这一轮刚跑完，但列表还没补上来（列表 60s/30s 才刷一次）。此刻定「已查看」
        # 会把 8 秒短任务的回复吃掉——它其实需要你处理，只是我们还没有证据。
        # 做法：先留在「运行中」，给一个结算窗口；下一轮列表到了自然转成待回复，
        # 窗口内一直没动静才真的算已查看。代价是短任务晚最多一个窗口才变「已查看」。
        settle_until = task.get("settle_until") or 0
        if started and not settle_until:
            task["settle_until"] = sample.at + REPLY_SETTLE_SECONDS * 1000
        if task.get("settle_until") and sample.at < task["settle_until"]:
            task["status"] = "running"
            task["running_since"] = started
            task["countdown_since"] = task.get("countdown_since") or started
            return
        task.pop("settle_until", None)
        if update <= (task.get("reply_completed_at") or 0):
            task["acked_update"] = max(update, task.get("acked_update") or 0)
        if task.get("status") in ("running", "attention", "stuck"):
            task["prev"] = task["status"]
        task["status"] = "seen"
        task["failed"] = False
        task["reply_pending"] = False
        task["countdown_since"] = 0
        return

    if started:
        task["reply_completed_at"] = sample.at
    if reply != task.get("reply_version"):
        task["failed"] = False
    task["reply_version"] = reply
    task["reply_pending"] = True
    if sample.checked_reply == reply:
        attempts = task.get("message_attempts", 0) if task.get("message_reply") == reply else 0
        task["message_reply"] = reply
        task["message_attempts"] = attempts + 1
        task["message_checked_at"] = sample.at
        if sample.failed is not None:
            task["classified_reply"] = reply
            task["failed"] = sample.failed
    stuck_for_same_reply = (task.get("status") == "stuck"
                            and task.get("stuck_reply") == reply)
    task["status"] = "stuck" if (task.get("failed") or stuck_for_same_reply) else "attention"
    # 从「运行中」转入「待回复」的那一刻重新计；同一条回复不重置，
    # 否则每次采样都把倒计时推回原点，「等你回复超时」永远等不到
    if not was_attention and not stuck_for_same_reply:
        task["countdown_since"] = sample.at
    waited = (sample.at - (task.get("countdown_since") or sample.at)) // 1000
    if task["status"] == "attention" and waited >= DEFAULT_STUCK_SECONDS:
        # 等你回复等太久，同样算卡住
        task["status"] = "stuck"
        task["stuck_reply"] = reply
        if task.get("stuck_notified") != task["countdown_since"]:
            task["stuck_notified"] = task["countdown_since"]
            notifications.append(("任务疑似卡住",
                                  f"{task['name']} 等你回复已超过 {max(1, waited // 60)} 分钟",
                                  str(task["id"])))

    if task["status"] == "attention" and watching(str(task["id"]), act):
        mark_seen(task)


def poll_tick(agent: AgentClient, *, full: bool, discovery: bool = False) -> dict:
    deadline = time.monotonic() + ROUND_BUDGET_SECONDS
    # 本轮的来源身份：模式名 + 版本号。版本号能识别「切走又切回来」，
    # 光比 api/web 会把往返之后的旧样本当成当前的
    gen = (source_mode(), _source_epoch)
    base = load_state()
    tasks = base.get("tasks") or {}
    stamp = now_ms()
    listed: list[dict] = []
    fetched: list[dict] = []
    if full or discovery:
        fetched = agent.conversations(request_timeout(deadline))
        listed = fetched[:WATCH_LIMIT]
        if full:
            # 慢请求耗尽预算时，下轮先补最久未检查的会话。
            listed.sort(key=lambda conv: tasks.get(str(conv["id"]), {}).get("queue_checked_at") or 0)
    if full:
        conversations = listed
    elif discovery:
        # 秒级发现：列表已经拿到了，新会话、刚起新一轮的会话顺带取队列，运行中的照旧复查两个。
        fresh = [conv for conv in listed if str(conv["id"]) not in tasks]
        picked = {str(conv["id"]) for conv in fresh}
        resuming = [conv for conv in resuming_candidates(listed, tasks, RESUME_PROBE_LIMIT)
                    if str(conv["id"]) not in picked]
        picked |= {str(conv["id"]) for conv in resuming}
        reprobe = [conv for conv in reprobe_candidates(tasks, stamp)
                   if str(conv["id"]) not in picked]
        picked |= {str(conv["id"]) for conv in reprobe}
        conversations = fresh + resuming + reprobe + [
            conv for conv in fast_candidates(tasks, stamp) if str(conv["id"]) not in picked]
    else:
        conversations = fast_candidates(tasks, stamp)
    # WEB 侧每轮只读一份缓存：否则队列与观测时刻可能来自不同批次
    begin = getattr(agent, "begin_round", None)
    if callable(begin):
        begin()
    samples = sample_queues(agent, conversations, tasks, deadline)
    if not full and not samples:
        return base

    notifications: list[tuple[str, str, str]] = []
    with _lock:
        state = load_state()
        tasks = state.setdefault("tasks", {})
        act = load_active()
        stamp = now_ms()
        # 启动回填的分界线：这之前建的会话属于历史，一次性记成已看过，免得刷屏；
        # 这之后新建的会话是真·新任务，照常计入运行中。
        baseline = int(state.get("baseline_at") or 0)
        if not baseline:
            baseline = state["baseline_at"] = stamp
        fresh: set[str] = set()
        for conv in listed:
            carried: dict = {}       # 必须在每轮重置，否则上一轮的值会串到下一个会话
            cid = str(conv["id"])
            update = conv["updateTime"]
            created = int(conv.get("createTime") or 0)
            agent_id = conv.get("agentId") or (AGENT_IDS[0] if AGENT_IDS else "")
            task = tasks.get(cid)
            if task is not None:
                old_agent = task.get("agent_id")
                # 同一个会话 ID 落到了另一个数据范围：不能覆盖旧记录（会连带把
                # 勾选、截止时间带过去），旧记录降级归档，新范围从干净状态开始
                if old_agent and agent_id and str(old_agent) != str(agent_id):
                    legacy = "%s@%s" % (cid, old_agent)
                    tasks.setdefault(legacy, dict(task, archived=True, muted=True,
                                                  scope_note="另一个数据范围的旧记录"))
                    # 截止时间是用户对这个会话的意图，不随数据范围一起丢
                    carried = {k: task[k] for k in ("deadline", "deadline_notified") if k in task}
                    log("会话 %s 换了数据范围（%s → %s），旧记录归档为 %s"
                        % (cid, old_agent, agent_id, legacy))
                    task = None
                    tasks.pop(cid, None)
            if task is None:
                fresh.add(cid)
                if created and created >= baseline:
                    task = tasks[cid] = {"status": "running", "prev": "running", "acked_update": 0}
                else:
                    task = tasks[cid] = {"status": "seen", "prev": "running", "acked_update": update}
            task.setdefault("queue_observed_at", task.get("seen_ms") or 0)
            task.update(id=conv["id"], name=clean_name(conv.get("name")) or f"会话 {cid}",
                        agent_id=agent_id,
                        update_ms=update, seen_ms=stamp,
                        # 会话在 DataAgent 里的分组；取消分组时也要覆盖成空
                        group_name=conv.get("groupName") or "")
            if carried:
                task.update(carried)
            task["url"] = conv_url(task["agent_id"], cid)
            task["listed_at"] = stamp          # 最后一次出现在监控窗口里
            if task.get("archived") and update > (task.get("acked_update") or 0):
                task.update(archived=False, muted=False, auto_archived=0, prev="running", status="seen")

        # 分组 / 名称这类元数据对**所有**拉到的会话都更新一遍：分组信息来自列表接口，
        # 而监控窗口只有前 WATCH_LIMIT 个，不补这一趟的话，靠后的任务永远显示「未分组」。
        for conv in fetched:
            task = tasks.get(str(conv["id"]))
            if task is None:
                continue
            task["name"] = clean_name(conv.get("name")) or task.get("name") or ""
            task["group_name"] = conv.get("groupName") or ""

        for conv in conversations:
            cid = str(conv["id"])
            update = conv["updateTime"]
            task = tasks.get(cid)
            if not task:
                continue
            if task.get("muted"):
                task["status"] = "done"
                continue
            sample = samples.get(cid)
            if sample is None:
                continue
            # 同一份队列样本只落一次：web 模式下页面没刷新时上报的还是旧值，
            # 重复提交会把「上次成功观测」一路往后推，等于给旧数据续期
            if (sample.from_source and task.get("queue_checked_at")
                    and sample.at <= task["queue_checked_at"]):
                continue
            if (cid in fresh and sample.busy is False and not task.get("acked_update")
                    and update <= int(conv.get("createTime") or 0)):
                # 刚建好、还没跑过任何一轮的空会话，没有「等你处理」这回事
                task["acked_update"] = update
            # samples 里只有本轮真的问过的会话，所以拿到就能直接落状态
            before = task.get("status")
            apply_queue_sample(task, sample, act, notifications)
            after = task.get("status")
            if after != before and after == "attention":
                # 只有「跑完 → 待回复」的 update_ms 才真是这条回复的上游可见时刻；
                # 其它转换拿到的可能是用户几小时前那条消息，样本会失真
                upstream = task.get("update_ms") or 0
                delta = sample.at - upstream
                if 0 <= delta <= POLL_SECONDS * 3 * 1000:
                    _latencies.append(delta)

        if fresh:
            busy = sum(1 for cid in fresh
                       if tasks.get(cid, {}).get("status") in ("running", "stuck"))
            log(f"新会话 {len(fresh)} 个已纳入统计（{busy} 个在运行）")

        if full:
            for cid, task in list(tasks.items()):
                last = max(task.get("update_ms") or 0, task.get("acked_update") or 0)
                if (task.get("status") == "seen" and not task.get("muted") and not task.get("queue_error")
                        and last and stamp - last > AUTO_ARCHIVE_HOURS * 3600_000):
                    task.update(muted=True, archived=True, status="done", auto_archived=stamp)
                if task.get("status") in ("done", "seen") and stamp - (task.get("seen_ms") or 0) > 7 * 86400_000:
                    del tasks[cid]
            state.pop("poller_error", None)
            state.pop("poller_error_at", None)
            state.pop("retry_at", None)
            state.pop("auth_required", None)
            if isinstance(agent, WebProvider):
                age = agent.age_seconds()
                if age is None or age > WEB_STALE_SECONDS:
                    state["poller_error"] = ("浏览器里的页面没有上报数据（页面已关或扩展停用），"
                                             "显示上次缓存")
                    state["poller_error_at"] = stamp
                    # 只有「扩展在报 + 确实有页面」时，15 秒这个估算才成立；
                    # 否则倒计时会一直归零重来，反而误导
                    alive = (bool(_tab_ids)
                             and any(stamp - t < 180_000 for t in _tab_report_by_browser.values()))
                    if alive:
                        state["retry_at"] = stamp + WEB_RETRY_HINT_SECONDS * 1000
                    else:
                        state.pop("retry_at", None)
                        state["poller_error"] = ("没有可用的 DataAgent 页面："
                                                 "请打开一个页面并确认扩展已加载、已登录")
            # 页面自己报上来的采集错误（解析失败、接口报错）优先展示
            web_err = ""
            try:
                with open(WEBSTATE_FILE, encoding="utf-8") as f:
                    web_err = str((json.load(f) or {}).get("error") or "")
            except (OSError, ValueError):
                web_err = ""
            if web_err:
                state["poller_error"] = "页面采集失败：%s" % web_err[:100]
                state["poller_error_at"] = stamp
        if full or any(sample.busy is not None for sample in samples.values()):
            # web 模式的「更新时间」是浏览器里那份数据的生成时刻，不是本次落盘的时刻——
            # 否则页面停了 100 秒，UI 还以为是刚更新过
            fresh_at = agent.last_at() if isinstance(agent, WebProvider) else None
            state["updated"] = fresh_at or stamp
        # 采样是在锁外做的，可能已经跑了几秒。期间来源被切走的话，这批样本
        # 属于旧来源，落盘会把新来源的数据盖掉——直接丢弃，下一轮按新来源重来。
        if (source_mode(), _source_epoch) == gen:
            save_state(state)
        else:
            log("来源已切换，丢弃这轮 %s 的采样结果" % (gen,))
            return base

    for title, body, cid in notifications:
        notify(title, body, cid)
    if full and sys.platform == "darwin":
        snapshot_edge_tabs(timeout=2)
    return state


# ── 视图 ────────────────────────────────────────────────────────────

def _view_source(mode: str | None = None) -> tuple[str, float | None]:
    """当前数据来源，以及 web 模式下缓存有多旧（秒）。

    mode 由调用方传入复用同一次快照，避免一份响应里来源与缓存年龄来自两个时刻。
    """
    if mode is None:
        mode = source_mode()
    if mode != "web":
        return mode, None
    try:
        with open(WEBSTATE_FILE, encoding="utf-8") as f:
            at = int(json.load(f).get("at") or 0)
    except (OSError, ValueError):
        return mode, None
    return mode, (now_ms() - at) / 1000 if at else None


def task_group(task: dict, mode: str, tabs: dict) -> str:
    """任务显示在哪个组里——两种来源各有各的用处，不要混：

    - web：数据是从那个 DataAgent 页面里取的，组就是会话在平台上的分组
      （列表接口自带 groupName），和你在网页侧边栏看到的一致；
    - api：进程直连接口、没有页面上下文，组用浏览器标签组——那是你自己
      手动归类的标签，正合「我在盯哪几摊事」这个用途。

    mode 与 tabs 由调用方一次性传入：一份响应必须只用同一个来源、同一份标签
    快照，否则「读到一半切了来源」会把两种分组混进同一次返回。
    """
    if mode == "web":
        return task.get("group_name") or ""
    return tabs.get(str(task.get("id")), "")


def _latency_stats() -> dict:
    """状态从「上游可见」到「本机落定」的耗时分布（毫秒）。样本量小的时候照实说。"""
    if not _latencies:
        return {"samples": 0}
    ordered = sorted(_latencies)
    def pick(q: float) -> int:
        idx = min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))
        return ordered[idx]
    return {"samples": len(ordered), "p50_ms": pick(0.5),
            "p95_ms": pick(0.95), "max_ms": ordered[-1]}


def clean_name(value) -> str:
    """会话标题来自上游，可能带换行。界面一行一个任务，这里先压成单行。"""
    text = str(value or "")
    return " ".join(text.replace("\t", " ").split())


def view(state: dict) -> dict:
    limit = DEFAULT_WINDOW_LIMIT
    stuck = DEFAULT_STUCK_SECONDS
    stamp = now_ms()
    # 整份响应共用这一份快照：来源、标签组，动手前各取一次
    mode = source_mode()
    tabs = dict(_tab_groups)
    source, source_age = _view_source(mode)
    stale_after_seconds = max(POLL_SECONDS * 2, 45)

    rows = []
    for task in (state.get("tasks") or {}).values():
        if task.get("archived"):
            continue
        if (not task.get("muted")) and task.get("status") == "done" and stamp - (task.get("seen_ms") or 0) > 6 * 3600_000:
            continue
        observed = task.get("queue_observed_at", task.get("seen_ms")) or 0
        # 掉出监控窗口太久：状态只能当历史，不该继续占用「待回复 / 卡住」的实时计数
        covered = (stamp - (task.get("listed_at") or task.get("seen_ms") or 0)
                   <= COVERAGE_EXPIRE_SECONDS * 1000)
        # 「待确认」只对真在盯的会话有意义：运行中/待回复/已卡住这三种，
        # 拿不到队列就等于不知道该不该报。安静的会话（已查看/完成）本来就没事，
        # 落选监控窗口后拿不到样本是正常的，不能一直挂着「待确认」。
        tracked = task.get("status") in ("running", "attention", "stuck")
        stale = task.get("status") != "done" and (
            not observed
            or (tracked and (bool(task.get("queue_error"))
                             or stamp - observed > stale_after_seconds * 1000)))
        started = task.get("running_since") or 0
        phase = task.get("countdown_since") or started
        elapsed = max(0, ((observed if stale else stamp) - started) // 1000) if started else 0
        waited = max(0, ((observed if stale else stamp) - phase) // 1000) if phase else 0
        progress = 1.0 if task.get("status") == "done" else min(waited / stuck, 1.0)
        rows.append({
            "id": task["id"],
            "name": task.get("name"),
            "group": task_group(task, mode, tabs),
            "status": task.get("status"),
            "prev": task.get("prev"),
            "reply_version": task.get("reply_version"),
            "stale": stale,
            "covered": covered,
            "progress": round(progress, 3),
            "elapsed": elapsed,
            "updated_ms": task.get("update_ms"),
            "idle_minutes": int((stamp - (task.get("update_ms") or stamp)) / 60000),
            "url": task.get("url"),
            "deadline": task.get("deadline"),
            "important": bool(task.get("important")),
            # 浏览器里是否有这个会话的标签页：菜单要用它算「能关多少个」
            "has_tab": str(task["id"]) in _tab_ids,
            "deadline_left": (int((task["deadline"] - stamp) / 1000)
                              if task.get("deadline") else None),
            "overdue": bool(task.get("deadline") and stamp >= task["deadline"]),
            "failed": bool(task.get("failed")),
            "muted": bool(task.get("muted")),
            "acked_at": task.get("acked_at"),
        })

    order = {"stuck": 0, "attention": 1, "running": 2, "seen": 3, "done": 4}
    rows.sort(key=lambda r: (order.get(r["status"], 9), -r["progress"], -(r["updated_ms"] or 0)))

    # 「已查看」的任务继续以暗色留在列表里，直到用户勾选（done）或关掉对应标签页。
    # 标签快照超过 5 分钟没更新时（Edge 没开/脚本失败）不退化成整片消失。
    # 两个浏览器的标签快照合并判断：只用其中一个会把另一个里的任务当成「标签已关」
    live: set[str] = set()
    live_ts = 0
    for cache in _tab_caches.values():
        live |= cache.get("live") or set()
        live_ts = max(live_ts, cache.get("ts") or 0)
    live_fresh = bool(live_ts) and stamp - live_ts < 300_000

    def visible(r):
        if r["status"] == "done":
            return False
        if r["status"] == "seen":
            return (not live_fresh) or (str(r["id"]) in live)
        return True

    active = [r for r in rows if visible(r)]
    return {
        "updated": state.get("updated"),
        "source": source, "source_age": source_age,
        "poller_error": state.get("poller_error"),
        # 401：凭据失效，只有重新扫码能恢复。App 据此显示「重新授权」按钮
        "auth_required": bool(state.get("auth_required")),
        # 还剩几秒会再试；没有退避（比如等页面上报）时为 null
        "retry_in_seconds": (max(0, round(((state.get("retry_at") or 0) - stamp) / 1000))
                             if state.get("retry_at") else None),
        "poller_error_at": state.get("poller_error_at"),
        "stale_after_seconds": stale_after_seconds,
        "stale_count": sum(1 for r in rows if r["stale"]),
        # 提示事件（卡住/限流/超时）：App 拿着自己弹提示条，点了就能直接跳转
        "event_run": _STARTED_AT,
        "events": list(_events),
        "stuck_seconds": stuck,
        "window_limit": limit,
        "extension": {"at": _tab_report_at,
                      "ok": bool(_tab_report_at) and stamp - _tab_report_at < 180_000,
                      # 哪些浏览器最近 3 分钟内有上报，例如 ["edge"]。
                      # 老扩展不带 browser 字段，所以这里可能为空但 ok 为真。
                      "browsers": [k for k, t in _tab_report_by_browser.items()
                                   if stamp - t < 180_000],
                      # 扩展对「浏览器内取数」能力的自检结果（谁注册了 content script）
                      "web": dict(_web_diag)},
        "tasks": active[:limit],
        "active": active,
        "all": rows,
        # 计数必须和界面渲染的行口径一致：App 只认 counts 与任务行，若这里
        # 悄悄扣掉「范围外」的会话，就会出现「胶囊显示 0、点开却有 3 行」。
        # 范围外的数量单独给 out_of_scope_count，供后续做专门视图。
        "counts": {
            **{s: sum(1 for r in rows if r["status"] == s and not r["stale"])
               for s in ("running", "stuck")},
            # 待处理也要限定在覆盖范围内：掉出监控窗口的历史任务仍会列在列表里，
            # 但计入胶囊数字就会和「当前还有几件事等我」不符
            "attention": sum(1 for r in rows if r["status"] == "attention" and r["covered"]),
            **{s: sum(1 for r in rows if r["status"] == s) for s in ("done", "seen")},
        },
        "out_of_scope_count": sum(1 for r in rows if not r["covered"]),
        "latency": _latency_stats(),
    }


# ── 标签页映射（由浏览器扩展上报，仅存内存不落盘）─────────────────────

# ── 标签页组名（由扩展上报，仅存内存不落盘）─────────────────────────

_tab_groups: dict[str, str] = {}
_tab_ids: dict[str, int] = {}       # conversationId -> 扩展给的 tabId，切标签时免查询
# conversationId -> 这个标签在哪个浏览器里（edge/chrome）。两个浏览器都装了扩展时，
# 命令必须发给真正持有该标签的那一个，否则对方找不到就会新开一个标签
_tab_browser: dict[str, str] = {}
# 用户此刻正停留在哪个会话的标签页上（窗口聚焦才算）
_active_tab = {"cid": None, "focused": False, "ts": 0}
# 扩展最近一次上报的时刻：初装引导靠它判断「装好了没有」
_tab_report_at = 0
# 按浏览器分别记：装了 Edge 不代表 Chrome 也装好了，引导要区分
_tab_report_by_browser: dict = {}
# browser -> 扩展自报的「浏览器内取数能力」（hasApi / scripting / pages / registered）
_web_diag: dict = {}


def watching(cid: str, act: dict) -> bool:
    """用户此刻就在这个会话的标签页上看（窗口聚焦、上报不超过 2 分钟）。"""
    return (bool(act.get("focused"))
            and act.get("cid") == str(cid)
            and now_ms() - (act.get("ts") or 0) < 120_000)


def load_active() -> dict:
    """HTTP 进程写、--once 进程读，所以走文件而不是内存。"""
    try:
        with open(ACTIVE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return {"cid": d.get("cid"), "focused": bool(d.get("focused")), "ts": d.get("ts") or 0}
    except Exception:
        return {"cid": None, "focused": False, "ts": 0}


def save_active(act: dict) -> None:
    act["ts"] = now_ms()
    _active_tab.update(act)
    try:
        tmp = ACTIVE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(act, f)
        os.replace(tmp, ACTIVE_FILE)
    except Exception:
        pass


def browser_of(ua: str, declared: str = "") -> str:
    """这次上报来自哪个浏览器。

    优先用扩展自己报的 browser 字段；已经在浏览器里加载的老版本扩展不报这个字段，
    就退回看请求的 User-Agent —— 这样不用让用户去扩展页点「重新加载」。
    """
    b = (declared or "").strip().lower()
    if b and b != "unknown":
        return b
    ua = ua or ""
    if "Edg/" in ua:
        return "edge"
    if "Chrome/" in ua:
        return "chrome"
    return ""


def ingest_tabs(payload: dict, ua: str = "") -> int:
    """payload.tabs = [{url, group, tabId}]，按 URL 里的 conversationId 建映射。"""
    global _tab_report_at
    _tab_report_at = now_ms()
    b = browser_of(ua, payload.get("browser") or "")
    if b:
        _tab_report_by_browser[b] = _tab_report_at
    if isinstance(payload.get("web"), dict):
        _web_diag[b or "?"] = payload["web"]
    act = payload.get("active") or {}
    aurl = act.get("url") or ""
    am = re.search(r"[?&]conversationId=(\d+)", aurl)
    save_active({"cid": am.group(1) if am else None,
                 "focused": bool(act.get("focused"))})

    # 整份快照替换：同一次上报里没出现的会话，说明它的标签已经不在了。
    # 不清理的话旧 tabId 会一直留着，点任务时先「聚焦」到不存在的标签再新开。
    seen: set[str] = set()
    n = 0
    for t in payload.get("tabs") or []:
        url = t.get("url") or ""
        # 只收会话页：同域其它页面即使带 conversationId 也不参与跳转/清理
        if CONV_PAGE_PREFIX and not _is_conv_page(url):
            continue
        m = re.search(r"[?&]conversationId=(\d+)", url)
        if not m:
            continue
        cid = m.group(1)
        tid = t.get("tabId")
        if isinstance(tid, int):
            _tab_ids[cid] = tid
        if b:
            _tab_browser[cid] = b
        seen.add(cid)
        g = (t.get("group") or "").strip()
        if g:
            _tab_groups[cid] = g
        else:
            _tab_groups.pop(cid, None)      # 移出标签组后别再显示旧组名
        n += 1
    # 这次没报上来的会话：标签已关，映射和组名一起作废
    for cid in [c for c in _tab_ids if c not in seen]:
        _tab_ids.pop(cid, None)
        _tab_browser.pop(cid, None)
        _tab_groups.pop(cid, None)
    return n


# ── 打开会话（复用已开标签，否则新开）────────────────────────────────

_edge_tabs = {"ts": 0, "map": {}, "live": set()}

TABS_SCRIPT = """
tell application "%(app)s"
  set out to ""
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set u to ""
      try
        set u to (URL of t as text)
      end try
      if u is missing value then set u to ""
      set out to out & (wi as text) & (ASCII character 9) & (ti as text) & (ASCII character 9) & u & (ASCII character 10)
    end repeat
  end repeat
  return out
end tell
"""

# 会话标签可能开在 Edge 也可能开在 Chrome：缓存与 AppleScript 都按浏览器分开
BROWSER_APP = {"edge": "Microsoft Edge", "chrome": "Google Chrome"}
_tab_caches: dict[str, dict] = {}


def _tabs_cache(app: str) -> dict:
    return _tab_caches.setdefault(app, {"ts": 0, "map": {}, "live": set()})


_edge_tabs = _tabs_cache(BROWSER_APP["edge"])


def snapshot_edge_tabs(timeout: float = 10, app: str = BROWSER_APP["edge"]) -> dict:
    """一次取回该浏览器所有标签的 (窗口序号, 标签序号)，供点击时 O(1) 定位。"""
    try:
        out = subprocess.run(["osascript", "-e", TABS_SCRIPT % {"app": app}],
                             capture_output=True, text=True, timeout=timeout, check=True).stdout
    except Exception:
        return {}
    mapping = {}
    live = set()
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not parts[2].strip():
            continue
        url = parts[2].strip()
        try:
            pos = (int(parts[0]), int(parts[1]))
        except ValueError:
            continue
        mapping[url] = pos
        # 会话 ID 索引：同一会话的 URL 参数可能各不相同（openHistory/formPage 等），
        # 精确比对 URL 会大量 miss 并退回「新开标签」，所以按 conversationId 匹配
        m = re.search(r"[?&]conversationId=(\d+)", url)
        if m:
            mapping["cid:" + m.group(1)] = pos
            live.add(m.group(1))
    cache = _tabs_cache(app)
    cache["map"] = mapping
    cache["live"] = live
    cache["ts"] = now_ms()
    return mapping


FOCUS_TAB_SCRIPT = """
tell application "%(app)s"
  set u to ""
  try
    set u to (URL of tab %(tab)d of window %(win)d as text)
  end try
  if u does not contain "conversationId=%(cid)s" then return "stale"
  set index of window %(win)d to 1
  set active tab index of window %(win)d to %(tab)d
  activate
  return "ok"
end tell
"""

FIND_TAB_SCRIPT = """
tell application "%(app)s"
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set u to ""
      try
        set u to (URL of t as text)
      end try
      if u contains "conversationId=%(cid)s" then
        set index of w to 1
        set active tab index of w to ti
        activate
        return "ok"
      end if
    end repeat
  end repeat
  return "absent"
end tell
"""


def _run_osa(script: str, timeout: float = 6) -> str:
    try:
        done = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
    except Exception:
        return ""
    if done.returncode != 0:
        return ""
    return (done.stdout or "").strip()


def focus_tab(win: int, tab: int, app: str = BROWSER_APP["edge"], cid: str = "") -> bool:
    """切到 (窗口序号, 标签序号)。

    切之前先读一次那个位置的 URL 核对 conversationId：标签开开关关会让缓存的
    序号漂移，直接 set active tab index 就可能停在别人的会话上——看起来就是
    「点了 A 却跳到 B」。核对不上就当 miss，交给 find_tab 重新定位。
    """
    script = FOCUS_TAB_SCRIPT % {"app": app, "win": win, "tab": tab, "cid": cid}
    out = _run_osa(script)
    if out == "ok":
        return True
    if out != "stale":
        log("focus_tab 失败 app=%s win=%s tab=%s: %s" % (app, win, tab, out[:120]))
    return False


def find_tab(cid: str, app: str = BROWSER_APP["edge"]) -> bool:
    """按 conversationId 全量扫一遍再切（缓存 miss / 序号漂移时的兜底）。"""
    return _run_osa(FIND_TAB_SCRIPT % {"app": app, "cid": cid}, timeout=10) == "ok"


# ── 扩展命令通道：长轮询，避免 AppleScript 的一百多毫秒开销 ──────────
# 每个浏览器一个队列：命令只能被「真正持有那个标签」的扩展领走。
# 共用一个队列时，没开该会话的那个浏览器会先领到，然后自己新开一个标签。
_cmd_queues: dict[str, "queue.Queue[dict]"] = {}
_cmd_done: dict[str, float] = {}    # 已经执行或已过期，防止迟到的扩展再执行一次
# 点了任务但还没确认切过去：cmd_id -> (cid, 点击那一刻的 update_ms)
# 只有标签真的切过去才据此标已读，且用点击时的版本判定，新回复不会被顺带吃掉
_open_pending: dict[str, tuple[str, int]] = {}
_cmd_acks: dict[str, float] = {}
# cmd_id -> 扩展回报的执行结果（如 {"result": "closed", "n": 12}）
_cmd_results: dict[str, dict] = {}
_cmd_t0: dict[str, float] = {}      # cmd_id -> 入队时刻，用于量跳转耗时
_cmd_waiters = 0                    # 当前有多少个扩展长轮询正挂着等命令
_cmd_waiters_lock = threading.Lock()
_ext_seen = 0.0          # 扩展最近一次长轮询的时间
_auth_warned = False     # 「密钥不可用、请求放行」的告警只打一次，别刷屏日志


def _confirm_open(cid: str, clicked_update: int) -> None:
    """标签确实切过去了，才算用户「看过这个会话的这一次回复」。

    clicked_update 是点击时的 update_ms：如果这期间又来了新回复（update_ms
    变大），那一次不算读过，留给用户自己看。
    """
    try:
        with _lock:
            state = load_state()
            task = (state.get("tasks") or {}).get(str(cid))
            if not task or task.get("muted"):
                return
            if (task.get("update_ms") or 0) > clicked_update:
                return
            mark_seen(task)
            save_state(state)
    except OSError as exc:
        log(f"标记已读失败 cid={cid}: {exc}")


def _cmd_queue(browser: str) -> "queue.Queue[dict]":
    q = _cmd_queues.get(browser)
    if q is None:
        q = _cmd_queues[browser] = queue.Queue()
    return q


def _cmd_expired(item: dict) -> bool:
    return bool(item.get("expires")) and time.time() * 1000 > item["expires"]


def _open_fallback(cid: str, cmd_id: str) -> None:
    """扩展没在 0.25s 内接走命令时，退回 AppleScript 聚焦（必须执行）。"""
    if _cmd_acks.pop(cmd_id, None) is not None:
        _cmd_done[cmd_id] = time.time()
        return
    # 兜底已经动过手了：命令作废，迟到的扩展即使领到也不要再执行一次
    _cmd_done[cmd_id] = time.time()
    t0 = _cmd_t0.pop(cmd_id, None)
    pending = _open_pending.pop(cmd_id, None)
    try:
        r = open_conversation(cid)
        ms = int((time.time() - t0) * 1000) if t0 else -1
        log("open cid=%s via=applescript(%s) %dms" % (cid, r, ms))
        if r in ("focused", "opened") and pending:
            _confirm_open(*pending)
    except Exception as e:
        log("open fallback failed cid=%s: %s" % (cid, e))


_open_seen: dict[str, float] = {}
_open_guard = threading.Lock()


def open_conversation(cid: str) -> str:
    # 双击会连发两次 /open：1.5 秒内同一会话只处理一次，避免连开两个标签
    with _open_guard:
        now = time.time()
        if now - _open_seen.get(cid, 0) < 1.5:
            return "focused"
        _open_seen[cid] = now

    task = (load_state().get("tasks") or {}).get(cid) or {}
    url = task.get("url")
    if not url:
        return "missing"

    # 这个会话的标签在哪个浏览器里，由扩展上报决定；不知道时就两个都找
    owner = _tab_browser.get(cid) or ""
    app = BROWSER_APP.get(owner, "")
    candidates = [app] if app else [BROWSER_APP["edge"], BROWSER_APP["chrome"]]

    key = "cid:" + cid
    for a in candidates:
        hit = _tabs_cache(a)["map"].get(key)
        if hit and focus_tab(*hit, app=a, cid=cid):
            return "focused"

    # 缓存没命中或序号漂移：让 AppleScript 自己按 conversationId 定位，
    # 成功后刷新该浏览器的快照，后面几次点击还是 O(1)
    for a in candidates:
        if find_tab(cid, app=a):
            snapshot_edge_tabs(timeout=3, app=a)
            return "focused"

    # 兜底新开也要开在「这个会话所在的浏览器」：走系统默认浏览器的话，
    # 会在另一个没登录的浏览器里打开，看起来像是跳错了页面
    log(f"open {cid}: no tab match, falling back to new tab")
    args = ["open"] + (["-a", app] if app else [])
    try:
        done = subprocess.run(args + [url], capture_output=True, timeout=10)
        if done.returncode != 0 and app:
            done = subprocess.run(["open", url], capture_output=True, timeout=10)
        if done.returncode != 0:
            log("open url 失败 cid=%s: %s" % (cid, (done.stderr or b"").decode()[:120]))
            return "failed"
    except Exception as exc:
        log("open url 异常 cid=%s: %s" % (cid, exc))
        return "failed"
    return "opened"


# ── HTTP ────────────────────────────────────────────────────────────

DASHBOARD = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TaskPulse · 会话看板</title>
<style>
 :root{color-scheme:dark;--bg:#101726;--surface:#182337;--edge:#2c3b54;--ink:#edf3fc;--muted:#a7b8d1;
       --blue:#74aeff;--amber:#f6bd68;--red:#ff8580;--green:#62d8ad;--slate:#93a9c6}
 *{box-sizing:border-box}
 body{margin:0;background:radial-gradient(ellipse at top,#1b2b45 0,var(--bg) 48%);
      min-height:100vh;color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
 button{font:inherit;color:inherit;cursor:pointer}
 button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
 .wrap{max-width:900px;margin:auto;padding:48px 24px 64px}
 header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:20px}
 h1{font-size:26px;font-weight:650;letter-spacing:-.035em;margin:0}
 time,.meta{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
 .counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:20px}
 .count,.row{--accent:var(--slate);border:1px solid var(--edge);border-radius:12px;background:var(--surface)}
 .running{--accent:var(--blue)}.attention{--accent:var(--amber)}.stuck{--accent:var(--red)}
 .done{--accent:var(--green)}.unconfirmed{--accent:var(--slate)}
 .count{padding:10px 14px;border-top:2px solid var(--accent);display:flex;gap:4px;flex-direction:column}
 .count span{color:var(--muted);font-size:12px}
 .count output{color:var(--accent);font-size:24px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
 .notice{color:var(--amber);margin:0 0 14px}
 .row{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-right:10px}
 .row:hover,.row:focus-within{border-color:#506684;background:#1c2b42}
 .jump{width:100%;display:grid;grid-template-columns:8px minmax(0,1fr) auto auto 76px;align-items:center;
       text-align:left;gap:12px;border:0;border-radius:10px;background:none;padding:12px}
 .dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
 .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .seen .name,.done .name,.unconfirmed .name{color:#c4d0e2}
 .tag{white-space:nowrap;font-size:11px;padding:2px 7px;border:1px solid var(--edge);
      border-radius:6px;color:var(--accent);background:#111a2a}
 .overdue{color:var(--red)}
 .bar{height:4px;background:#30405b;border-radius:3px;overflow:hidden}
 .bar i{display:block;height:100%;border-radius:3px;background:var(--accent)}
 .deadline{flex:none;border:1px solid var(--edge);border-radius:7px;background:#101a2b;color:var(--muted);
           font-size:12px;padding:4px 7px}
 .deadline:hover{color:var(--ink);border-color:#607797}
 .empty{color:var(--muted);margin:16px 0}
 @media(max-width:560px){
   .wrap{padding:24px 14px 40px}
   .counts{grid-template-columns:repeat(2,minmax(0,1fr))}
   .jump{grid-template-columns:7px minmax(0,1fr) auto;gap:7px}
   .jump .meta,.bar{display:none}
 }
</style>
</head>
<body>
<main class="wrap">
 <header><h1>TaskPulse</h1><time id="sample-time"></time></header>
 <div class="counts">
  <div class="count running"><span>进行中</span><output id="running">—</output></div>
  <div class="count attention"><span>待我处理</span><output id="attention">—</output></div>
  <div class="count stuck"><span>卡住</span><output id="stuck">—</output></div>
  <div class="count done"><span>已完成</span><output id="done">—</output></div>
 </div>
 <p class="notice" id="health" role="status">连接中…</p>
 <p class="notice" id="action-status" role="status" hidden></p>
 <div id="list"></div>
 <p class="empty" id="empty" hidden>暂无任务</p>
</main>
<script>
const labels = {running:"进行中", attention:"待我处理", stuck:"卡住", seen:"已查看", done:"已完成"};
// 本机服务要求带身份头。页面由 / 同源下发，令牌由服务端渲染时填进来（见 Handler._get），
// 所以看板不需要额外开口子，也不必让用户手动贴密钥。
const TP_TOKEN = __TP_TOKEN__;
const TP_HEADERS = {"X-TP-Token": TP_TOKEN};
const counters = ["running", "attention", "stuck", "done"];
const list = document.getElementById("list");
const health = document.getElementById("health");
const rows = new Map();
let pollTimer, lastData, fetching = false, failures = 0;

function element(tag, cls, value = "") {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = value;
  return node;
}

function makeRow(id) {
  const row = element("div", "row");
  const jump = element("button", "jump");
  const name = element("span", "name");
  const tag = element("span", "tag");
  const meta = element("span", "meta");
  const bar = element("span", "bar");
  const progress = document.createElement("i");
  const deadline = element("button", "deadline", "截止");
  jump.type = deadline.type = "button";
  bar.setAttribute("aria-hidden", "true");
  deadline.title = "设置截止时间";
  bar.append(progress);
  jump.append(element("span", "dot"), name, tag, meta, bar);
  jump.addEventListener("click", () => post("/open", id));
  deadline.addEventListener("click", () => setDeadline(id));
  row.append(jump, deadline);
  return {row, name, tag, meta, progress};
}

function showHealth(message, old = false) {
  if (health.textContent !== message) health.textContent = message;
  health.hidden = !message;
  if (old) for (const key of counters) document.getElementById(key).textContent = "—";
}

function render(data, disconnected = false) {
  const old = !data.updated || (Date.now() - data.updated) / 1000 > (data.stale_after_seconds || 180);
  const stale = disconnected || data.poller_error || old;
  const msg = disconnected ? "本机服务连接中断，显示上次快照"
            : data.poller_error ? "上游取数失败，显示上次快照"
            : !data.updated ? "等待首次采样…"
            : old ? "取数暂未更新，显示上次快照"
            : data.stale_count ? data.stale_count + " 个会话状态待确认" : "";
  showHealth(msg, stale);
  health.title = data.poller_error || "";
  if (!stale) for (const key of counters) document.getElementById(key).textContent = data.counts[key];
  document.getElementById("sample-time").textContent = data.updated
    ? "采样于 " + new Date(data.updated).toLocaleTimeString() : "";

  const ids = new Set();
  let position = list.firstElementChild;
  for (const task of data.all) {
    const id = task.id;
    const nodes = rows.get(id) || makeRow(id);
    const known = Object.hasOwn(labels, task.status);
    const status = known ? task.status : "unconfirmed";
    const unconfirmed = task.stale || (stale && (status === "running" || status === "stuck"));
    ids.add(id);
    rows.set(id, nodes);
    if (nodes.row !== position) list.insertBefore(nodes.row, position);
    position = nodes.row.nextElementSibling;
    nodes.row.className = "row " + status + (unconfirmed ? " unconfirmed" : "");
    nodes.name.textContent = task.name;
    nodes.name.title = task.name;
    nodes.tag.textContent = unconfirmed ? "待确认" : labels[status] || "待确认";
    nodes.meta.className = task.overdue ? "meta overdue" : "meta";
    nodes.meta.textContent = task.overdue ? "已超时"
      : status === "running" || (status === "stuck" && !task.failed)
      ? Math.floor(task.elapsed / 60) + "分" + task.elapsed % 60 + "秒"
      : task.failed ? "限流"
      : status === "done" ? "" : task.idle_minutes + " 分钟前";
    nodes.progress.style.width = Math.round(task.progress * 100) + "%";
  }
  for (const [id, nodes] of rows) {
    if (ids.has(id)) continue;
    nodes.row.remove();
    rows.delete(id);
  }
  document.getElementById("empty").hidden = data.all.length > 0 || Boolean(stale);
}

async function post(path, id, minutes) {
  const notice = document.getElementById("action-status");
  notice.hidden = true;
  const params = new URLSearchParams({id});
  if (minutes !== undefined && minutes !== "") params.set("minutes", minutes);
  try {
    const response = await fetch(path + "?" + params, {method:"POST", headers:TP_HEADERS});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error();
    schedule(0);
  } catch {
    notice.textContent = "操作失败，请重试";
    notice.hidden = false;
  }
}

function setDeadline(id) {
  const answer = prompt("几分钟后必须完成？（留空清除）", "30");
  if (answer !== null) void post("/deadline", id, answer.trim());
}

function schedule(delay) {
  clearTimeout(pollTimer);
  if (!document.hidden) pollTimer = setTimeout(tick, delay);
}

async function tick() {
  if (document.hidden || fetching) return;
  fetching = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("/state", {signal:controller.signal, headers:TP_HEADERS});
    if (!response.ok) throw new Error();
    const data = await response.json();
    render(data);
    lastData = data;
    failures = 0;
  } catch {
    failures = Math.min(failures + 1, 3);
    if (lastData) render(lastData, true);
    else showHealth("本机服务连接中断", true);
    health.title = "";
  } finally {
    clearTimeout(timeout);
    fetching = false;
    schedule(3000 * 2 ** failures);
  }
}
document.addEventListener("visibilitychange", () => schedule(0));
schedule(0);
</script>
</body>
</html>
"""


class QuietServer(ThreadingHTTPServer):
    """客户端（App / 扩展）断开连接是常态，不必把 traceback 打到日志里。"""

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        log("请求处理异常：%s: %s" % (type(exc).__name__, exc))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # 不再回 Access-Control-Allow-Origin：调用方是本机原生客户端和同源看板，
        # 谁也不需要 CORS；回 * 等于给任意网页一个读取本机会话标题的机会。
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        # 保留 204 是为了让浏览器干脆地在预检这一步停下（没有 ACAO 就放不出去）；
        # 这里不校验令牌——预检请求带不上自定义头，校验了反而会卡住正常的预检流程。
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def _authorized(self) -> bool:
        """校验 X-TP-Token：只有拿到同一份密钥的本机进程能调这些接口。

        密钥建不出来时一律拒绝（fail-closed）：放行等于把「只有配对客户端能调」
        这条验收标准作废。装机本身坏了应该在安装阶段暴露，而不是在运行时开门。
        日志和 health_check 会明确写出原因，用户照提示重装修复即可。
        """
        global _auth_warned
        expected = read_token()
        if not expected:
            if not _auth_warned:
                _auth_warned = True
                log("本机接口密钥不可用，拒绝请求；检查 ~/.taskpulse 是否可写，或重跑 install.command")
            return False
        given = self.headers.get(TOKEN_HEADER) or ""
        # 常量时间比较：本机进程也可能反复猜，别留时间侧信道
        return bool(given) and hmac.compare_digest(given, expected)

    def _reject(self) -> None:
        self._json({"error": "unauthorized",
                    "hint": "请求头缺少正确的 %s（见 %s）" % (TOKEN_HEADER, TOKEN_FILE)}, 401)

    def do_GET(self) -> None:
        # 看板页是唯一免鉴权的路由：它存在的意义就是先把密钥交给浏览器里的同源脚本，
        # 浏览器又发不出自定义头，自己校验就等于让看板永远打不开。
        path = urlparse(self.path).path
        if path not in ("/", "/index.html") and not self._authorized():
            self._reject()
            return
        self._get()

    def do_POST(self) -> None:
        if not self._authorized():
            self._reject()
            return
        self._post()

    def _get(self) -> None:
        global _ext_seen
        path = urlparse(self.path).path
        if path == "/state":
            self._json(view(load_state()))
        elif path == "/diag":
            self._json({"ext_seen_age": round(time.time() - _ext_seen, 1),
                        "cmd_queue": {b: q.qsize() for b, q in _cmd_queues.items()},
                        # 标签归属：哪几个会话的标签在哪个浏览器里（跳转要按它路由）
                        "tab_owner": dict(_tab_browser),
                        "tab_ids": len(_tab_ids),
                        "watching_cid": _active_tab["cid"],
                        "watching_focused": _active_tab["focused"],
                        "watching_age": round((now_ms() - (_active_tab["ts"] or 0)) / 1000, 1),
                        "web": dict(_web_diag)})
        elif path == "/cmd":
            global _cmd_waiters
            _ext_seen = time.time()
            browser = browser_of(self.headers.get("User-Agent") or "", "")
            q = _cmd_queue(browser)
            with _cmd_waiters_lock:
                _cmd_waiters += 1
            item = None
            deadline = time.monotonic() + 10
            try:
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    try:
                        candidate = q.get(timeout=left)
                    except queue.Empty:
                        break
                    # 兜底已经执行过、或已经过期的命令直接丢掉，别再开一个标签
                    if candidate.get("id") in _cmd_done or _cmd_expired(candidate):
                        continue
                    item = candidate
                    break
            finally:
                with _cmd_waiters_lock:
                    _cmd_waiters -= 1
            if item is None:
                self._send(204, b"", "application/json")
                return
            self._json(item)
        elif path == "/mode":
            # GET 只查询当前来源；切换走 POST（带 value）
            self._json({"ok": True, "source": source_mode()})
        elif path in ("/", "/index.html"):
            # 令牌随页面一起下发（同源）：看板不必再走一次单独取密钥的接口，
            # 也不需要在服务端为它开一个免鉴权的口子。json.dumps 负责转义。
            page = DASHBOARD.replace("__TP_TOKEN__", json.dumps(read_token()))
            self._send(200, page.encode(), "text/html; charset=utf-8")
        else:
            self._json({"error": "not found"}, 404)

    def _post(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        cid = (query.get("id") or [""])[0]

        # Edge 扩展上报标签组名：不碰状态锁，也不落盘
        if parsed.path == "/tabs":
            try:
                ln = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                ln = 0
            raw = self.rfile.read(ln) if ln > 0 else b"{}"
            try:
                n = ingest_tabs(json.loads(raw or b"{}"),
                                self.headers.get("User-Agent") or "")
            except Exception:
                n = 0
            self._json({"ok": True, "mapped": n})
            return

        # 扩展在页面里（用浏览器 cookie）取到的数据：只落盘 + 立即重算一次
        if parsed.path == "/webstate":
            try:
                ln = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                ln = 0
            raw = self.rfile.read(ln) if ln > 0 else b"{}"
            try:
                payload = json.loads(raw or b"{}")
            except Exception:
                payload = None
            if not isinstance(payload, dict):
                self._json({"ok": False, "error": "bad json"}, 400)
                return
            # api 模式下忽略上报，避免两套数据互相覆盖
            if source_mode() != "web":
                self._json({"ok": True, "ignored": "source is api"})
                return
            # 只落盘，不动状态：重算交给常驻循环（它是唯一的写入方，
            # 这样「心跳刷新整份快照」和用户操作互相覆盖的问题一并消失）
            try:
                os.makedirs(os.path.dirname(WEBSTATE_FILE), exist_ok=True)
                # 多个标签页会同时上报，临时文件名带线程号避免互相搬走
                tmp = "%s.%d.tmp" % (WEBSTATE_FILE, threading.get_ident())
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False)
                os.replace(tmp, WEBSTATE_FILE)
            except OSError as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
                return
            _wake.set()
            self._json({"ok": True})
            return

        # 切换数据来源：api / web
        if parsed.path == "/mode":
            mode = (query.get("value") or [""])[0].strip().lower()
            if mode not in ("api", "web"):
                self._json({"ok": False, "error": "value 只能是 api 或 web"}, 400)
                return
            try:
                set_source_mode(mode)
            except OSError as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
                return
            log("数据来源切换为 %s" % mode)
            # 交给常驻循环重排：退避、下一轮时间都由它自己重置，
            # 另起线程再 save 一次会把用户刚做的操作盖掉
            _wake.set()
            self._json({"ok": True, "source": mode})
            return

        # 扩展收到命令并执行完后回报
        if parsed.path == "/cmd/ack":
            _cmd_acks[cid] = time.time()
            _cmd_done[cid] = time.time()
            pending = _open_pending.pop(cid, None)
            # unknown / expired 表示扩展没真正切过去，不能当成「看过了」
            if pending and (query.get("result") or [""])[0] in ("focused", "created"):
                _confirm_open(*pending)
            t0 = _cmd_t0.pop(cid, None)
            how = (query.get("result") or [""])[0]
            try:
                _cmd_results[cid] = {"result": how, "n": int(query.get("n", ["0"])[0])}
            except ValueError:
                _cmd_results[cid] = {"result": how, "n": 0}
            if t0:
                # 带上扩展实际怎么做的：focused 聚焦已有标签、navigated 在现有页面
                # 里切会话、created 新开、expired 命令已过期未执行
                log("open ack id=%s %dms%s" % (cid, int((time.time() - t0) * 1000),
                                               (" via=" + how) if how else ""))
            if len(_cmd_acks) > 200:
                _cmd_acks.clear()
                _cmd_acks[cid] = time.time()
            self._json({"ok": True})
            return

        # /open：优先让扩展用 chrome.tabs 切（毫秒级），失败再退回 AppleScript
        if parsed.path == "/open":
            cmd_id = "%s-%d" % (cid, int(time.time() * 1000))
            task0 = (load_state().get("tasks") or {}).get(cid) or {}
            url0 = task0.get("url")
            owner = _tab_browser.get(cid)
            if (url0 and owner and (time.time() - _ext_seen) < 20 and _cmd_waiters > 0):
                _cmd_t0[cmd_id] = time.time()
                # 记下点击那一刻的回复版本：之后到的新回复不能被这次「已读」吃掉
                _open_pending[cmd_id] = (cid, task0.get("update_ms") or 0)
                _cmd_queue(owner).put({"cmd": "focus", "cid": cid, "url": url0,
                                       "tabId": _tab_ids.get(cid), "id": cmd_id,
                                       "browser": owner,
                                       "expires": int(time.time() * 1000) + 1500})
                threading.Timer(0.25, _open_fallback, args=(cid, cmd_id)).start()
                result = "queued"
            else:
                result = open_conversation(cid)
            # 只有真的把标签切过去了才算读过；入队 / 排队中不算
            if result in ("focused", "opened"):
                _confirm_open(cid, task0.get("update_ms") or 0)
            self._json({"ok": True, "result": result})
            return

        focused = True           # 旧版扩展不带这个字段，按「在前台」处理
        if parsed.path == "/active":
            # 只认「切到某个标签」这一次上报；读请求体时不占状态锁。
            try:
                ln = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(ln)) if ln > 0 else {}
                match = re.search(r"[?&]conversationId=(\d+)", payload.get("url") or "")
                focused = payload.get("focused", True) is not False
            except (AttributeError, TypeError, ValueError):
                match = None
            cid = match.group(1) if match else ""

        deadline = None
        if parsed.path == "/deadline" and query.get("minutes"):
            try:
                deadline = now_ms() + int(float(query["minutes"][0]) * 60_000)
            except (ValueError, OverflowError):
                self._json({"ok": False, "error": "无效的截止时间"}, 400)
                return

        if parsed.path == "/tabs/close":
            mode = (query.get("mode") or ["24h"])[0]
            closed = close_conversation_tabs(mode)
            self._json({"ok": closed is not None, "closed": closed or 0, "mode": mode})
            return

        if parsed.path not in ("/ack", "/unack", "/active", "/deadline", "/important"):
            self._json({"error": "not found"}, 404)
            return

        with _lock:
            state = load_state()
            task = (state.get("tasks") or {}).get(cid)
            changed = bool(task)
            if task:
                if parsed.path == "/ack":
                    mark_seen(task)
                    task.update(status="done", muted=True, running_since=0)
                elif parsed.path == "/unack":
                    if task.get("muted"):
                        task.update(muted=False, archived=False, status="seen",
                                    seen_ms=now_ms(), running_since=0, queue_error=True)
                elif parsed.path == "/active":
                    # 后台窗口里的程序化切标签不算「用户在看」
                    changed = (focused and not task.get("muted")
                               and task.get("status") in ("attention", "stuck"))
                    if changed:
                        mark_seen(task)
                elif parsed.path == "/important":
                    # 用户手动标的「完成后提醒我」：只影响展示与弹窗持久化，
                    # 不参与状态判定，也不改变卡住计时
                    want = (query.get("value") or ["1"])[0] not in ("0", "false", "no")
                    task["important"] = want
                    task["important_at"] = now_ms() if want else 0
                else:
                    task.update(deadline=deadline, deadline_notified=0)
                    _deadline_wake.set()
                if changed:
                    save_state(state)
        self._json({"ok": changed})


# ── 批量关闭会话标签 ────────────────────────────────────────────────

# mode -> 最长空闲小时数；0 表示不看空闲时长，只按「没在工作」筛
CLOSE_TAB_MODES = {"idle": 0, "1h": 1, "6h": 6, "24h": 24}


def closeable_tabs(mode: str) -> list[tuple[str, int]]:
    """挑出可以关标签的会话，返回 [(cid, tabId)]。

    只关「浏览器里有标签」且「没在跑」的会话：正在跑的任务把标签关掉，
    用户就看不到中间过程了。空闲时长按 update_ms 算——那是会话最后一次
    有更新的时刻，比我们自己记录的采样时间更贴近真实。
    """
    hours = CLOSE_TAB_MODES.get(mode, CLOSE_TAB_MODES["24h"])
    stamp = now_ms()
    tasks = load_state().get("tasks") or {}
    out: list[tuple[str, int]] = []
    for cid, tab in list(_tab_ids.items()):
        task = tasks.get(cid) or {}
        if not task:
            continue
        if task.get("status") in ("running", "stuck"):
            continue
        last = max(task.get("update_ms") or 0, task.get("acked_at") or 0)
        if hours and last and stamp - last < hours * 3600_000:
            continue
        out.append((cid, tab))
    return out


def close_conversation_tabs(mode: str) -> int | None:
    """把要关的标签交给扩展执行；返回实际关闭数，扩展不在线返回 None。"""
    targets = closeable_tabs(mode)
    if not targets:
        return 0
    owner = _tab_browser.get(targets[0][0]) or ""
    if not owner or (time.time() - _ext_seen) >= 20 or _cmd_waiters <= 0:
        return None
    cmd_id = "close-%d" % int(time.time() * 1000)
    _cmd_queue(owner).put({
        "cmd": "closeTabs",
        "tabIds": {cid: tab for cid, tab in targets},
        "id": cmd_id,
        "expires": int(time.time() * 1000) + 15000,
    })
    # 等扩展回报实际关了几个；超过 5 秒就当作没关成
    deadline = time.time() + 5
    while time.time() < deadline:
        got = _cmd_results.pop(cmd_id, None)
        if got is not None:
            return int(got.get("n") or 0)
        time.sleep(0.05)
    return 0


# ── 主循环 ──────────────────────────────────────────────────────────

def _watch_parent() -> None:
    """App 拉起时（TP_EXIT_WITH_PARENT=1）：宿主退出后本进程跟着退出。

    父进程消失后会被 reparent 到 launchd，ppid 变成 1——据此判断，
    不需要额外约定 PID 文件。手动在终端跑时不会设这个变量。
    """
    while True:
        time.sleep(2)
        gone = False
        if HOST_PID:
            try:
                os.kill(HOST_PID, 0)      # 只探活，不真发信号
            except ProcessLookupError:
                gone = True
            except PermissionError:
                pass                       # 存在但不属于我们，当作活着
        elif os.getppid() == 1:
            gone = True
        if gone:
            log("宿主 App 已退出，取数服务一并退出")
            os._exit(0)


def poll_loop() -> None:
    lock = take_lock()
    while lock is None:
        log("取数锁被占用，5 秒后重试")
        time.sleep(5)
        lock = take_lock()
    with lock:
        _poll_forever()


def _mark_error(msg: str, retry_seconds: float | None = None,
                auth_required: bool = False) -> None:
    """把取数故障写进 state，UI/诊断能看到「数字不再更新」的原因。

    retry_seconds 是这一轮退避的时长，UI 据此显示「约 N 秒后重试」——
    切模式后短暂取不到数时，用户能判断要不要等，而不是干看着黄条。
    """
    try:
        with _lock:
            state = load_state()
            state["poller_error"] = msg
            state["poller_error_at"] = now_ms()
            if auth_required:
                state["auth_required"] = True
            if retry_seconds:
                state["retry_at"] = now_ms() + int(retry_seconds * 1000)
            else:
                state.pop("retry_at", None)
            save_state(state)
    except OSError as exc:
        log(f"记录取数故障失败：{exc}")


def _check_deadlines() -> None:
    """到点就提醒。只看本机时钟：上游取数连续失败时也必须照常触发。"""
    stamp = now_ms()
    fired: list[tuple[str, str]] = []
    with _lock:
        state = load_state()
        changed = False
        for task in (state.get("tasks") or {}).values():
            deadline_ms = task.get("deadline")
            if task.get("muted") or not deadline_ms or stamp < deadline_ms:
                continue
            if stamp - (task.get("deadline_notified") or 0) < DEADLINE_REMIND_SECONDS * 1000:
                continue
            task["deadline_notified"] = stamp
            changed = True
            fired.append((task.get("name") or "", str(task.get("id"))))
        if changed:
            save_state(state)
    for name, cid in fired:
        notify("任务已超时", f"{name} 超过你设定的时间", cid)


def _deadline_forever() -> None:
    while True:
        try:
            _check_deadlines()
        except (Exception, SystemExit) as exc:   # noqa: BLE001
            log(f"截止时间检查失败：{exc}")
        if _deadline_wake.wait(1.0):
            _deadline_wake.clear()


def _sleep_until(delay: float) -> bool:
    """睡到下次该干活；被唤醒（来源切换、页面新上报）则提前返回 True。

    单独抽成函数是为了让回归测试能接上假时钟——直接调用 time.sleep 的话，
    被替换的 time 模块收不到这次等待，循环会原地卡死。
    """
    return _wake.wait(delay)


def _poll_forever() -> None:
    agent = None
    failures = 0
    next_full = next_fast = time.monotonic()
    next_discovery = next_full if DISCOVERY_POLL_SECONDS else float("inf")
    log(f"取数循环已启动：每 {POLL_SECONDS} 秒全量检查，"
        f"每 {DISCOVERY_POLL_SECONDS} 秒发现新会话/新一轮，"
        f"运行中每 {ACTIVE_POLL_SECONDS} 秒最多复查 {ACTIVE_WATCH_LIMIT} 个，"
        f"已卡住每 {STUCK_POLL_SECONDS} 秒复查一次")
    while True:
        started = time.monotonic()
        full = started >= next_full
        discovery = (not full) and bool(DISCOVERY_POLL_SECONDS) and started >= next_discovery
        try:
            if agent is None or isinstance(agent, WebProvider) != (source_mode() == "web"):
                agent = make_agent()   # 数据来源被切换过
            state = poll_tick(agent, full=full, discovery=discovery)
            failures = 0
            if full:
                next_full = started + POLL_SECONDS
            if DISCOVERY_POLL_SECONDS:
                if full or discovery:
                    next_discovery = started + DISCOVERY_POLL_SECONDS
            next_fast = float("inf")
            if ACTIVE_POLL_SECONDS and ACTIVE_WATCH_LIMIT and any(
                    running(task) or task.get("important")
                    for task in (state.get("tasks") or {}).values()):
                # 标了「完成后提醒我」的空闲会话也要走快循环，
                # 否则 fast_candidates 根本没机会被调用
                next_fast = started + ACTIVE_POLL_SECONDS
            if TP_DEBUG:
                kind = "full" if full else ("discovery" if discovery else "active")
                log("poll %s ok %.1fs" % (kind, time.monotonic() - started))
        except (Exception, SystemExit) as exc:
            auth = False
            # SDK 在拿不到 OBO 票时直接 sys.exit(1)（它本来是给命令行脚本用的）。
            # 我们常驻，这属于「上游凭据暂不可用」——多为客户端没开——不该按自身
            # 故障指数退避到 480 秒，否则用户把客户端打开后还要干等很久。
            if isinstance(exc, SystemExit):
                message = ("本机凭据服务不可用，API 模式暂停取值"
                           "（需要 MyFlicker / CodeFlicker 客户端保持运行且已登录）")
                backoff = POLL_SECONDS
                log(f"取数暂停：{message}，{backoff} 秒后重试")
            elif isinstance(exc, requests.HTTPError) and exc.response is not None \
                    and exc.response.status_code == 401:
                # 401 不等于网络抖动：重试多少次都不会好，只有重新授权能恢复
                failures += 1
                message = ("API 凭据已失效（401）：需要重新扫码授权后才能继续取数")
                backoff = max(POLL_SECONDS, min(60 * 2 ** min(failures - 1, 5), 1800))
                log(f"取数暂停：{message}，{backoff:.0f} 秒后重试")
                auth = True
            else:
                failures += 1
                message = f"{type(exc).__name__}: {exc}"
                backoff = max(POLL_SECONDS, min(60 * 2 ** min(failures - 1, 5), 1800))
                log(f"取数失败：{message}，{backoff} 秒后重试")
            _mark_error(message, backoff, auth_required=auth)
            agent = None
            next_full = time.monotonic() + backoff
            next_discovery = next_full if DISCOVERY_POLL_SECONDS else float("inf")
            next_fast = float("inf")
        # 来源切换或页面新上报会唤醒这里：立刻重排并清掉退避，
        # 否则切过去之后还得等原来的 420 秒退避走完
        delay = max(0.05, min(next_full, next_discovery, next_fast) - time.monotonic())
        if _sleep_until(delay):
            _wake.clear()
            failures = 0
            agent = None
            now = time.monotonic()
            next_full = now
            next_discovery = now if DISCOVERY_POLL_SECONDS else float("inf")
            next_fast = float("inf")


DEMO_TASKS = [
    {"id": 9001, "name": "示例任务 A · 正在跑", "status": "running", "elapsed": 214},
    {"id": 9002, "name": "示例任务 B · 等你处理", "status": "attention", "elapsed": 0},
    {"id": 9003, "name": "示例任务 C · 疑似卡住", "status": "stuck", "elapsed": 734},
    {"id": 9004, "name": "示例任务 D · 已完成", "status": "done", "elapsed": 0},
]


def demo_state() -> dict:
    stamp = now_ms()
    rows = []
    for i, t in enumerate(DEMO_TASKS):
        rows.append({
            "id": t["id"], "name": t["name"], "status": t["status"],
            "progress": 1.0 if t["status"] in ("attention", "done")
                        else min(t["elapsed"] / 600, 1.0),
            "elapsed": t["elapsed"], "updated_ms": stamp - i * 60_000,
            "idle_minutes": 3 + i, "url": None, "deadline": None,
            "deadline_left": None, "overdue": t["status"] == "stuck",
        })
    order = {"stuck": 0, "attention": 1, "running": 2, "done": 3}
    rows.sort(key=lambda r: (order[r["status"]], -r["progress"]))
    return {
        "updated": stamp, "stuck_seconds": 600, "window_limit": 10,
        "tasks": [r for r in rows if r["status"] != "done"],
        "active": [r for r in rows if r["status"] != "done"],
        "all": rows,
        "counts": {s: sum(1 for r in rows if r["status"] == s)
                   for s in ("running", "stuck", "attention", "done")},
    }


def take_lock():
    """同一时刻只允许一个取数进程，避免重叠。"""
    path = os.path.join(os.path.dirname(STATE_FILE), "poll.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = open(path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fh
    except OSError:
        fh.close()
        return None


def config_problem() -> str:
    """返回一句「为什么现在跑不了」；空字符串表示配置可用。"""
    if CONFIG_ERROR:
        return CONFIG_ERROR
    if not HOST:
        return "platform.base_url 未配置"
    if not AGENT_IDS and "{agent_ids}" in json.dumps(PLATFORM.get("conversations_body") or {}):
        return "platform.agent_ids 未配置，但 conversations_body 引用了 {agent_ids}"
    return ""


def main() -> int:
    problem = config_problem()
    if problem and "--demo" not in sys.argv:
        log("配置不可用：" + problem)
        print("TaskPulse 还不能开始工作：\n  " + problem
              + "\n\n请编辑 %s 后重试，或重新运行安装脚本生成配置。\n"
                "只想看看界面长什么样，可以运行：poller.py --demo" % CONFIG_FILE,
              file=sys.stderr)
        return 2

    # 先把身份密钥准备好：所有 HTTP 路由都要它，缺文件就现生成，
    # 免得「装完少一个文件」直接变成整个界面不可用。
    ensure_token()

    if "--demo" in sys.argv:
        class DemoHandler(Handler):
            # 只替换路由分发，鉴权留在 Handler.do_GET/do_POST 里，别被示例模式绕过去
            def _get(self):
                if urlparse(self.path).path == "/state":
                    self._json(demo_state())
                else:
                    super()._get()

            def _post(self):
                parsed = urlparse(self.path)
                if parsed.path == "/open":
                    self._json({"ok": True, "result": "demo"})
                else:
                    self._json({"ok": True})
        server = QuietServer(("127.0.0.1", PORT), DemoHandler)
        log(f"TaskPulse DEMO on http://127.0.0.1:{PORT}")
        server.serve_forever()
        return 0

    if "--once" in sys.argv:
        lock = take_lock()
        if lock is None:
            return 0
        with lock:
            state = poll_tick(make_agent(), full=True)
        print(json.dumps(view(state), ensure_ascii=False, indent=1))
        return 0

    # 取数循环常驻本进程：省掉每次都启动解释器的开销，也复用已建立的会话（少换 token）
    server = QuietServer(("127.0.0.1", PORT), Handler)
    if EXIT_WITH_PARENT:
        threading.Thread(target=_watch_parent, name="parent", daemon=True).start()
    threading.Thread(target=poll_loop, name="poller", daemon=True).start()
    threading.Thread(target=_deadline_forever, name="deadline", daemon=True).start()
    log(f"TaskPulse serving on http://127.0.0.1:{PORT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
