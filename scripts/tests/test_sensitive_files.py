import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
REPORT = pathlib.Path(
    "docs/networking/results/tailcat-2026-11-13/invalid-credential.json"
)


class SensitiveFilesTest(unittest.TestCase):
    def check_file(self, name, content, expected):
        with tempfile.TemporaryDirectory() as directory:
            cwd = pathlib.Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            path = cwd / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            subprocess.run(["git", "add", "--", str(name)], cwd=cwd, check=True)
            result = subprocess.run(
                ["bash", str(ROOT / "scripts/check-sensitive-files.sh"), "--staged"],
                cwd=cwd,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_reviewed_report_allowed(self):
        self.check_file(REPORT, (ROOT / REPORT).read_bytes(), 0)

    def test_changed_report_blocked(self):
        self.check_file(REPORT, (ROOT / REPORT).read_bytes() + b"\n", 1)

    def test_credential_file_blocked(self):
        self.check_file(pathlib.Path("credentials.json"), b"{}", 1)

    def test_secret_content_blocked(self):
        secret = ('{"password": "' + "x" * 32 + '"}').encode()
        self.check_file(pathlib.Path("report.json"), secret, 1)

    def test_single_quoted_secret_blocked(self):
        secret = ("password = '" + "x" * 32 + "'").encode()
        self.check_file(pathlib.Path("config.py"), secret, 1)

    def test_unquoted_secret_blocked(self):
        secret = ("password=" + "x" * 32).encode()
        self.check_file(pathlib.Path("config.txt"), secret, 1)

    def test_source_expression_allowed(self):
        self.check_file(
            pathlib.Path("config.rs"),
            b"refresh_token: refresh_token.to_owned(),",
            0,
        )


if __name__ == "__main__":
    unittest.main()
