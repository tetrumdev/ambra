"""Built client distributions must exclude every server-only runtime component."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCANNER = Path(__file__).resolve().parents[1] / "check-client-package.py"
COMPONENTS = ("ambra-server.exe", "soloist.exe", "VBCABLE_Setup_x64.exe",
              "vbaudio_cable64_win10.sys", "vbaudio_cable64_win10.cat", "vbMmeCable64_win10.inf")


class ClientPackageTests(unittest.TestCase):
    def inspect(self, package):
        return subprocess.run([sys.executable, str(SCANNER), str(package)],
                              capture_output=True, text=True).returncode

    def test_desktop_bundle_excludes_server_soloist_and_driver(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Ambra.app"
            contents = app / "Contents" / "MacOS"
            contents.mkdir(parents=True)
            (contents / "ambra").write_bytes(b"client")
            self.assertEqual(self.inspect(app), 0)
            for name in COMPONENTS:
                with self.subTest(name=name):
                    component = contents / name
                    component.write_bytes(b"must not ship")
                    self.assertNotEqual(self.inspect(app), 0)
                    component.unlink()

    def test_mobile_archives_exclude_server_soloist_and_driver(self):
        with tempfile.TemporaryDirectory() as directory:
            for extension in ("apk", "aab", "ipa"):
                package = Path(directory) / f"Ambra.{extension}"
                with zipfile.ZipFile(package, "w") as archive:
                    archive.writestr("assets/client.dat", b"client")
                self.assertEqual(self.inspect(package), 0)
                for name in COMPONENTS:
                    with self.subTest(extension=extension, name=name):
                        with zipfile.ZipFile(package, "w") as archive:
                            archive.writestr(f"assets/{name}", b"must not ship")
                        self.assertNotEqual(self.inspect(package), 0)


if __name__ == "__main__":
    unittest.main()
