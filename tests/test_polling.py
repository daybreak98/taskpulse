import tempfile
import threading
import unittest
from contextlib import ExitStack, contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests

import poller


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
            ACTIVE_FILE=str(Path(self.directory) / "active.json"),
            CONV_URL="https://agent.example.com/chat?conversationId={cid}",
            POLL_SECONDS=60,
            ACTIVE_POLL_SECONDS=10,
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

    def test_default_schedule_keeps_idle_list_cadence_and_caps_extra_queues(self):
        for busy, expected_checks in [((), 20), (range(1, 21), 30)]:
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

                clock = SimpleNamespace(monotonic=lambda: elapsed, sleep=sleep)
                with patch.multiple(poller, time=clock, AgentClient=lambda: agent):
                    with self.assertRaises(StopLoop):
                        poller._poll_forever()
                self.assertEqual(agent.list_calls, 1)
                self.assertEqual(len(agent.queue_calls), expected_checks)

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
            seen = requests.post(url + "/active", json={"url": task["url"]}, timeout=2)
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
                    response = requests.post(url + path, timeout=2)
                    self.assertTrue(response.json()["ok"])

            agent.before_queue = user_actions
            state = poller.poll_tick(agent, full=True)
            stored = requests.get(url + "/state", timeout=2).json()

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
        self.assertEqual([args[0] for args, _ in self.notifications.call_args_list],
                         ["任务疑似卡住", "任务已超时"])

    def test_missing_assistant_content_has_limited_retries(self):
        agent = FakeAgent([conversation()], busy=(1,))
        poller.poll_tick(agent, full=True)
        agent.busy.clear()
        self.stamp += 30_000
        with patch.object(poller, "FAIL_MARKS", ("已知的错误模板",)):
            for _ in range(4):
                state = poller.poll_tick(agent, full=True)
                self.stamp += 10_000
        self.assertEqual(agent.message_calls, [1, 1])
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

        with patch.multiple(poller, AgentClient=lambda: agent,
                            time=SimpleNamespace(monotonic=lambda: clock, sleep=sleep)):
            with self.assertRaises(StopLoop):
                poller._poll_forever()
        self.assertEqual(pauses, [60, 120])
        self.assertEqual(agent.queue_calls, [1, 2, 1, 1])
        self.assertIn("429", poller.load_state()["poller_error"])
        self.assertEqual(poller.load_state()["updated"], NOW)


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
