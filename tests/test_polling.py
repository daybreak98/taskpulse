import json
import os
import tempfile
import shutil
import subprocess
import threading
import time
import unittest
from contextlib import ExitStack, contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests

# poller 在 import 时就确定配置文件位置。不指定的话会读本机的
# ~/.taskpulse/config.json——那台机器把 source 切成 web 时，make_agent()
# 返回的是 WebProvider，各用例注入的 FakeAgent 便被静默忽略。
# 这里指到一份空配置，poller 会把它叠在内置默认值上（source=api）。
_TEST_CONFIG = Path(tempfile.gettempdir()) / "taskpulse-test-config.json"
_TEST_CONFIG.write_text("{}", encoding="utf-8")
os.environ["TASKPULSE_CONFIG"] = str(_TEST_CONFIG)

import poller  # noqa: E402  （必须排在设置环境变量之后）


NOW = 1_800_000_000_000


def conversation(cid=1, updated=NOW - 1000):
    return {"id": cid, "name": f"会话 {cid}", "updateTime": updated}


class FakeAgent:
    def __init__(self, conversations, busy=()):
        self.items = conversations
        self.busy = set(busy)
        self.bad = set()
        self.before_queue = None
        self.list_calls = 0
        self.queue_calls = []
        self.message_calls = []

    def conversations(self, timeout):
        self.list_calls += 1
        return self.items.copy()

    def queue(self, cid, timeout):
        self.queue_calls.append(cid)
        if self.before_queue:
            self.before_queue()
        if cid in self.bad:
            raise requests.Timeout("queue timeout")
        return cid in self.busy, "RUNNING" if cid in self.busy else "IDLE"

    def last_message(self, cid, timeout):
        self.message_calls.append(cid)
        return {"sender": "user"}


class StopLoop(Exception):
    pass


class PollingTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.directory = stack.enter_context(tempfile.TemporaryDirectory())
        self.stamp = NOW
        self.notifications = Mock()
        stack.enter_context(patch.multiple(
            poller,
            STATE_FILE=str(Path(self.directory) / "state.json"),
            WEBSTATE_FILE=str(Path(self.directory) / "webstate.json"),
            ACTIVE_FILE=str(Path(self.directory) / "active.json"),
            _open_visit_until={},  # 每个测试独立模拟一个桌面后台进程
            _profile_tabs={}, _tab_sample_at={}, _active_browser="",
            _active_tab={"cid": None, "focused": False, "ts": 0},
            # 身份密钥也指到临时目录：绝不能碰本机真实的那一份
            TOKEN_FILE=str(Path(self.directory) / "token"),
            CONV_URL="https://agent.example.com/chat?conversationId={cid}",
            # 标签只认会话页前缀，这里跟着测试用的 URL 一起 patch
            CONV_PAGE_PREFIX="https://agent.example.com/chat",
            POLL_SECONDS=60,
            ACTIVE_POLL_SECONDS=10,
            DISCOVERY_POLL_SECONDS=5,
            ACTIVE_WATCH_LIMIT=2,
            WATCH_LIMIT=20,
            FAIL_MARKS=(),
            DEFAULT_STUCK_SECONDS=600,
            now_ms=lambda: self.stamp,
            notify=self.notifications,
            snapshot_edge_tabs=Mock(),
            log=Mock(),
        ))

    @contextmanager
    def serve(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), poller.Handler) as server:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
            thread.start()
            try:
                yield f"http://127.0.0.1:{server.server_port}"
            finally:
                server.shutdown()
                thread.join()

    def auth(self):
        """带身份头的会话：本机接口现在要求 X-TP-Token，不带就 401。"""
        session = requests.Session()
        session.headers[poller.TOKEN_HEADER] = poller.ensure_token()
        return session

    def test_fast_checks_rotate_through_running_tasks_outside_latest_list(self):
        agent = FakeAgent([conversation(i) for i in range(1, 6)], busy=(1, 2, 3, 4))
        poller.poll_tick(agent, full=True)
        agent.items = [conversation(5)]
        agent.queue_calls.clear()

        for _ in range(2):
            self.stamp += 10_000
            poller.poll_tick(agent, full=False)

        self.assertEqual(agent.list_calls, 1)
        self.assertEqual(agent.queue_calls, [1, 2, 3, 4])
        self.assertEqual(poller.view(poller.load_state())["counts"]["running"], 4)

    def test_default_schedule_discovers_every_interval_and_caps_extra_queues(self):
        # 60 秒一轮全量，外加每 5 秒一次发现 → 60 秒里拉 12 次列表；
        # 空闲时队列只随全量走（20 个会话各一次），全部在跑时每次发现额外复查 2 个。
        for busy, expected_checks in [((), 20), (range(1, 21), 42)]:
            with self.subTest(expected_checks=expected_checks):
                agent = FakeAgent([conversation(i) for i in range(1, 21)], busy=busy)
                poller.save_state({})
                self.stamp = NOW
                elapsed = 0

                def sleep(seconds):
                    nonlocal elapsed
                    elapsed += seconds
                    self.stamp = NOW + int(elapsed * 1000)
                    if elapsed >= 60:
                        raise StopLoop
                    return False        # 没被唤醒，照常按计划时间往下走

                clock = SimpleNamespace(monotonic=lambda: elapsed, sleep=sleep)
                with patch.multiple(poller, time=clock, AgentClient=lambda: agent,
                                    _sleep_until=sleep):
                    with self.assertRaises(StopLoop):
                        poller._poll_forever()
                self.assertEqual(agent.list_calls, 12)
                self.assertEqual(len(agent.queue_calls), expected_checks)

    def test_new_conversations_are_counted_and_empty_ones_stay_seen(self):
        agent = FakeAgent([conversation(1)])
        poller.poll_tick(agent, full=True)          # 首次全量：建立回填分界线
        created = self.stamp
        agent.items = [
            {**conversation(2, updated=created), "createTime": created},   # 新会话，正在跑
            {**conversation(3, updated=created), "createTime": created},   # 刚建好，还没跑
            conversation(1),                                               # 分界线之前的历史会话
        ]
        agent.busy.add(2)
        self.stamp += 5_000

        state = poller.poll_tick(agent, full=False, discovery=True)

        self.assertEqual(state["tasks"]["2"]["status"], "running")
        self.assertEqual(state["tasks"]["2"]["running_since"], self.stamp)
        self.assertEqual(state["tasks"]["3"]["status"], "seen")
        self.assertEqual(state["tasks"]["1"]["status"], "seen")
        self.assertEqual(poller.view(state)["counts"]["running"], 1)

    def test_seen_session_starting_a_new_round_is_probed_on_discovery_tick(self):
        agent = FakeAgent([conversation(1)])
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "seen")

        # 用户又起了新一轮：列表 updateTime 跳变，队列转忙
        agent.items = [conversation(1, updated=self.stamp + 4_000)]
        agent.busy.add(1)
        agent.queue_calls.clear()
        self.stamp += 5_000

        state = poller.poll_tick(agent, full=False, discovery=True)

        self.assertEqual(agent.queue_calls, [1])          # 不等下一分钟全量就查了
        self.assertEqual(state["tasks"]["1"]["status"], "running")

    def test_stuck_task_is_rescanned_at_stuck_interval(self):
        agent = FakeAgent([conversation(1)], busy=(1,))
        poller.poll_tick(agent, full=True)
        self.stamp += 601_000
        poller.poll_tick(agent, full=False)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "stuck")

        agent.queue_calls.clear()
        for _ in range(3):                                # 15 秒内不再复查
            self.stamp += 5_000
            poller.poll_tick(agent, full=False)
        self.assertEqual(agent.queue_calls, [])

        self.stamp += 60_000                              # 满 60 秒才复查一次
        poller.poll_tick(agent, full=False)
        self.assertEqual(agent.queue_calls, [1])

    def test_attention_restarts_countdown_after_turn_finishes(self):
        agent = FakeAgent([conversation(1)], busy=(1,))
        poller.poll_tick(agent, full=True)                        # 起跑
        self.stamp += 400_000
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "running")

        agent.busy = set()                                        # 这一轮结束，转待回复
        self.stamp += 1_000
        poller.poll_tick(agent, full=True)
        task = poller.load_state()["tasks"]["1"]
        self.assertEqual(task["status"], "attention")
        self.assertEqual(task["countdown_since"], self.stamp)     # 倒计时从这一刻重新起算

        # 累计已 800 秒，但待回复阶段才过了 400 秒：不能判卡住
        self.stamp += 400_000
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "attention")

        # 待回复本身等满阈值（测试里压到 600 秒）→ 卡住
        self.stamp += 250_000
        state = poller.poll_tick(agent, full=True)
        self.assertEqual(state["tasks"]["1"]["status"], "stuck")

    def test_rate_limit_message_is_detected_while_still_running(self):
        agent = FakeAgent([conversation(1)], busy=(1,))
        poller.poll_tick(agent, full=True)
        original = agent.last_message

        def busy_message(cid, timeout):
            original(cid, timeout)        # 保留调用计数
            return {"sender": "assistant", "content": "当前服务繁忙，请稍后再试"}

        agent.last_message = busy_message
        self.stamp += 65_000

        with patch.object(poller, "FAIL_MARKS", ("当前服务繁忙",)):
            state = poller.poll_tick(agent, full=False)

        task = state["tasks"]["1"]
        self.assertTrue(task["failed"])
        self.assertEqual(task["status"], "stuck")
        self.assertEqual(agent.message_calls, [1])

    def test_late_rate_limit_text_flips_attention_to_stuck(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)               # 起跑
        self.stamp += 30_000
        agent.busy = set()                                # 这一轮结束，先判成待回复
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "attention")

        # 限流提示比消息本体晚落地：第一次翻没翻到，过一会儿再翻才看得到
        agent.last_message = lambda cid, timeout: {
            "sender": "assistant", "content": "当前服务繁忙，本次回答未能完成"}
        self.stamp += 40_000
        with patch.object(poller, "FAIL_MARKS", ("当前服务繁忙",)):
            poller.poll_tick(agent, full=True)

        task = poller.load_state()["tasks"]["1"]
        self.assertTrue(task["failed"])
        self.assertEqual(task["status"], "stuck")

    def test_time_budget_allows_later_full_candidates_to_get_a_turn(self):
        agent = FakeAgent([conversation(i) for i in range(1, 4)])
        clock = Mock(return_value=0.0)
        agent.before_queue = lambda: setattr(clock, "return_value", clock.return_value + 0.8)
        with patch.multiple(poller, time=SimpleNamespace(monotonic=clock), ROUND_BUDGET_SECONDS=1):
            for _ in range(3):
                poller.poll_tick(agent, full=True)
                self.stamp += 60_000
        self.assertEqual(agent.queue_calls, [1, 2, 3])

    def test_quick_completion_remains_unread_and_reuses_version_on_list_catchup(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        agent.busy.clear()
        self.stamp += 30_000
        completed_at = self.stamp
        task = poller.poll_tick(agent, full=False)["tasks"]["1"]
        version = task["reply_version"]
        self.assertEqual(task["status"], "attention")
        self.assertEqual(agent.message_calls, [])

        self.stamp += 10_000
        task = poller.poll_tick(agent, full=True)["tasks"]["1"]
        self.assertEqual((task["status"], task["reply_version"]), ("attention", version))
        with self.serve() as url:
            seen = self.auth().post(url + "/active", json={"url": task["url"]}, timeout=2)
            self.assertTrue(seen.json()["ok"])

        agent.items = [conversation(updated=completed_at - 100)]
        self.stamp += 20_000
        task = poller.poll_tick(agent, full=True)["tasks"]["1"]
        self.assertEqual((task["status"], task["reply_version"]), ("seen", version))
        agent.items = [conversation(updated=self.stamp)]
        task = poller.poll_tick(agent, full=True)["tasks"]["1"]
        self.assertEqual(task["status"], "attention")
        self.assertNotEqual(task["reply_version"], version)

    def test_queue_failure_marks_last_running_state_unconfirmed(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        agent.bad.add(1)
        self.stamp += 10_000
        state = poller.poll_tick(agent, full=False)
        item = state["tasks"]["1"]
        self.assertEqual((item["status"], item["running_since"], state["updated"]), ("running", NOW, NOW))
        payload = poller.view(state)
        self.assertEqual(payload["stale_count"], 1)
        self.assertEqual(payload["counts"]["running"], 0)
        self.assertTrue(payload["active"][0]["stale"])

        self.stamp += 10_000
        poller.poll_tick(agent, full=False)
        self.assertEqual(agent.queue_calls, [1, 1])
        self.stamp += 40_000
        agent.bad.clear()
        state = poller.poll_tick(agent, full=True)
        self.assertEqual(poller.view(state)["counts"]["running"], 1)

    def test_unobserved_running_status_ages_out_and_elapsed_stops(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        self.stamp += 121_000
        payload = poller.view(poller.load_state())
        self.assertEqual(payload["counts"]["running"], 0)
        self.assertEqual(payload["active"][0]["elapsed"], 0)
        self.assertTrue(payload["active"][0]["stale"])

    def test_poll_commit_preserves_http_ack_and_deadline_during_upstream_io(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        self.stamp += 60_000

        with self.serve() as url:
            def user_actions():
                for path in ("/ack?id=1", "/deadline?id=1&minutes=30"):
                    response = self.auth().post(url + path, timeout=2)
                    self.assertTrue(response.json()["ok"])

            agent.before_queue = user_actions
            state = poller.poll_tick(agent, full=True)
            stored = self.auth().get(url + "/state", timeout=2).json()

        self.assertEqual(agent.list_calls, 2)
        self.assertEqual(agent.queue_calls, [1, 1])
        self.assertEqual(stored["counts"]["done"], 1)
        task = state["tasks"]["1"]
        self.assertTrue(task["muted"])
        self.assertEqual(task["deadline"], self.stamp + 30 * 60_000)

    def test_notification_markers_are_saved_and_not_repeated(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        state = poller.load_state()
        state["tasks"]["1"]["deadline"] = self.stamp + 1000
        poller.save_state(state)
        self.stamp += 40_000
        with patch.object(poller, "DEFAULT_STUCK_SECONDS", 30):
            poller.poll_tick(agent, full=False)
            self.stamp += 10_000
            poller.poll_tick(agent, full=False)
        # 截止时间由独立线程检查（不依赖上游取数），这里直接驱动它一次
        poller._check_deadlines()
        self.assertEqual([args[0] for args, _ in self.notifications.call_args_list],
                         ["任务疑似卡住", "任务已超时"])
        # 同一份截止时间不重复提醒
        self.stamp += 1_000
        poller._check_deadlines()
        self.assertEqual(len(self.notifications.call_args_list), 2)

    def test_missing_assistant_content_has_limited_retries(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        agent.busy.clear()
        self.stamp += 30_000
        with patch.object(poller, "FAIL_MARKS", ("已知的错误模板",)):
            for _ in range(12):
                state = poller.poll_tick(agent, full=True)
                self.stamp += 20_000
        # 拿不到内容时不急着定死：留出复查窗口，但总次数封顶在 REPROBE_ATTEMPTS
        self.assertEqual(len(agent.message_calls), poller.REPROBE_ATTEMPTS)
        self.assertEqual(state["tasks"]["1"]["status"], "attention")

    def test_http_rate_limit_aborts_queue_batch_and_backs_off(self):
        agent = FakeAgent([conversation(1), conversation(2)], busy=(1, 2))
        poller.poll_tick(agent, full=True)
        error = requests.HTTPError("HTTP 429", response=SimpleNamespace(status_code=429))
        agent.before_queue = Mock(side_effect=error)
        clock = 0
        pauses = []

        def sleep(seconds):
            nonlocal clock
            clock += seconds
            pauses.append(seconds)
            if len(pauses) == 2:
                raise StopLoop
            return False            # 没被唤醒，照常按退避时间往下走

        with patch.multiple(poller, AgentClient=lambda: agent,
                            time=SimpleNamespace(monotonic=lambda: clock, sleep=sleep),
                            _sleep_until=sleep):
            with self.assertRaises(StopLoop):
                poller._poll_forever()
        self.assertEqual(pauses, [60, 120])
        self.assertEqual(agent.queue_calls, [1, 2, 1, 1])
        self.assertIn("429", poller.load_state()["poller_error"])
        self.assertEqual(poller.load_state()["updated"], NOW)

    def test_missing_credentials_do_not_escalate_backoff(self):
        """凭据服务不可用（SDK sys.exit）应按固定间隔重试，不该涨到几分钟。"""
        agent = FakeAgent([conversation(1)])
        agent.conversations = Mock(side_effect=SystemExit(1))
        clock = {"t": 0.0}
        pauses = []

        def sleep(seconds):
            pauses.append(seconds)
            clock["t"] += seconds
            if len(pauses) == 3:
                raise StopLoop
            return False

        with patch.multiple(poller, AgentClient=lambda: agent,
                            time=SimpleNamespace(monotonic=lambda: clock["t"], sleep=sleep),
                            _sleep_until=sleep):
            with self.assertRaises(StopLoop):
                poller._poll_forever()

        self.assertEqual(pauses, [60, 60, 60], "SystemExit 不该触发指数退避")
        err = poller.load_state()["poller_error"]
        self.assertIn("凭据服务", err, "错误文案对用户不可读")
        self.assertNotIn("SystemExit", err)

    def test_scope_change_does_not_leak_deadline_to_other_tasks(self):
        """一个会话换数据范围时，它的截止时间不能串写到同一批次的其他会话。"""
        agent = FakeAgent([{"id": 1, "name": "A", "updateTime": self.stamp, "agentId": 111},
                           {"id": 2, "name": "B", "updateTime": self.stamp, "agentId": 111}])
        poller.poll_tick(agent, full=True)
        deadline1 = self.stamp + 600_000
        deadline2 = self.stamp + 900_000
        state = poller.load_state()
        state["tasks"]["1"]["deadline"] = deadline1
        state["tasks"]["2"]["deadline"] = deadline2
        poller.save_state(state)

        # 只有会话 1 换了范围；会话 2 仍在原范围
        agent.items = [{"id": 1, "name": "A", "updateTime": self.stamp, "agentId": 222},
                       {"id": 2, "name": "B", "updateTime": self.stamp, "agentId": 111}]
        self.stamp += 1_000
        poller.poll_tick(agent, full=True)

        tasks = poller.load_state()["tasks"]
        self.assertEqual(tasks["1"].get("deadline"), deadline1,
                         "换范围的会话丢了用户设的截止时间")
        self.assertEqual(tasks["2"].get("deadline"), deadline2,
                         "别的会话的截止时间被串写")

    def test_retry_countdown_is_exposed_while_backing_off(self):
        """退避期间 /state 要给出「还剩几秒会重试」，界面才能告诉用户等多久。"""
        poller._mark_error("boom", 30)
        got = poller.view(poller.load_state())
        self.assertIn("boom", got["poller_error"])
        self.assertIsNotNone(got["retry_in_seconds"])
        self.assertAlmostEqual(got["retry_in_seconds"], 30, delta=1)

        # 时间往后走，剩余秒数应递减
        self.stamp += 10_000
        got = poller.view(poller.load_state())
        self.assertAlmostEqual(got["retry_in_seconds"], 20, delta=1)

        # 成功取数后清掉，界面不该再显示倒计时
        poller._mark_error("", None)
        self.assertIsNone(poller.view(poller.load_state())["retry_in_seconds"])

    def test_important_task_keeps_fast_sampling_while_idle(self):
        """标了「完成后提醒我」的会话即使没在跑，也要按秒级复查，
        否则它掉出监控窗口后再有回话就取不到。"""
        agent = FakeAgent([conversation(1), conversation(2)], busy=(1,))
        poller.poll_tick(agent, full=True)
        state = poller.load_state()
        state["tasks"]["2"]["important"] = True     # 已查看、但被标记
        poller.save_state(state)

        self.stamp += 10_000
        agent.queue_calls.clear()
        poller.poll_tick(agent, full=False)
        self.assertIn(2, agent.queue_calls, "重要会话没有被复查")

    def test_short_task_is_not_marked_seen_before_list_catches_up(self):
        """8 秒短任务：队列先转空闲、列表还没刷新，不能直接判「已查看」。"""
        base = NOW
        agent = FakeAgent([conversation(1, updated=base)], busy=(1,))
        poller.poll_tick(agent, full=True)

        # 上一轮结束过（reply_completed_at 有值），这一轮 8 秒前刚跑完；
        # 列表还没刷新，updateTime 仍是 base
        self.stamp = base + 8_000
        state = poller.load_state()
        state["tasks"]["1"].update(reply_completed_at=base, acked_update=base,
                                   update_ms=base, status="running",
                                   running_since=base + 8_000,
                                   countdown_since=base + 8_000)
        poller.save_state(state)

        agent.busy.clear()
        agent.items = [conversation(1, updated=base)]
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "running",
                         "列表还没补上新回复就当成已查看了")

        # 列表补上来：这一轮确实有回复，转成待回复
        agent.items = [conversation(1, updated=self.stamp + 1_000)]
        self.stamp += 5_000
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "attention")

    def test_long_gap_restarts_the_run_instead_of_reporting_stuck(self):
        """休眠/断网很久之后仍看到「忙」，不能沿用旧起点立刻报卡住。"""
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        state = poller.load_state()
        # 三小时前起跑、之后一直没有观测
        state["tasks"]["1"].update(running_since=self.stamp - 3 * 3600_000,
                                   countdown_since=self.stamp - 3 * 3600_000,
                                   queue_observed_at=self.stamp - 3 * 3600_000,
                                   status="running")
        poller.save_state(state)

        poller.poll_tick(agent, full=False)
        task = poller.load_state()["tasks"]["1"]
        self.assertNotEqual(task["status"], "stuck", "断线恢复后立刻误报卡住")
        self.assertEqual(task["running_since"], self.stamp, "没有从本次观测重新计时")
        self.assertEqual(self.notifications.call_args_list, [])

    # ── 三条修复的回归 ──────────────────────────────────────────────

    def test_deadline_set_during_slow_sample_is_kept(self):
        """慢采样期间用户设的截止时间不能被采样结果覆盖。"""
        agent = FakeAgent([conversation(1)], busy=(1,))
        poller.poll_tick(agent, full=True)

        with self.serve() as url:
            def during_sample():
                # 取数还在锁外跑的时候，用户点了「5 分钟后提醒」
                agent.before_queue = None
                self.auth().post(f"{url}/deadline?id=1&minutes=5", timeout=2)

            agent.before_queue = during_sample
            self.stamp += 60_000
            poller.poll_tick(agent, full=True)

        task = poller.load_state()["tasks"]["1"]
        self.assertTrue(task.get("deadline"), "用户设的截止时间被采样落盘覆盖了")
        self.assertGreater(task["deadline"], self.stamp)

    @unittest.skipUnless(shutil.which("node"), "Node is required for desktop bridge runtime regression")
    def test_desktop_bridge_runtime_regression(self):
        script = Path(__file__).with_name("test_desktop_bridge.cjs")
        result = subprocess.run(["node", "--test", str(script)], capture_output=True,
                                text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_notice_events_are_persisted_and_source_scoped(self):
        task = {"id": 1, "name": "A", "agent_id": "agent", "status": "running",
                "deadline": NOW - 1, "run_version": "run:1", "update_ms": NOW - 100}
        with patch.object(poller, "source_mode", return_value="api"):
            poller.save_state({"tasks": {"1": task}})
            poller._check_deadlines()
            state = poller.load_state()
            self.assertEqual(len(state["events"]), 1)
            self.assertEqual(state["events"][0]["agent_id"], "agent")
            self.assertEqual(poller.view(state)["events"][0]["revision"], poller.task_revision(state["tasks"]["1"]))
            poller._check_deadlines()
            self.assertEqual(len(poller.load_state()["events"]), 1)
        with patch.object(poller, "source_mode", return_value="web"):
            self.assertEqual(poller.view(poller.load_state())["events"], [])

    def test_bulk_close_uses_current_profile_not_other_browser(self):
        path = Path(self.directory) / "webstate.json"
        path.write_text(json.dumps({"at": NOW, "generation": poller.web_generation(),
            "collector": "edge-owner", "browser": "edge", "conversations": []}), encoding="utf-8")
        url = "https://agent.example.com/chat?conversationId=1"
        with patch.multiple(poller, WEBSTATE_FILE=str(path), source_mode=lambda: "web"):
            poller.save_state({"tasks": {"1": {"id": 1, "url": url, "status": "seen",
                                              "update_ms": NOW - 86400000}}})
            for collector, browser, tab in [("edge-owner", "edge", 11), ("chrome-other", "chrome", 22)]:
                poller.ingest_tabs({"at": NOW, "collector": collector, "browser": browser,
                    "tabs": [{"url": url, "tabId": tab}], "active": {"focused": False}})
            self.assertEqual(poller.closeable_tabs("idle"), [("1", 11)])
            state = poller.load_state()
            state["tasks"]["1"]["awaiting_reply"] = True
            poller.save_state(state)
            self.assertEqual(poller.closeable_tabs("idle"), [])

    def test_web_full_reports_keep_tracking_running_tasks_outside_limit(self):
        path = Path(self.directory) / "webstate.json"
        with patch.multiple(poller, WEBSTATE_FILE=str(path), source_mode=lambda: "web", WATCH_LIMIT=1):
            def report(convs, queues, messages):
                path.write_text(json.dumps({
                    "at": self.stamp, "listAt": self.stamp,
                    "generation": poller.web_generation(), "collector": "tracked-web", "browser": "edge",
                    "conversations": convs, "queues": queues,
                    "queueAt": {cid: self.stamp for cid in queues}, "lastMessages": messages,
                }), encoding="utf-8")
                return poller.poll_tick(poller.WebProvider(), full=True)
            a = {"id": 1, "name": "A", "updateTime": NOW - 1000}
            b = {"id": 2, "name": "B", "updateTime": NOW + 1000}
            busy = {"state": "RUNNING", "pending": []}
            idle = {"state": "IDLE", "pending": []}
            first = report([a], {"1": busy}, {"1": {"sampledAt": NOW, "messages": []}})
            self.assertEqual(first["tasks"]["1"]["status"], "running")
            self.stamp += 4000
            result = report([b, a], {"1": idle, "2": busy},
                {"1": {"sampledAt": self.stamp, "messages": [
                    {"id": "reply-a", "sender": "assistant", "createTime": self.stamp}]}})
            self.assertTrue(result["tasks"]["1"]["reply_pending"])
            self.assertEqual(result["tasks"]["2"]["status"], "running")

    def test_web_waiting_on_legacy_bridge_has_reload_hint(self):
        with patch.object(poller, "source_mode", return_value="web"):
            with self.serve() as url:
                client = self.auth()
                old = {"at": self.stamp, "browser": "edge", "tabs": [],
                       "web": {"hasApi": True}, "active": {"focused": False}}
                self.assertTrue(client.post(url + "/tabs", json=old, timeout=2).json()["ok"])
                state = client.get(url + "/state", timeout=2).json()
                self.assertIn("重新加载 TaskPulse Tab Bridge", state["poller_error"])
                # A current bridge reporting from another browser should clear
                # this specific legacy-only diagnostic.
                modern = {**old, "browser": "chrome", "collector": "chrome-current"}
                client.post(url + "/tabs", json=modern, timeout=2)
                state = client.get(url + "/state", timeout=2).json()
                self.assertNotIn("重新加载 TaskPulse Tab Bridge", state["poller_error"] or "")

    def test_web_missing_generation_does_not_create_baseline_or_advance_tasks(self):
        path = Path(self.directory) / "webstate.json"
        path.write_text(json.dumps({"at": NOW, "generation": "old-process", "collector": "test-web",
                                    "conversations": [conversation(1)]}), encoding="utf-8")
        with patch.multiple(poller, WEBSTATE_FILE=str(path), source_mode=lambda: "web"):
            result = poller.poll_tick(poller.WebProvider(), full=True)
            self.assertTrue(result.get("poller_error"))
            self.assertFalse(result.get("baseline_at"))
            self.assertFalse(result.get("tasks"))

    def test_web_old_queue_sample_is_not_renewed(self):
        """页面重复上报同一份旧队列，不能把观测时间一路往后推。"""
        path = str(Path(self.directory) / "webstate.json")
        old_at = NOW - 300_000          # 五分钟前取到的队列
        payload = {
            "at": self.stamp, "generation": poller.web_generation(), "collector": "test-web", "browser": "edge",
            "conversations": [{"id": 1, "name": "会话 1", "updateTime": self.stamp - 1000}],
            "queues": {"1": {"state": "RUNNING", "pending": []}},
            "queueAt": {"1": old_at},
        }
        Path(path).write_text(json.dumps(payload), encoding="utf-8")

        with patch.multiple(poller, WEBSTATE_FILE=path, source_mode=lambda: "web"):
            provider = poller.WebProvider()
            poller.poll_tick(provider, full=True)
            first = poller.load_state()["tasks"]["1"]
            self.assertEqual(first["queue_observed_at"], old_at)

            # 页面下一轮报的还是同一份缓存：不应该再落一次，也不该续期
            self.stamp += 4_000
            poller.poll_tick(provider, full=True)
            second = poller.load_state()["tasks"]["1"]
            self.assertEqual(second["queue_observed_at"], old_at)
            self.assertEqual(second["queue_checked_at"], first["queue_checked_at"])

    def test_mode_switch_wakes_loop_out_of_backoff(self):
        """来源切换要立刻重排；不能等原来的退避（这里模拟的是 60 秒起步）。"""
        poller._wake.clear()
        agent = FakeAgent([conversation(1)])
        original = agent.conversations
        attempt = {"n": 0}

        def flaky(timeout):
            attempt["n"] += 1
            if attempt["n"] == 1:
                raise requests.Timeout("upstream down")
            return original(timeout)

        agent.conversations = flaky
        clock = {"t": 0.0}
        steps = []

        def sleep(seconds):
            steps.append(seconds)
            if len(steps) == 1:
                # 退避期间用户切了来源：只推进 1 秒就唤醒
                clock["t"] += 1
                poller._wake.set()
                return True
            raise StopLoop

        with patch.multiple(poller, AgentClient=lambda: agent,
                            time=SimpleNamespace(monotonic=lambda: clock["t"], sleep=sleep),
                            _sleep_until=sleep):
            with self.assertRaises(StopLoop):
                poller._poll_forever()

        self.assertGreaterEqual(attempt["n"], 2, "被唤醒后没有立刻重试")
        self.assertEqual(clock["t"], 1.0, "唤醒后仍按原退避等满")

    def test_mode_route_sets_wake_event(self):
        """切换来源的接口本身要负责唤醒常驻循环。"""
        config = str(Path(self.directory) / "config.json")
        Path(config).write_text("{}", encoding="utf-8")
        with patch.multiple(poller, CONFIG_FILE=config):
            with self.serve() as url:
                poller._wake.clear()
                r = self.auth().post(f"{url}/mode?value=web", timeout=2)
                self.assertEqual(r.json(), {"ok": True, "source": "web"})
                self.assertTrue(poller._wake.is_set())

    # ── 三条链路的验收 ──────────────────────────────────────────────

    def test_new_conversation_is_running_on_discovery_tick(self):
        agent = FakeAgent([conversation(1)])
        poller.poll_tick(agent, full=True)          # 建立回填分界线
        created = self.stamp

        self.stamp += 5_000
        agent.items = [{"id": 2, "name": "会话 2", "updateTime": self.stamp,
                        "createTime": created}, conversation(1)]
        agent.busy.add(2)
        state = poller.poll_tick(agent, full=False, discovery=True)
        self.assertEqual(state["tasks"]["2"]["status"], "running")

    def test_existing_conversation_starting_new_round_is_found_fast(self):
        agent = FakeAgent([conversation(1)], busy=(1,))
        poller.poll_tick(agent, full=True)

        agent.busy.clear()                          # 跑完，转「等你回复」
        self.stamp += 30_000
        self.assertEqual(poller.poll_tick(agent, full=False)["tasks"]["1"]["status"], "attention")

        # 用户在同一个会话里又起了一轮：只有发现周期能秒级看到
        self.stamp += 30_000
        agent.items = [conversation(1, updated=self.stamp)]
        agent.busy.add(1)
        agent.queue_calls.clear()
        state = poller.poll_tick(agent, full=False, discovery=True)
        self.assertEqual(agent.queue_calls, [1], "重跑的会话没被快探取到")
        self.assertEqual(state["tasks"]["1"]["status"], "running")

    # ── 跳转：命令只能发给持有该标签的浏览器 ─────────────────────────

    def test_open_command_targets_the_browser_that_owns_the_tab(self):
        agent = FakeAgent([conversation(1)])
        poller.poll_tick(agent, full=True)
        task = poller.load_state()["tasks"]["1"]
        poller._cmd_queues.clear()
        poller._cmd_done.clear()

        with patch.multiple(poller, _ext_seen=time.time(), _cmd_waiters=1,
                            open_conversation=Mock(return_value="focused")):
            poller.ingest_tabs({"browser": "edge",
                                "tabs": [{"url": task["url"], "tabId": 77}]},
                               "Mozilla/5.0 (Macintosh) Edg/157")
            with self.serve() as url:
                r = self.auth().post(url + f"/open?id={task['id']}", timeout=5)
            self.assertEqual(r.json()["result"], "queued")
            time.sleep(0.4)          # 等兜底定时器走完，避免影响下一个用例

        self.assertEqual(poller._cmd_queue("edge").qsize(), 1)
        self.assertEqual(poller._cmd_queue("chrome").qsize(), 0)

    def test_expired_command_is_not_delivered(self):
        poller._cmd_queues.clear()
        poller._cmd_done.clear()
        poller._cmd_queue("chrome").put({"cmd": "focus", "cid": "1", "id": "olds",
                                         "expires": int(time.time() * 1000) - 1000})
        with self.serve() as url:
            # 长轮询会挂到底，过期的命令既不返回也不执行，最后 204
            r = self.auth().get(url + "/cmd", timeout=15,
                                headers={"User-Agent": "Mozilla/5.0 Chrome/157"})
        self.assertEqual(r.status_code, 204)

    def test_scoped_state_and_web_generation_reject_other_collectors(self):
        path = str(Path(self.directory) / "webstate.json")
        config = str(Path(self.directory) / "config.json")
        Path(config).write_text('{"source":"api"}', encoding="utf-8")
        with patch.multiple(poller, WEBSTATE_FILE=path, CONFIG_FILE=config):
            poller.save_state({"tasks": {"api": {"name": "API"}}})
            poller.set_source_mode("web")
            first_gen = poller.web_generation()
            with self.serve() as url:
                def report(collector, browser, gen=first_gen):
                    return self.auth().post(url + "/webstate", json={
                        "at": self.stamp, "generation": gen, "collector": collector,
                        "browser": browser, "conversations": [], "queues": {}
                    }, timeout=2).json()
                self.assertTrue(report("chrome-a", "chrome")["ok"])
                mode = self.auth().get(url + "/mode", timeout=2).json()
                self.assertEqual(mode["collector"], "chrome-a")
                self.assertEqual(mode["generation"], first_gen)
                poller.save_state({"tasks": {"chrome": {"name": "Chrome"}}})
                self.stamp += 1000
                self.assertEqual(report("edge-b", "edge").get("ignored"), "other collector")
                self.assertIn("chrome", poller.load_state()["tasks"])
                poller.set_source_mode("api")
                self.assertIn("api", poller.load_state()["tasks"])
                poller.set_source_mode("web")
                self.stamp += 1000
                self.assertEqual(report("chrome-a", "chrome").get("ignored"), "old generation")
                self.assertTrue(report("chrome-a", "chrome", poller.web_generation())["ok"])
                self.assertIn("chrome", poller.load_state()["tasks"])
                self.stamp += poller.WEB_STALE_SECONDS * 1000 + 1000
                self.assertTrue(report("edge-b", "edge", poller.web_generation())["ok"])
                self.assertNotIn("chrome", poller.load_state().get("tasks", {}))
                poller.save_state({"tasks": {"edge": {"name": "Edge"}}})
                self.assertIn("edge", poller.load_state()["tasks"])

    def test_old_source_round_and_error_are_discarded(self):
        with patch.object(poller, "source_mode", return_value="web"):
            agent = FakeAgent([conversation(1)])
            poller.poll_tick(agent, full=True, expected_gen=("api", poller._source_epoch))
            self.assertEqual(agent.list_calls, 0)
            poller._mark_error("old API failure", 30, expected_gen=("api", poller._source_epoch))
            self.assertNotIn("poller_error", poller.load_state())

    def test_discovery_list_is_kept_even_when_queue_budget_exhausted(self):
        agent = FakeAgent([conversation(1)])
        with patch.object(poller, "sample_queues", return_value={}):
            state = poller.poll_tick(agent, full=False, discovery=True)
        self.assertIn("1", state["tasks"])

    def test_api_does_not_import_old_web_error(self):
        path = Path(self.directory) / "webstate.json"
        path.write_text(json.dumps({"at": NOW, "error": "HTTP 401"}), encoding="utf-8")
        with patch.multiple(poller, WEBSTATE_FILE=str(path), source_mode=lambda: "api"):
            state = poller.poll_tick(FakeAgent([conversation()]), full=True)
        self.assertNotIn("poller_error", state)

    def test_web_round_freezes_list_and_health_as_well_as_queue(self):
        path = Path(self.directory) / "webstate.json"
        first = {"at": NOW, "generation": poller.web_generation(), "collector": "test-web", "browser": "edge",
                 "conversations": [conversation(1)],
                 "queues": {"1": {"state": "IDLE", "pending": []}}, "queueAt": {"1": NOW}}
        path.write_text(json.dumps(first), encoding="utf-8")
        with patch.object(poller, "WEBSTATE_FILE", str(path)):
            provider = poller.WebProvider()
            provider.begin_round()
            path.write_text(json.dumps({"at": NOW + 5000, "conversations": [conversation(2)]}), encoding="utf-8")
            self.assertEqual(provider.conversations(1)[0]["id"], 1)
            self.assertEqual(provider.last_at(), NOW)
            self.assertEqual(provider.queue(1, 1), (False, "IDLE"))

    def test_no_sample_does_not_advance_queue_watermark(self):
        task = {"id": 1, "queue_checked_at": NOW - 10000, "queue_observed_at": NOW - 10000}
        poller.apply_queue_sample(task, poller.QueueSample(NOW, None), {}, [])
        self.assertEqual(task["queue_checked_at"], NOW - 10000)
        self.assertEqual(task["queue_observed_at"], NOW - 10000)

    def test_evidence_preserves_unread_during_next_run_and_deduplicates_two_replies(self):
        task = {"id": 1, "name": "task", "update_ms": NOW, "reply_floor": NOW,
                "created_ms": NOW - 100000, "status": "seen"}
        def sample(at, busy, messages=None):
            batch = None if messages is None else poller.normalise_messages(messages)
            poller.apply_queue_sample(task, poller.QueueSample(at, busy, "RUNNING" if busy else "IDLE",
                evidence_required=True, messages=batch, message_at=at if batch is not None else 0), {}, [])
        def msg(mid, at, sender="assistant"):
            return {"id": mid, "createTime": at, "sender": sender, "content": "ok"}
        sample(NOW, False, [msg("old", NOW - 1000)])
        self.assertFalse(task["reply_pending"])
        sample(NOW + 1000, True)
        first_run = task["run_version"]
        sample(NOW + 2000, False, [msg("a", NOW + 1900), msg("old", NOW - 1000)])
        first = task["reply_version"]
        self.assertEqual(len(task["pending_replies"]), 1)
        sample(NOW + 3000, True)
        self.assertNotEqual(task["run_version"], first_run)
        self.assertTrue(task["reply_pending"])
        self.assertEqual(task["pending_replies"][0]["version"], first)
        sample(NOW + 4000, False, None)   # message fetch failed
        self.assertTrue(task["awaiting_reply"])
        self.assertTrue(task["reply_pending"])
        sample(NOW + 5000, False, [msg("c", NOW + 4800), msg("b", NOW + 3900), msg("a", NOW + 1900)])
        self.assertEqual(len(task["pending_replies"]), 3)
        self.assertNotEqual(task["reply_version"], first)
        sample(NOW + 6000, False, [msg("c", NOW + 4800), msg("b", NOW + 3900), msg("a", NOW + 1900)])
        self.assertEqual(len(task["pending_replies"]), 3)

    def test_user_only_and_message_failure_do_not_confirm_idle_run(self):
        task = {"id": 1, "name": "task", "update_ms": NOW, "reply_floor": NOW, "status": "seen"}
        def apply(at, busy, batch):
            poller.apply_queue_sample(task, poller.QueueSample(at, busy, "IDLE",
                evidence_required=True, messages=batch, message_at=at if batch is not None else 0), {}, [])
        apply(NOW, False, [])
        apply(NOW + 1000, True, None)
        apply(NOW + 2000, False, None)
        self.assertTrue(task["awaiting_reply"])
        self.assertFalse(task["reply_pending"])
        apply(NOW + 100000, False, poller.normalise_messages([
            {"id": "user", "sender": "user", "createTime": NOW + 1000}]))
        self.assertTrue(task["awaiting_reply"])
        self.assertFalse(task["reply_pending"])
        self.assertNotEqual(task["status"], "seen")
        apply(NOW + 110000, False, poller.normalise_messages([
            {"id": "reply", "sender": "assistant", "createTime": NOW + 109000},
            {"id": "user", "sender": "user", "createTime": NOW + 1000}]))
        self.assertTrue(task["reply_pending"])
        self.assertFalse(task["awaiting_reply"])

    def test_new_run_resets_old_failure_and_settle_state(self):
        task = {"id": 1, "name": "test", "status": "stuck", "failed": True,
                "update_ms": NOW, "running_since": 0, "settle_until": NOW + 1000}
        events = []
        poller.apply_queue_sample(task, poller.QueueSample(NOW, True, "RUNNING"), {}, events)
        self.assertEqual(task["status"], "running")
        self.assertFalse(task["failed"])
        self.assertNotIn("settle_until", task)
        self.assertEqual(events, [])

    def test_new_pending_reply_resets_countdown(self):
        task = {"id": 1, "name": "test", "status": "attention", "update_ms": NOW,
                "acked_update": NOW - 1000000, "reply_version": "update:old",
                "reply_pending": True, "countdown_since": NOW - 1000000}
        events = []
        poller.apply_queue_sample(task, poller.QueueSample(NOW, False, "IDLE"), {}, events)
        self.assertEqual(task["status"], "attention")
        self.assertEqual(task["countdown_since"], NOW)
        self.assertEqual(events, [])

    def test_versioned_actions_cannot_ack_new_reply_or_new_scope(self):
        task = {"id": 1, "name": "A", "agent_id": 7, "status": "attention",
                "url": "https://agent.example.com/chat?conversationId=1",
                "update_ms": NOW, "reply_version": "b", "reply_pending": True,
                "pending_replies": [{"version": "a", "observed_at": NOW - 1000},
                                    {"version": "b", "observed_at": NOW}]}
        poller.save_state({"tasks": {"1": task}})
        scope = poller.action_scope()
        revision = poller.task_revision(task)
        poller._confirm_open("1", NOW - 1000, "a", scope, "7")
        got = poller.load_state()["tasks"]["1"]
        self.assertEqual([x["version"] for x in got["pending_replies"]], ["b"])
        self.assertTrue(got["reply_pending"])
        poller._confirm_open("1", NOW, "b", "old-scope", "7")
        self.assertTrue(poller.load_state()["tasks"]["1"]["reply_pending"])
        with self.serve() as url:
            r = self.auth().post(url + "/ack", params={"id": "1", "scope": scope,
                "revision": revision, "agent": "7"}, timeout=2)
            self.assertFalse(r.json()["ok"])
        self.assertTrue(poller.load_state()["tasks"]["1"]["reply_pending"])

    def test_active_observation_only_acks_replies_visible_at_event_time(self):
        task = {"id": 1, "name": "A", "agent_id": 7, "status": "attention",
                "url": "https://agent.example.com/chat?conversationId=1",
                "reply_version": "b", "reply_pending": True, "update_ms": NOW,
                "pending_replies": [{"version": "a", "observed_at": NOW - 2000},
                                    {"version": "b", "observed_at": NOW}]}
        scope = poller.action_scope()
        poller.ingest_tabs({"at": NOW - 1500, "browser": "chrome", "collector": "chrome-a",
            "action_scope": scope, "tabs": [{"url": task["url"], "tabId": 1}]})
        evidence = {"action_scope": scope, "collector": "chrome-a", "focused": True,
                    "url": task["url"], "at": NOW - 1000}
        task["jump_guard_at"] = NOW - 3000
        self.assertFalse(poller.confirm_active_evidence(task, evidence))
        self.assertTrue(poller.confirm_active_evidence(task, {**evidence, "explicit": True}))
        self.assertEqual([x["version"] for x in task["pending_replies"]], ["b"])
        self.assertFalse(poller.confirm_active_evidence(task, {**evidence, "at": NOW,
            "collector": "edge-b"}))

    def test_uncertain_focus_retry_never_creates_second_tab(self):
        task = {"id": 1, "agent_id": 7, "url": "https://agent.example.com/chat?conversationId=1",
                "reply_version": "a", "pending_replies": [{"version": "a", "observed_at": NOW}]}
        poller.save_state({"tasks": {"1": task}})
        ticket = ("1", NOW, "a", poller.action_scope(), "7")
        route = {"key": "chrome-a", "collector": "chrome-a", "browser": "chrome", "tabId": 1}
        with patch.object(poller, "_focus_attempt", side_effect=["unknown", "focused"]) as attempt:
            result = poller.run_open_transaction(ticket, task["url"], route)
        self.assertEqual(result, "focused")
        self.assertEqual([call.args[-1] for call in attempt.call_args_list], [True, False])
        self.assertFalse(poller.load_state()["tasks"]["1"]["reply_pending"])

    def test_focus_claim_ack_is_bound_to_profile_and_attempt(self):
        ticket = ("1", NOW, "a", poller.action_scope(), "7")
        route = {"key": "chrome-a", "collector": "chrome-a", "browser": "chrome", "tabId": 1}
        outcome = []
        with self.serve() as url:
            thread = threading.Thread(target=lambda: outcome.append(poller._focus_attempt(
                ticket, "https://agent.example.com/chat?conversationId=1", route, True)))
            thread.start()
            try:
                cmd = self.auth().get(url + "/cmd?collector=chrome-a", timeout=3).json()
                wrong = self.auth().post(url + "/cmd/ack", params={"id": cmd["id"], "collector": "edge-b",
                    "result": "focused"}, timeout=2)
                self.assertFalse(wrong.json()["ok"])
                good = self.auth().post(url + "/cmd/ack", params={"id": cmd["id"], "collector": "chrome-a",
                    "result": "focused"}, timeout=2)
                self.assertTrue(good.json()["ok"])
            finally:
                thread.join(15)
            self.assertEqual(outcome, ["focused"])
            late = self.auth().post(url + "/cmd/ack", params={"id": cmd["id"], "collector": "chrome-a",
                "result": "focused"}, timeout=2)
            self.assertFalse(late.json()["ok"])

    def test_open_confirmation_is_bound_to_reply_and_not_running(self):
        task = {"id": 1, "status": "attention", "reply_pending": True,
                "update_ms": NOW, "reply_version": "run:new"}
        poller.save_state({"tasks": {"1": task}})
        poller._confirm_open("1", NOW, "run:old")
        self.assertTrue(poller.load_state()["tasks"]["1"]["reply_pending"])
        task.update(status="stuck", running_since=NOW - 1000)
        poller.save_state({"tasks": {"1": task}})
        poller._confirm_open("1", NOW, "run:new")
        self.assertEqual(poller.load_state()["tasks"]["1"]["status"], "stuck")

    def test_programmatic_activation_does_not_clear_pending_reply(self):
        task = {"id": 1, "status": "attention", "reply_pending": True,
                "update_ms": NOW, "reply_version": "run:new",
                "url": "https://agent.example.com/chat?conversationId=1"}
        poller.save_state({"tasks": {"1": task}})
        poller._open_visit_until["1"] = time.monotonic() + 15
        with self.serve() as url:
            response = self.auth().post(url + "/active", json={"url": task["url"]}, timeout=2)
            self.assertFalse(response.json()["ok"])
            self.assertTrue(poller.load_state()["tasks"]["1"]["reply_pending"])
            poller._open_visit_until.clear()
            response = self.auth().post(url + "/active", json={"url": task["url"]}, timeout=2)
            self.assertTrue(response.json()["ok"])
            self.assertFalse(poller.load_state()["tasks"]["1"]["reply_pending"])

    def test_browser_heartbeat_keeps_other_browser_tab_and_focus(self):
        with patch.multiple(poller, _tab_ids={}, _tab_browser={}, _tab_groups={},
                            _tab_sample_at={}, _active_browser=""):
            edge_url = "https://agent.example.com/chat?conversationId=1"
            chrome_url = "https://agent.example.com/chat?conversationId=2"
            poller.ingest_tabs({"browser": "edge", "tabs": [{"url": edge_url, "tabId": 1}],
                                "active": {"url": edge_url, "focused": True}})
            poller.ingest_tabs({"browser": "chrome", "tabs": [{"url": chrome_url, "tabId": 2}],
                                "active": {"url": chrome_url, "focused": False}})
            self.assertEqual(poller._tab_ids, {"1": 1, "2": 2})
            self.assertEqual(poller.load_active()["cid"], "1")
            self.assertTrue(poller.load_active()["focused"])

    def test_conversation_id_requires_exact_query_and_scope(self):
        self.assertEqual(poller.conversation_id("https://agent.example.com/chat?conversationId=123"), "123")
        self.assertEqual(poller.conversation_id("https://agent.example.com/share?conversationId=12"), "")
        self.assertEqual(poller.conversation_id("https://agent.example.com/chat?conversationId=12&conversationId=123"), "")
        self.assertEqual(poller.conversation_id("https://agent.example.com/chat?next=x#?conversationId=12"), "")

    def test_claimed_focus_command_cannot_trigger_fallback(self):
        with patch.multiple(poller, _cmd_done={"test-claim": time.time()}, open_conversation=Mock()):
            poller._open_fallback("1", "test-claim")
            poller.open_conversation.assert_not_called()

    def test_finished_task_leaves_live_counts(self):
        agent = FakeAgent([conversation(1)], busy=(1,))
        poller.poll_tick(agent, full=True)
        self.assertEqual(poller.view(poller.load_state())["counts"]["running"], 1)

        agent.busy.clear()                          # 任务结束
        self.stamp += 30_000
        poller.poll_tick(agent, full=False)
        state = poller.view(poller.load_state())
        self.assertEqual(state["counts"]["running"], 0)
        self.assertEqual(state["tasks"][0]["status"], "attention")

    # ── 身份校验：本机接口只认带密钥的调用方 ─────────────────────────

    def test_state_without_token_is_rejected(self):
        with self.serve() as url:
            read = requests.get(url + "/state", timeout=5)
            write = requests.post(url + "/ack?id=1", timeout=5)
        self.assertEqual(read.status_code, 401)
        self.assertEqual(read.json()["error"], "unauthorized")
        self.assertEqual(write.status_code, 401, "写接口更不能放行")

    def test_state_with_correct_token_is_allowed(self):
        agent = FakeAgent([conversation(1)])
        poller.poll_tick(agent, full=True)
        with self.serve() as url:
            read = self.auth().get(url + "/state", timeout=5)
            write = self.auth().post(url + "/ack?id=1", timeout=5)
        self.assertEqual(read.status_code, 200)
        self.assertEqual([task["id"] for task in read.json()["all"]], [1])
        self.assertEqual(write.status_code, 200)

    def test_wrong_token_is_rejected(self):
        with self.serve() as url:
            response = requests.get(url + "/state", timeout=5,
                                    headers={poller.TOKEN_HEADER: "not-the-real-key"})
        self.assertEqual(response.status_code, 401)

    def test_dashboard_page_hands_the_token_to_its_own_script(self):
        # 看板页本身免鉴权（浏览器发不出自定义头），所以它必须把密钥注入进页面，
        # 否则它自己发的 /state 请求会全部 401 —— 页面能打开却永远没有数据。
        with self.serve() as url:
            page = requests.get(url + "/", timeout=5)
        self.assertEqual(page.status_code, 200)
        self.assertIn(poller.ensure_token(), page.text)
        self.assertIn("X-TP-Token", page.text)

    def test_token_file_is_private_to_the_owner(self):
        token = poller.ensure_token()
        self.assertTrue(token)
        self.assertEqual(os.stat(poller.TOKEN_FILE).st_mode & 0o777, 0o600,
                         "密钥文件不能给别人读")
        # 已存在时不该被重新生成：换钥匙会让所有客户端立刻 401
        self.assertEqual(poller.ensure_token(), token)


class ResponseTests(unittest.TestCase):
    def client(self, status, body):
        response = SimpleNamespace(status_code=status, json=lambda: body)
        with patch.object(poller, "make_session", return_value=SimpleNamespace(request=Mock(return_value=response))):
            return poller.AgentClient()

    def test_empty_list_is_valid_and_unknown_shape_is_an_error(self):
        self.assertEqual(self.client(200, {"data": {"groups": []}}).conversations(2), [])
        with self.assertRaises(ValueError):
            self.client(200, {"data": {"items": [conversation()]}}).conversations(2)
        with self.assertRaises(ValueError):
            self.client(200, {"success": False, "data": {"groups": []}}).conversations(2)

    def test_unauthorized_list_and_unrecognized_queue_are_not_idle(self):
        with self.assertRaises(requests.HTTPError):
            self.client(401, {"data": {"groups": []}}).conversations(2)
        with self.assertRaises(ValueError):
            self.client(200, {"data": {}}).queue(1, 2)
        self.assertEqual(self.client(200, {"data": {"state": "IDLE", "pending": 0}}).queue(1, 2),
                         (False, "IDLE"))


if __name__ == "__main__":
    unittest.main()
