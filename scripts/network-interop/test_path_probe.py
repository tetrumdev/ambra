"""Protocol vectors and regression proof for partial signaling writes."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from path_probe import parse_raw, parse_stun, raw, read_signaling, stun, write_json


class PathProbeTests(unittest.TestCase):
    def test_rfc5769(self):
        # Public RFC 5769 section 2.1 vector, not an application credential.
        packet = bytes.fromhex(
            "000100582112a442b7e7a701bc34d686fa87dfae"
            "802200105354554e207465737420636c69656e74"
            "002400046e0001ff80290008932ff9b151263b36"
            "000600096576746a3a68367659202020"
            "000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2"
            "80280004e57a3bcf"
        )
        result = parse_stun(packet, b"VOkJxbRl1RmTxUk/WvJxBt")
        self.assertEqual(result[:2], (1, bytes.fromhex("b7e7a701bc34d686fa87dfae")))

    def test_tampered_and_truncated(self):
        key, transaction = os.urandom(32), os.urandom(12)
        packet = stun(0x101, transaction, key, ("8.8.8.8", 12345))
        self.assertEqual(parse_stun(packet, key), (0x101, transaction, ("8.8.8.8", 12345)))
        self.assertIsNone(parse_stun(packet[:-1], key))
        self.assertIsNone(parse_stun(packet, os.urandom(32)))

    def test_opaque_authentication(self):
        key, transaction = os.urandom(32), os.urandom(12)
        packet = raw(b"Q", transaction, key)
        self.assertEqual(parse_raw(packet, key), (b"Q", transaction))
        self.assertIsNone(parse_raw(packet, os.urandom(32)))

    def test_partial_signaling_and_atomic_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "peers.json"
            self.assertIsNone(read_signaling(path))
            path.write_text("[")
            self.assertIsNone(read_signaling(path))
            write_json(path, ["8.8.8.8", 443])
            self.assertEqual(read_signaling(path), ["8.8.8.8", 443])
            self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
