"""Exercise the Git guard against synthetic secrets in isolated repositories."""

from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "tools/check_secrets.py"
SYNTHETIC_TOKEN = "gh" + "p_" + "A" * 36
SYNTHETIC_PASSWORD = "synthetic-" + "password-value"


class SecretGuardTests(unittest.TestCase):
    def setUp(self):
        data_root = ROOT / ".data"
        data_root.mkdir(exist_ok=True)
        if not data_root.resolve().is_relative_to(ROOT.resolve()):
            raise RuntimeError("Test data must stay inside the repository")
        self.temp = tempfile.TemporaryDirectory(prefix="git-security-tests-", dir=data_root)
        self.repo = Path(self.temp.name).resolve()
        if not self.repo.is_relative_to(data_root.resolve()):
            raise RuntimeError("Unexpected test cleanup target")
        self.addCleanup(self.temp.cleanup)
        self.git("init")
        self.git("config", "user.name", "Security test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "commit.gpgsign", "false")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, capture_output=True, check=True)

    def scan(self, *args):
        return subprocess.run([sys.executable, str(SCANNER), *args], cwd=self.repo,
                              text=True, capture_output=True)

    def test_staged_secret_is_rejected_without_printing_value(self):
        (self.repo / "app.txt").write_text(SYNTHETIC_TOKEN)
        self.git("add", "app.txt")
        result = self.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("github-token", result.stdout)
        self.assertNotIn(SYNTHETIC_TOKEN, result.stdout + result.stderr)

    def test_private_path_forced_past_ignore_is_rejected(self):
        (self.repo / ".gitignore").write_text(".env\n*.csv\n")
        for name in (".env", "portfolio-export.csv"):
            (self.repo / name).write_text("synthetic content")
            self.git("add", "--force", name)
        result = self.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.count("sensitive-path"), 2)

    def test_index_is_scanned_instead_of_unstaged_content(self):
        path = self.repo / "app.txt"
        path.write_text("Safe staged content")
        self.git("add", "app.txt")
        path.write_text(SYNTHETIC_TOKEN)
        self.assertEqual(self.scan("--staged").returncode, 0)
        self.assertEqual(self.scan().returncode, 1)

    def test_removed_secret_is_still_detected_in_history(self):
        (self.repo / "app.txt").write_text(SYNTHETIC_TOKEN)
        self.git("add", "app.txt")
        self.git("commit", "-m", "Synthetic secret for regression test")
        self.git("rm", "app.txt")
        self.git("commit", "-m", "Remove synthetic secret")
        self.assertEqual(self.scan("--staged").returncode, 0)
        result = self.scan("--all")
        self.assertEqual(result.returncode, 1)
        self.assertIn("history:", result.stdout)
        self.assertNotIn(SYNTHETIC_TOKEN, result.stdout)

    def test_documented_placeholder_is_allowed(self):
        (self.repo / ".env.example").write_text("API_KEY=\"" + "placeholder" + "\"\n")
        self.git("add", ".env.example")
        self.assertEqual(self.scan("--staged").returncode, 0)

    def test_unquoted_secret_in_example_file_is_rejected(self):
        (self.repo / ".env.example").write_text("PASS" + "WORD=" + SYNTHETIC_PASSWORD + "\n")
        self.git("add", ".env.example")
        result = self.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("credential-assignment", result.stdout)
        self.assertNotIn(SYNTHETIC_PASSWORD, result.stdout)

    def test_json_secret_in_ordinary_file_is_rejected(self):
        (self.repo / "app.json").write_text(json.dumps({"password": SYNTHETIC_PASSWORD}))
        self.git("add", "app.json")
        result = self.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("credential-assignment", result.stdout)
        self.assertNotIn(SYNTHETIC_PASSWORD, result.stdout)


if __name__ == "__main__":
    unittest.main()
