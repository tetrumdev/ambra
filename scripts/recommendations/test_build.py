"""Small deterministic release-pipeline tests. No downloads or provider accounts."""
import contextlib
import gzip
import io
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import build


class DatabaseBuildTests(unittest.TestCase):
    def test_core_allowlist_aliases_identifiers_and_reproducibility(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            archive = directory / 'sources.json.gz'
            source = {
                'wikidata-artists.json.gz': {'extractedAt': '2026-10-26', 'artists': [
                    {'wikidata': 'Q1', 'mbid': '00000000-0000-0000-0000-000000000001',
                     'mbids': ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
                     'name': 'Artist', 'genres': ['Q10']}]},
                'musicbrainz-core.json.gz': {'extractedAt': '2026-10-26', 'archive': 'CC0-test-fixture', 'artists': [
                    {'mbid': '00000000-0000-0000-0000-000000000001', 'name': 'Artist', 'aliases': ['Alias'], 'ambiguousNames': ['alias'],
                     'disambiguation': 'Band', 'tags': [{'name': 'must-not-import'}]}]},
                'genres-00000.json.gz': {'extractedAt': '2026-10-26', 'genres': [
                    {'wikidata': 'Q10', 'name': 'Shoegaze', 'aliases': ['Shoe gaze'], 'parents': []}]},
            }
            build.save(archive, source)
            with patch.object(build, 'SOURCE_ARCHIVE', archive), contextlib.redirect_stdout(io.StringIO()):
                one = directory / 'one.sqlite.gz'
                two = directory / 'two.sqlite.gz'
                build.build(one)
                build.build(two)
            self.assertEqual(one.read_bytes(), two.read_bytes())
            raw = gzip.decompress(one.read_bytes())
            self.assertNotIn(b'must-not-import', raw)
            path = directory / 'metadata.sqlite'
            path.write_bytes(raw)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT name FROM artists').fetchall(), [('Artist',)])
                self.assertEqual(db.execute('SELECT count(*) FROM artist_mbids').fetchone()[0], 2)
                self.assertEqual(db.execute('SELECT normalized_name FROM ambiguous_artist_names').fetchall(), [('alias',)])
                self.assertEqual(db.execute('SELECT artist_count FROM genres').fetchone()[0], 1)
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_normalization_and_postgres_copy_escaping(self):
        self.assertEqual(build.normalize('  Beyoncé & Friends '), 'beyoncé friends')
        self.assertEqual(build.unescape(r'hello\tworld\\'), 'hello\tworld\\')
        self.assertEqual(build.unescape(r'\N'), '')


if __name__ == '__main__':
    unittest.main()
