import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / "packaging" / "api_runtime.sh"


class ApiRuntimeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / "home"
        self.config_dir = self.home / ".taskpulse"
        self.config_dir.mkdir(parents=True)
        self.uv = self.home / ".local" / "bin" / "uv"
        self.uv.parent.mkdir(parents=True)
        self.uv.write_text(
            '#!/bin/bash\n'
            'while [ "$1" != python ]; do shift; done\n'
            'shift\n'
            'exec "$TASKPULSE_TEST_PYTHON" "$@"\n',
            encoding="utf-8",
        )
        self.uv.chmod(0o755)
        self.script_dir = self.root / "TaskPulse"
        self.script_dir.mkdir()

    def resolve(self):
        return subprocess.run(
            ["bash", "-uc",
             r'source "$1" || exit 1; printf "%s\0" "$POLLER_PATH" "${API_RUN[@]}"',
             "test-api-runtime", str(HELPER)],
            cwd=self.script_dir,
            env={**os.environ, "HOME": str(self.home), "TASKPULSE_TEST_PYTHON": sys.executable},
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_bundle_runtime_takes_precedence_over_an_old_sibling_script(self):
        poller = self.root / "My Copy.app" / "Contents" / "Resources" / "poller.py"
        poller.parent.mkdir(parents=True)
        poller.touch()
        (self.script_dir / "poller.py").touch()
        runtime_uv = self.root / "custom tools" / "uv"
        runtime_uv.parent.mkdir()
        runtime_uv.symlink_to(self.uv)
        args = ["--with", "ks-aimate==1.5.3", "--find-links", "/tmp/Local Wheels"]
        (self.config_dir / "runtime.json").write_text(
            json.dumps({"poller": str(poller), "uv": str(runtime_uv), "args": args}),
            encoding="utf-8",
        )

        result = self.resolve()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.split("\0")[:-1],
            [str(poller), str(runtime_uv), "run", "--quiet", "--no-project", "--python", ">=3.10",
             "--with", "requests>=2.31.0,<3", *args],
        )

    def test_legacy_layout_and_repository_layout_without_runtime_json(self):
        for poller in (self.script_dir / "poller.py", self.root / "poller.py"):
            with self.subTest(poller=poller):
                poller.touch()
                result = self.resolve()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.split("\0")[0], str(poller.resolve()))
                poller.unlink()

    def test_missing_backend_returns_an_initialization_error(self):
        result = self.resolve()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("完成初始化", result.stderr)
