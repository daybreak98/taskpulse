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
import importlib
import inspect
import json
import os
import re
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
        "active_interval_seconds": 10,
        "active_watch_limit": 2,
        "watch_limit": 20,
        "stuck_seconds": 600,
        "window_limit": 10,
        "archive_hours": 48,
    },
    "ui": {"port": 8899},
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
    return _apply_env(_deep_merge(cfg, user)), ""


CFG, CONFIG_ERROR = _load_config()
PLATFORM = CFG["platform"]
HOST = (PLATFORM.get("base_url") or "").rstrip("/")
API = HOST + (PLATFORM.get("api_prefix") or "")
PORT = int(CFG["ui"]["port"])
AGENT_IDS = list(PLATFORM.get("agent_ids") or [])
POLL_SECONDS = max(1, int(CFG["poll"]["interval_seconds"]))
TP_DEBUG = os.environ.get("TP_DEBUG") == "1"
WATCH_LIMIT = max(0, int(CFG["poll"]["watch_limit"]))
ACTIVE_POLL_SECONDS = max(0, int(CFG["poll"]["active_interval_seconds"]))
ACTIVE_WATCH_LIMIT = min(WATCH_LIMIT, max(0, int(CFG["poll"]["active_watch_limit"])))
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


def notify(title: str, body: str) -> None:
    script = 'display notification %s with title %s' % (
        json.dumps(body, ensure_ascii=False), json.dumps(title, ensure_ascii=False))
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)
    except Exception:
        pass


# ── 存储 ────────────────────────────────────────────────────────────

_lock = threading.Lock()


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
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


# ── 状态机 ──────────────────────────────────────────────────────────

class QueueSample(NamedTuple):
    at: int
    busy: bool | None
    raw: str | int | None = None
    checked_reply: str | None = None
    failed: bool | None = None


def running(task: dict) -> bool:
    return not task.get("muted") and bool(task.get("running_since"))


def fast_candidates(tasks: dict, stamp: int) -> list[dict]:
    if not ACTIVE_POLL_SECONDS or not ACTIVE_WATCH_LIMIT:
        return []
    retry_ms = max(ACTIVE_POLL_SECONDS, min(POLL_SECONDS, 60)) * 1000
    eligible = [task for task in tasks.values() if running(task)
                and (not task.get("queue_error") or stamp - (task.get("queue_checked_at") or 0) >= retry_ms)]
    # 最久没检查的先查，避免同一批任务一直占满快速复查的名额。
    eligible.sort(key=lambda task: task.get("queue_checked_at") or 0)
    return [{"id": task["id"], "updateTime": task.get("update_ms") or 0}
            for task in eligible[:ACTIVE_WATCH_LIMIT]]


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
            samples[cid] = QueueSample(now_ms(), busy, raw)
        except Exception as exc:
            if isinstance(exc, requests.HTTPError) and exc.response is not None:
                if exc.response.status_code in (401, 403, 429):
                    raise  # 认证或限流故障暂停整轮，避免继续发请求
            log(f"queue {cid} failed: {exc}")
            samples[cid] = QueueSample(now_ms(), None)

    if not FAIL_MARKS:
        return samples
    for conv in convs:
        cid = str(conv["id"])
        sample = samples.get(cid)
        task = tasks.get(cid)
        if not sample or sample.busy is not False or not task:
            continue
        reply = pending_reply(task, conv["updateTime"], sample.at)
        if not reply or task.get("classified_reply") == reply:
            continue
        if task.get("message_reply") == reply and task.get("message_attempts", 0) >= 2:
            continue
        timeout = request_timeout(deadline)
        if timeout < 0.25:
            break
        failed = None
        try:
            message = agent.last_message(conv["id"], timeout)
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
                       notifications: list[tuple[str, str]]) -> None:
    task["queue_checked_at"] = sample.at
    task["queue_error"] = sample.busy is None
    if sample.busy is None:
        return
    task["queue_observed_at"] = sample.at
    task["raw_state"] = sample.raw

    started = task.get("running_since") or 0
    if sample.busy:
        if not started:
            started = sample.at
            task["running_since"] = started
        task["failed"] = False
        task["reply_pending"] = False
        elapsed = (sample.at - started) // 1000
        task["status"] = "stuck" if elapsed >= DEFAULT_STUCK_SECONDS else "running"
        if task["status"] == "stuck" and task.get("stuck_notified") != started:
            task["stuck_notified"] = started
            notifications.append(("任务疑似卡住", f"{task['name']} 已运行 {elapsed // 60} 分钟，去看看"))
        return

    update = task["update_ms"]
    reply = pending_reply(task, update, sample.at)
    task["running_since"] = 0
    task["stuck_notified"] = 0

    if not reply:
        if update <= (task.get("reply_completed_at") or 0):
            task["acked_update"] = max(update, task.get("acked_update") or 0)
        if task.get("status") in ("running", "attention", "stuck"):
            task["prev"] = task["status"]
        task["status"] = "seen"
        task["failed"] = False
        task["reply_pending"] = False
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
        if sample.failed is not None:
            task["classified_reply"] = reply
            task["failed"] = sample.failed
    task["status"] = "stuck" if task.get("failed") else "attention"

    if task["status"] == "attention" and watching(str(task["id"]), act):
        mark_seen(task)


def poll_tick(agent: AgentClient, *, full: bool) -> dict:
    deadline = time.monotonic() + ROUND_BUDGET_SECONDS
    base = load_state()
    tasks = base.get("tasks") or {}
    stamp = now_ms()
    if full:
        conversations = agent.conversations(request_timeout(deadline))[:WATCH_LIMIT]
        # 慢请求耗尽预算时，下轮先补最久未检查的会话。
        conversations.sort(key=lambda conv: tasks.get(str(conv["id"]), {}).get("queue_checked_at") or 0)
    else:
        conversations = fast_candidates(tasks, stamp)
    samples = sample_queues(agent, conversations, tasks, deadline)
    if not full and not samples:
        return base

    notifications: list[tuple[str, str]] = []
    with _lock:
        state = load_state()
        tasks = state.setdefault("tasks", {})
        act = load_active()
        stamp = now_ms()
        for conv in conversations:
            cid = str(conv["id"])
            update = conv["updateTime"]
            task = tasks.get(cid)
            if full:
                if task is None:
                    task = tasks[cid] = {"status": "seen", "prev": "running", "acked_update": update}
                task.setdefault("queue_observed_at", task.get("seen_ms") or 0)
                task.update(id=conv["id"], name=conv.get("name") or f"会话 {cid}",
                            agent_id=conv.get("agentId") or (AGENT_IDS[0] if AGENT_IDS else ""),
                            update_ms=update, seen_ms=stamp)
                task["url"] = conv_url(task["agent_id"], cid)
                if task.get("archived") and update > (task.get("acked_update") or 0):
                    task.update(archived=False, muted=False, auto_archived=0, prev="running", status="seen")
            if not task:
                continue
            if task.get("muted"):
                task["status"] = "done"
                continue
            sample = samples.get(cid)
            if sample is not None and (full or running(task)):
                apply_queue_sample(task, sample, act, notifications)

        for task in tasks.values():
            deadline_ms = task.get("deadline")
            if task.get("muted") or not deadline_ms or stamp < deadline_ms:
                continue
            if stamp - (task.get("deadline_notified") or 0) >= DEADLINE_REMIND_SECONDS * 1000:
                task["deadline_notified"] = stamp
                notifications.append(("任务已超时", f"{task['name']} 超过你设定的时间"))

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
        if full or any(sample.busy is not None for sample in samples.values()):
            state["updated"] = stamp
        save_state(state)

    for title, body in notifications:
        notify(title, body)
    if full and sys.platform == "darwin":
        snapshot_edge_tabs(timeout=2)
    return state


# ── 视图 ────────────────────────────────────────────────────────────

def view(state: dict) -> dict:
    limit = DEFAULT_WINDOW_LIMIT
    stuck = DEFAULT_STUCK_SECONDS
    stamp = now_ms()
    stale_after_seconds = max(POLL_SECONDS * 2, 45)

    rows = []
    for task in (state.get("tasks") or {}).values():
        if task.get("archived"):
            continue
        if (not task.get("muted")) and task.get("status") == "done" and stamp - (task.get("seen_ms") or 0) > 6 * 3600_000:
            continue
        observed = task.get("queue_observed_at", task.get("seen_ms")) or 0
        stale = task.get("status") != "done" and (
            bool(task.get("queue_error")) or not observed
            or (running(task) and stamp - observed > stale_after_seconds * 1000))
        started = task.get("running_since") or 0
        elapsed = max(0, ((observed if stale else stamp) - started) // 1000) if started else 0
        progress = 1.0 if task.get("status") in ("attention", "done") else min(elapsed / stuck, 1.0)
        rows.append({
            "id": task["id"],
            "name": task.get("name"),
            "group": _tab_groups.get(str(task["id"]), ""),
            "status": task.get("status"),
            "prev": task.get("prev"),
            "reply_version": task.get("reply_version"),
            "stale": stale,
            "progress": round(progress, 3),
            "elapsed": elapsed,
            "updated_ms": task.get("update_ms"),
            "idle_minutes": int((stamp - (task.get("update_ms") or stamp)) / 60000),
            "url": task.get("url"),
            "deadline": task.get("deadline"),
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
    live = _edge_tabs.get("live") or set()
    live_fresh = bool(_edge_tabs.get("ts")) and stamp - _edge_tabs["ts"] < 300_000

    def visible(r):
        if r["status"] == "done":
            return False
        if r["status"] == "seen":
            return (not live_fresh) or (str(r["id"]) in live)
        return True

    active = [r for r in rows if visible(r)]
    return {
        "updated": state.get("updated"),
        "poller_error": state.get("poller_error"),
        "poller_error_at": state.get("poller_error_at"),
        "stale_after_seconds": stale_after_seconds,
        "stale_count": sum(1 for r in rows if r["stale"]),
        "stuck_seconds": stuck,
        "window_limit": limit,
        "tasks": active[:limit],
        "active": active,
        "all": rows,
        "counts": {
            **{s: sum(1 for r in rows if r["status"] == s and not r["stale"])
               for s in ("running", "stuck")},
            **{s: sum(1 for r in rows if r["status"] == s) for s in ("attention", "done", "seen")},
        },
    }


# ── 标签页组名（由 Edge 扩展上报，仅存内存不落盘）─────────────────────

_tab_groups: dict[str, str] = {}
_tab_ids: dict[str, int] = {}       # conversationId -> 扩展给的 tabId，切标签时免查询
# 用户此刻正停留在哪个会话的标签页上（窗口聚焦才算）
_active_tab = {"cid": None, "focused": False, "ts": 0}


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


def ingest_tabs(payload: dict) -> int:
    """payload.tabs = [{url, group, tabId}]，按 URL 里的 conversationId 建映射。"""
    act = payload.get("active") or {}
    aurl = act.get("url") or ""
    am = re.search(r"[?&]conversationId=(\d+)", aurl)
    save_active({"cid": am.group(1) if am else None,
                 "focused": bool(act.get("focused"))})

    n = 0
    for t in payload.get("tabs") or []:
        url = t.get("url") or ""
        m = re.search(r"[?&]conversationId=(\d+)", url)
        if not m:
            continue
        cid = m.group(1)
        tid = t.get("tabId")
        if isinstance(tid, int):
            _tab_ids[cid] = tid
        g = (t.get("group") or "").strip()
        if not g:
            continue
        _tab_groups[cid] = g
        n += 1
    return n


# ── 打开会话（复用已开标签，否则新开）────────────────────────────────

_edge_tabs = {"ts": 0, "map": {}, "live": set()}

EDGE_TABS_SCRIPT = """
tell application "Microsoft Edge"
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


def snapshot_edge_tabs(timeout: float = 10) -> dict:
    """一次取回所有标签的 (窗口序号, 标签序号)，供点击时 O(1) 定位。"""
    try:
        out = subprocess.run(["osascript", "-e", EDGE_TABS_SCRIPT],
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
    _edge_tabs["map"] = mapping
    _edge_tabs["live"] = live
    _edge_tabs["ts"] = now_ms()
    return mapping


def focus_tab(win: int, tab: int) -> bool:
    """一次 AppleScript 精确切到某窗口的第 N 个标签，不遍历。"""
    script = (
        'tell application "Microsoft Edge"\n'
        f'  set index of window {win} to 1\n'
        f'  set active tab index of window {win} to {tab}\n'
        '  activate\n'
        'end tell'
    )
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=6)
        return True
    except Exception:
        return False


# ── 扩展命令通道：长轮询，避免 AppleScript 的一百多毫秒开销 ──────────
_cmd_q: "queue.Queue[dict]" = queue.Queue()
_cmd_acks: dict[str, float] = {}
_cmd_t0: dict[str, float] = {}      # cmd_id -> 入队时刻，用于量跳转耗时
_cmd_waiters = 0                    # 当前有多少个扩展长轮询正挂着等命令
_cmd_waiters_lock = threading.Lock()
_ext_seen = 0.0          # 扩展最近一次长轮询的时间


def _open_fallback(cid: str, cmd_id: str) -> None:
    """扩展没在 0.25s 内接走命令时，退回 AppleScript 聚焦（必须执行）。"""
    if _cmd_acks.pop(cmd_id, None) is not None:
        return
    t0 = _cmd_t0.pop(cmd_id, None)
    try:
        r = open_conversation(cid)
        ms = int((time.time() - t0) * 1000) if t0 else -1
        log("open cid=%s via=applescript(%s) %dms" % (cid, r, ms))
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

    key = "cid:" + cid
    hit = _edge_tabs["map"].get(key)
    if hit and focus_tab(*hit):
        return "focused"

    # 缓存没命中：刷新一次全量再试（仍只调一次 AppleScript）
    fresh = snapshot_edge_tabs()
    hit = fresh.get(key) or fresh.get(url)
    if hit and focus_tab(*hit):
        return "focused"

    log(f"open {cid}: no tab match, falling back to new tab")
    subprocess.run(["open", url], check=False)
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
    const response = await fetch(path + "?" + params, {method:"POST"});
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
    const response = await fetch("/state", {signal:controller.signal});
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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def do_GET(self) -> None:
        global _ext_seen
        path = urlparse(self.path).path
        if path == "/state":
            self._json(view(load_state()))
        elif path == "/diag":
            self._json({"ext_seen_age": round(time.time() - _ext_seen, 1),
                        "cmd_queue": _cmd_q.qsize(),
                        "watching_cid": _active_tab["cid"],
                        "watching_focused": _active_tab["focused"],
                        "watching_age": round((now_ms() - (_active_tab["ts"] or 0)) / 1000, 1)})
        elif path == "/cmd":
            global _cmd_waiters
            _ext_seen = time.time()
            with _cmd_waiters_lock:
                _cmd_waiters += 1
            item = None
            try:
                item = _cmd_q.get(timeout=10)
            except queue.Empty:
                pass
            finally:
                with _cmd_waiters_lock:
                    _cmd_waiters -= 1
            if item is None:
                self._send(204, b"", "application/json")
                return
            self._json(item)
        elif path in ("/", "/index.html"):
            self._send(200, DASHBOARD.encode(), "text/html; charset=utf-8")
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
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
                n = ingest_tabs(json.loads(raw or b"{}"))
            except Exception:
                n = 0
            self._json({"ok": True, "mapped": n})
            return

        # 扩展收到命令并执行完后回报
        if parsed.path == "/cmd/ack":
            _cmd_acks[cid] = time.time()
            t0 = _cmd_t0.pop(cid, None)
            if t0:
                log("open ack id=%s %dms" % (cid, int((time.time() - t0) * 1000)))
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
            if url0 and (time.time() - _ext_seen) < 20 and _cmd_waiters > 0:
                _cmd_t0[cmd_id] = time.time()
                _cmd_q.put({"cmd": "focus", "cid": cid, "url": url0,
                            "tabId": _tab_ids.get(cid), "id": cmd_id})
                threading.Timer(0.25, _open_fallback, args=(cid, cmd_id)).start()
                result = "queued"
            else:
                result = open_conversation(cid)
            if result in ("focused", "opened", "queued"):
                with _lock:
                    state = load_state()
                    task = (state.get("tasks") or {}).get(cid)
                    if task and not task.get("muted"):
                        mark_seen(task)
                        save_state(state)
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

        if parsed.path not in ("/ack", "/unack", "/active", "/deadline"):
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
                else:
                    task.update(deadline=deadline, deadline_notified=0)
                if changed:
                    save_state(state)
        self._json({"ok": changed})


# ── 主循环 ──────────────────────────────────────────────────────────

def poll_loop() -> None:
    lock = take_lock()
    while lock is None:
        log("取数锁被占用，5 秒后重试")
        time.sleep(5)
        lock = take_lock()
    with lock:
        _poll_forever()


def _mark_error(msg: str) -> None:
    """把取数故障写进 state，UI/诊断能看到「数字不再更新」的原因。"""
    try:
        with _lock:
            state = load_state()
            state["poller_error"] = msg
            state["poller_error_at"] = now_ms()
            save_state(state)
    except OSError as exc:
        log(f"记录取数故障失败：{exc}")


def _poll_forever() -> None:
    agent = None
    failures = 0
    next_full = next_fast = time.monotonic()
    log(f"取数循环已启动：每 {POLL_SECONDS} 秒全量检查，"
        f"运行中每 {ACTIVE_POLL_SECONDS} 秒最多复查 {ACTIVE_WATCH_LIMIT} 个")
    while True:
        started = time.monotonic()
        full = started >= next_full
        try:
            if agent is None:
                agent = AgentClient()
            state = poll_tick(agent, full=full)
            failures = 0
            if full:
                next_full = started + POLL_SECONDS
            next_fast = float("inf")
            if ACTIVE_POLL_SECONDS and ACTIVE_WATCH_LIMIT and any(
                    running(task) for task in (state.get("tasks") or {}).values()):
                next_fast = started + ACTIVE_POLL_SECONDS
            if TP_DEBUG:
                log("poll %s ok %.1fs" % ("full" if full else "active", time.monotonic() - started))
        except (Exception, SystemExit) as exc:
            failures += 1
            message = f"{type(exc).__name__}: {exc}"
            backoff = max(POLL_SECONDS, min(60 * 2 ** min(failures - 1, 5), 1800))
            log(f"取数失败：{message}，{backoff} 秒后重试")
            _mark_error(message)
            agent = None
            next_full = time.monotonic() + backoff
            next_fast = float("inf")
        time.sleep(max(0.05, min(next_full, next_fast) - time.monotonic()))


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

    if "--demo" in sys.argv:
        class DemoHandler(Handler):
            def do_GET(self):
                if urlparse(self.path).path == "/state":
                    self._json(demo_state())
                else:
                    super().do_GET()

            def do_POST(self):
                parsed = urlparse(self.path)
                if parsed.path == "/open":
                    self._json({"ok": True, "result": "demo"})
                else:
                    self._json({"ok": True})
        server = ThreadingHTTPServer(("127.0.0.1", PORT), DemoHandler)
        log(f"TaskPulse DEMO on http://127.0.0.1:{PORT}")
        server.serve_forever()
        return 0

    if "--once" in sys.argv:
        lock = take_lock()
        if lock is None:
            return 0
        with lock:
            state = poll_tick(AgentClient(), full=True)
        print(json.dumps(view(state), ensure_ascii=False, indent=1))
        return 0

    # 取数循环常驻本进程：省掉每次都启动解释器的开销，也复用已建立的会话（少换 token）
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=poll_loop, name="poller", daemon=True).start()
    log(f"TaskPulse serving on http://127.0.0.1:{PORT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
