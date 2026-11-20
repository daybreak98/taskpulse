#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.31.0,<3"]
# ///
"""TaskPulse —— 桌面角落的 Agent 会话监视器（后台服务）。

每 60 秒拉一次会话列表与队列快照，维护四态：
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
POLL_SECONDS = int(CFG["poll"]["interval_seconds"])
TP_DEBUG = os.environ.get("TP_DEBUG") == "1"
_fail_count = 0
WATCH_LIMIT = int(CFG["poll"]["watch_limit"])   # 只对最近更新的 N 个会话查队列
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

    def _post(self, path: str, body: dict) -> dict:
        r = self.session.request("POST", API + path, json=body, timeout=25)
        return r.json()

    def _get(self, path: str) -> dict:
        r = self.session.request("GET", API + path, timeout=25)
        return r.json()

    def conversations(self) -> list[dict]:
        data = self._post(self.ep_conversations, self.body).get("data") or {}

        items: list[dict] = []
        for group in data.get("groups") or []:
            gname = group.get("name") or ""
            for conv in group.get("conversations") or []:
                conv = dict(conv)
                conv["groupName"] = gname
                items.append(conv)
        for conv in (data.get("ungrouped") or {}).get("conversations") or []:
            conv = dict(conv)
            conv.setdefault("groupName", "")
            items.append(conv)

        seen, out = set(), []
        for c in items:
            cid = c.get("id")
            if not cid or cid in seen:
                continue
            seen.add(cid)
            out.append(c)
        out.sort(key=lambda c: c.get("updateTime") or 0, reverse=True)
        return out

    def queue(self, cid: int) -> dict:
        try:
            return self._get(self.ep_queue.format(cid=cid)).get("data") or {}
        except Exception as exc:  # noqa: BLE001
            log(f"queue {cid} failed: {exc}")
            return {}

    def last_message(self, cid: int) -> dict:
        """只取最后一条消息（体积小），用于识别「限流失败」这类停摆而不是交付。"""
        try:
            r = self._get(self.ep_messages.format(cid=cid))
            lst = (r.get("data") or {}).get(self.list_key) or []
            return lst[0] if lst else {}
        except Exception as exc:  # noqa: BLE001
            log(f"last_message {cid} failed: {exc}")
            return {}


# ── 状态机 ──────────────────────────────────────────────────────────

def refresh(state: dict, agent: AgentClient) -> dict:
    cfg = state.setdefault("config", {})
    cfg.setdefault("stuck_seconds", DEFAULT_STUCK_SECONDS)
    cfg.setdefault("window_limit", DEFAULT_WINDOW_LIMIT)
    tasks = state.setdefault("tasks", {})

    convs = agent.conversations()
    stamp = now_ms()
    act = load_active()

    for conv in convs[:WATCH_LIMIT]:
        cid = str(conv["id"])
        is_new = cid not in tasks
        task = tasks.get(cid) or {"acked_update": 0, "notified_update": 0,
                                  "stuck_notified": 0, "deadline_notified": 0,
                                  "deadline": None, "running_since": 0, "muted": False}
        task.update({
            "id": conv["id"],
            "name": conv.get("name") or f"会话 {conv['id']}",
            "agent_id": conv.get("agentId") or (AGENT_IDS[0] if AGENT_IDS else ""),
            "update_ms": conv.get("updateTime") or 0,
        })
        if is_new:
            # 首次见到该会话视为「已查看」，避免历史任务一次性刷满小窗；
            # 标签页还开着就继续以暗色留在列表里
            task["acked_update"] = conv.get("updateTime") or 0
            task["prev"] = "running"
            task["status"] = "seen"
        elif task.get("archived") and (conv.get("updateTime") or 0) > (task.get("acked_update") or 0):
            # 归档之后会话又有了新动作：解除归档，回到「已查看」暗色行
            task["archived"] = False
            task["muted"] = False
            task["auto_archived"] = 0
            task["prev"] = "running"
            task["status"] = "seen"
            log("unarchive id=%s %s" % (cid, task.get("name")))
        task["url"] = conv_url(task["agent_id"], cid)

        if task.get("status") == "seen" and task.get("prev") not in ("running", "attention", "stuck"):
            task["prev"] = "running"   # 兼容旧数据/无效值：默认归入「进行中」

        if task.get("muted"):
            # 已手动确认完成：不再拉队列、不再改状态，等用户取消勾选
            task["status"] = "done"
            task["seen_ms"] = stamp
            tasks[cid] = task
            continue

        q = agent.queue(conv["id"])
        raw = q.get(agent.f_state)
        task["raw_state"] = raw
        pending = q.get(agent.f_pending) if agent.f_pending else None
        busy = bool(pending) or (raw not in ((None,) + agent.idle))

        if busy:
            task["failed"] = False   # 又跑起来了（多半是在重试），先撤销失败标记
            if not task.get("running_since"):
                task["running_since"] = stamp
            elapsed = (stamp - task["running_since"]) // 1000
            task["status"] = "stuck" if elapsed >= cfg["stuck_seconds"] else "running"
            if task["status"] == "stuck" and task["stuck_notified"] != task["running_since"]:
                task["stuck_notified"] = task["running_since"]
                notify("任务疑似卡住",
                       f"{task['name']} 已运行 {elapsed // 60} 分钟，去看看")
        else:
            was_active = task.get("running_since") or 0
            task["running_since"] = 0
            task.pop("stuck_notified", None)
            task["stuck_notified"] = 0
            fresh = task["update_ms"] > (task.get("acked_update") or 0)
            lasted = (stamp - was_active) // 1000 if was_active else 0
            if not fresh and lasted >= 20:
                fresh = True   # 跑过一阵子才停，即便 updateTime 没变也算有新回复
            if fresh:
                upd = task["update_ms"]
                # 每个新回复只验一次：拉最后一条消息，看是不是「限流失败」而不是交付
                if task.get("checked_update") != upd:
                    m = agent.last_message(conv["id"])
                    txt = (m.get("content") or "") if m.get("sender") == "assistant" else ""
                    if txt:
                        task["checked_update"] = upd
                        if any(k in txt for k in FAIL_MARKS):
                            task["failed_update"] = upd
                            log("rate limited id=%s %s" % (cid, task.get("name")))
                if task.get("failed_update") == upd:
                    # agent 已停下但这一轮是被限流打断的 → 按「卡住」标红，提醒重试
                    task["status"] = "stuck"
                    task["failed"] = True
                else:
                    task["status"] = "attention"
                    task["failed"] = False
                if was_active and task.get("notified_update") != task["update_ms"]:
                    task["notified_update"] = task["update_ms"]
                    # 弹窗改由浮窗自己弹（可点击跳转），这里不再发系统通知
            else:
                cur = task.get("status")
                if cur in ("running", "attention", "stuck"):
                    task["prev"] = cur
                elif task.get("prev") not in ("running", "attention", "stuck"):
                    task["prev"] = "running"
                task["status"] = "seen"
                task["failed"] = False

        # 用户此刻正停在这个标签页上看（窗口聚焦）→ 回复直接算已读，不计数、不弹提示
        if task["status"] == "attention" and watching(cid, act):
            task["prev"] = "attention"
            task["status"] = "seen"
            task["acked_update"] = task.get("update_ms") or 0
            task["acked_at"] = stamp
            log("auto seen id=%s (正在看的标签页)" % cid)

        deadline = task.get("deadline")
        if deadline and task["status"] != "done" and stamp > deadline:
            if stamp - (task.get("deadline_notified") or 0) > DEADLINE_REMIND_SECONDS * 1000:
                task["deadline_notified"] = stamp
                notify("任务已超时", f"{task['name']} 超过你设定的时间")
            task["overdue"] = True
        else:
            task["overdue"] = False

        task["seen_ms"] = stamp
        tasks[cid] = task

    # 「已查看」超过 AUTO_ARCHIVE_HOURS 没有任何新进展 → 自动归档（等同勾选），移出列表
    for cid in list(tasks):
        t = tasks[cid]
        if t.get("status") != "seen" or t.get("muted") or t.get("archived"):
            continue
        last = max(t.get("update_ms") or 0, t.get("acked_update") or 0)
        if last and stamp - last > AUTO_ARCHIVE_HOURS * 3600_000:
            t["muted"] = True
            t["archived"] = True
            t["status"] = "done"
            t["auto_archived"] = stamp
            log("auto archive id=%s idle=%dh %s"
                % (cid, int((stamp - last) / 3600_000), t.get("name")))

    # 清理长时间不动的已完成任务，避免文件膨胀
    for cid in list(tasks):
        t = tasks[cid]
        if t.get("status") in ("done", "seen") and stamp - (t.get("seen_ms") or 0) > 7 * 86400_000:
            del tasks[cid]

    state["updated"] = stamp
    try:
        snapshot_edge_tabs()
    except Exception:
        pass
    return state


# ── 视图 ────────────────────────────────────────────────────────────

def view(state: dict) -> dict:
    cfg = state.get("config") or {}
    limit = cfg.get("window_limit") or DEFAULT_WINDOW_LIMIT
    stuck = cfg.get("stuck_seconds") or DEFAULT_STUCK_SECONDS
    stamp = now_ms()

    rows = []
    for task in (state.get("tasks") or {}).values():
        if task.get("archived"):
            continue
        if (not task.get("muted")) and task.get("status") == "done" and stamp - (task.get("seen_ms") or 0) > 6 * 3600_000:
            continue
        elapsed = 0
        if task.get("running_since"):
            elapsed = (stamp - task["running_since"]) // 1000
        progress = 1.0 if task.get("status") in ("attention", "done") else min(elapsed / stuck, 1.0)
        rows.append({
            "id": task["id"],
            "name": task.get("name"),
            "group": _tab_groups.get(str(task["id"]), ""),
            "status": task.get("status"),
            "prev": task.get("prev"),
            "progress": round(progress, 3),
            "elapsed": elapsed,
            "updated_ms": task.get("update_ms"),
            "idle_minutes": int((stamp - (task.get("update_ms") or stamp)) / 60000),
            "url": task.get("url"),
            "deadline": task.get("deadline"),
            "deadline_left": (int((task["deadline"] - stamp) / 1000)
                              if task.get("deadline") else None),
            "overdue": bool(task.get("overdue")),
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
        "stuck_seconds": stuck,
        "window_limit": limit,
        "tasks": active[:limit],
        "active": active,
        "all": rows,
        # 「进行中」= 此刻真的在干活的 agent（busy 分支每轮重算，与是否已读无关）
        "counts": {
            "running": sum(1 for r in active if r["status"] == "running"),
            **{s: sum(1 for r in rows if r["status"] == s)
               for s in ("stuck", "attention", "done", "seen")},
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


def snapshot_edge_tabs() -> dict:
    """一次取回所有标签的 (窗口序号, 标签序号)，供点击时 O(1) 定位。"""
    try:
        out = subprocess.run(["osascript", "-e", EDGE_TABS_SCRIPT],
                             capture_output=True, text=True, timeout=10).stdout
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

DASHBOARD = """<!doctype html><html lang="zh"><meta charset="utf-8">
<title>TaskPulse · 会话看板</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#141518;color:#e8e9ec;font:14px/1.5 -apple-system,"PingFang SC",sans-serif}
 .wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
 h1{font-size:18px;font-weight:600;margin:0 0 4px}
 .sub{color:#8a8f98;font-size:12px;margin-bottom:20px}
 .row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#1c1e22;
      border-radius:10px;margin-bottom:8px;cursor:pointer;border:1px solid #24262b}
 .row:hover{border-color:#3a3e46;background:#202329}
 .dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
 .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .meta{color:#8a8f98;font-size:12px;white-space:nowrap}
 .bar{height:4px;background:#2a2d33;border-radius:2px;width:110px;overflow:hidden;flex:0 0 110px}
 .bar>i{display:block;height:100%;border-radius:2px}
 .st-running .dot{background:#4c8dff}.st-running .bar>i{background:#4c8dff}
 .st-attention .dot{background:#ff9f0a}.st-attention .bar>i{background:#ff9f0a}
.st-seen .dot{background:#4c8dff;opacity:.5}.st-seen .bar>i{background:#4c8dff}
.st-seen{opacity:.55}
 .st-stuck .dot{background:#ff453a}.st-stuck .bar>i{background:#ff453a}
 .st-done .dot{background:#30d158}.st-done .bar>i{background:#30d158}
 .st-done{opacity:.55}
 .tag{font-size:11px;padding:1px 7px;border-radius:5px;background:#26282e;color:#b6bac2}
 .overdue{color:#ff453a}
</style>
<div class="wrap">
 <h1>TaskPulse</h1>
 <div class="sub" id="sub">连接中…</div>
 <div id="list"></div>
</div>
<script>
const CLR={running:"#4c8dff",attention:"#ff9f0a",stuck:"#ff453a",done:"#30d158"};
const TXT={running:"进行中",attention:"待我处理",stuck:"卡住",seen:"已查看",done:"已完成"};
function render(d){
  document.getElementById("sub").textContent =
    `进行中 ${d.counts.running} · 待我处理 ${d.counts.attention} · 卡住 ${d.counts.stuck} · 已完成 ${d.counts.done} · 更新于 ` +
    new Date(d.updated).toLocaleTimeString();
  const list=document.getElementById("list");
  list.innerHTML = d.all.map(t=>{
    const pct=Math.round(t.progress*100);
    const meta = t.status==="running" ? `${Math.floor(t.elapsed/60)}分${t.elapsed%60}秒`
               : t.status==="done" ? "已读" : `${t.idle_minutes} 分钟前回复`;
    return `<div class="row st-${t.status}" onclick="jump(${t.id})">
      <span class="dot"></span>
      <span class="name">${t.name}</span>
      <span class="tag">${TXT[t.status]||""}</span>
      <span class="meta ${t.overdue?'overdue':''}">${t.overdue?'已超时':meta}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="tag" onclick="event.stopPropagation();setDeadline(${t.id})">⏱</span>
    </div>`;
  }).join("") || '<div class="sub">暂无任务</div>';
}
async function jump(id){ await fetch("/open?id="+id,{method:"POST"}); }
async function setDeadline(id){
  const m = prompt("几分钟后必须完成？（留空清除）","30");
  if (m === null) return;
  const q = m.trim() ? `&minutes=${Number(m)}` : "";
  await fetch(`/deadline?id=${id}${q}`,{method:"POST"});
}
async function tick(){ try{ render(await (await fetch("/state")).json()); }catch(e){} }
tick(); setInterval(tick, 3000);
</script>
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
            with _lock:
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
                    if task:
                        task["acked_update"] = task.get("update_ms") or 0
                        if task.get("status") != "running":
                            task["prev"] = task.get("status") or "running"
                            task["status"] = "seen"
                        save_state(state)
            self._json({"ok": True, "result": result})
            return

        with _lock:
            state = load_state()
            tasks = state.setdefault("tasks", {})
            task = tasks.get(cid)
            if parsed.path == "/ack":
                if task:
                    task["acked_update"] = task.get("update_ms") or 0
                    task["status"] = "done"
                    task["muted"] = True
                    save_state(state)
                self._json({"ok": bool(task)})
            elif parsed.path == "/unack":
                if task:
                    task["muted"] = False
                    task["seen_ms"] = now_ms()
                    save_state(state)
                self._json({"ok": bool(task)})
            elif parsed.path == "/active":
                # 用户切到某个已开的标签页：视为已读，但继续监控（不等同于勾选完成）
                try:
                    ln = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    ln = 0
                raw = self.rfile.read(ln) if ln > 0 else b"{}"
                url, focused = "", True
                try:
                    body = json.loads(raw or b"{}")
                    url = body.get("url") or ""
                    focused = body.get("focused", True)
                except Exception:
                    pass
                m = re.search(r"[?&]conversationId=(\d+)", url)
                hit = False
                # 浏览器在后台时，扩展里的「切标签」不该算用户读过
                if m and focused:
                    task = tasks.get(m.group(1))
                    if task and not task.get("muted") and task.get("status") in ("attention", "stuck"):
                        task["acked_update"] = task.get("update_ms") or 0
                        task["prev"] = task.get("status")
                        task["status"] = "seen"
                        task["acked_at"] = now_ms()
                        save_state(state)
                        hit = True
                self._json({"ok": hit})
            elif parsed.path == "/deadline":
                if task:
                    minutes = (query.get("minutes") or [""])[0]
                    if minutes:
                        task["deadline"] = now_ms() + int(float(minutes) * 60000)
                        task["deadline_notified"] = 0
                    else:
                        task["deadline"] = None
                    save_state(state)
                self._json({"ok": bool(task)})
            else:
                self._json({"error": "not found"}, 404)


# ── 主循环 ──────────────────────────────────────────────────────────

def poll_loop() -> None:
    """取数线程外壳：任何中断（含 SSO 库的 sys.exit）都不能让取数悄悄停掉。"""
    global _fail_count
    while True:
        try:
            _poll_forever()
            return
        except BaseException as exc:  # noqa: BLE001
            _fail_count += 1
            name, msg = type(exc).__name__, str(exc)
            auth = name == "SystemExit" or "token" in msg.lower() or "auth" in msg.lower()
            backoff = min(60 * (2 ** (_fail_count - 1)), 1800) if auth else 60
            hint = ""
            if auth:
                hint = ("（认证失败：先按日志提示完成一次授权；若授权页没有反应，"
                        "检查 auth.env 与 auth.provider 配置）")
            log("取数线程中断: %s: %s；%d 秒后重启%s" % (name, msg, backoff, hint))
            _mark_error("%s: %s" % (name, msg))
            time.sleep(backoff)


def _mark_error(msg: str) -> None:
    """把取数故障写进 state，UI/诊断能看到「数字不再更新」的原因。"""
    try:
        state = load_state()
        state["poller_error"] = msg
        state["poller_error_at"] = now_ms()
        save_state(state)
    except Exception:
        pass


def _poll_forever() -> None:
    global _fail_count
    agent = None
    lock = None
    while lock is None:                 # 与上一个进程交接时可能短暂被占，别就此放弃
        lock = take_lock()
        if lock is None:
            log("取数锁被占用，5 秒后重试")
            time.sleep(5)
    log("取数循环已启动，间隔 %ss" % POLL_SECONDS)
    while True:
        t0 = time.time()
        try:
            if agent is None:
                agent = AgentClient()
            base = load_state()
            state = refresh(base, agent)
            # 取数期间用户可能勾选/设了 deadline（HTTP 线程写盘）→ 以磁盘为准重算一次
            disk = load_state()
            if (disk.get("updated") or 0) > (base.get("updated") or 0):
                state = refresh(disk, agent)
            state.pop("poller_error", None)
            state.pop("poller_error_at", None)
            save_state(state)
            _fail_count = 0
            if TP_DEBUG:
                log("poll tick ok %.1fs" % (time.time() - t0))
        except Exception as exc:  # noqa: BLE001
            log(f"poll failed: {exc}")
            agent = None        # 认证/网络异常时下一轮重建会话
        time.sleep(max(1.0, POLL_SECONDS - (time.time() - t0)))


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
        agent = AgentClient()
        state = refresh(load_state(), agent)
        save_state(state)
        print(json.dumps(view(state), ensure_ascii=False, indent=1))
        return 0

    # 取数循环常驻本进程：省掉每次都启动解释器的开销，也复用已建立的会话（少换 token）
    threading.Thread(target=poll_loop, name="poller", daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"TaskPulse serving on http://127.0.0.1:{PORT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
