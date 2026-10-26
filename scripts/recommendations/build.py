#!/usr/bin/env python3
"""Build release-only CC0 recommendation metadata. Python is never used by the server.

Run with --fetch to refresh checkpointed source snapshots; without it, build offline.
MusicBrainz responses are immediately reduced to an allowlist of CC0 core fields.
Tags, ratings, biographies and other supplementary data are never written to snapshots.
"""
import argparse
import datetime
import gzip
import hashlib
import json
import pathlib
import re
import sqlite3
import time
import tarfile
import http.client
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
SNAPSHOTS = HERE / 'snapshots'
SOURCE_ARCHIVE = HERE / 'sources.json.gz'
AGENT = 'AMBRA-metadata/1.0 (https://github.com/tetrumdev/ambra)'
DEFAULT_CORE_ARCHIVE = 'https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20261024-102842/mbdump.tar.bz2'


def normalize(name):
    # Keep diacritics and word boundaries; do not conflate unrelated artist names.
    return ' '.join(''.join(c.lower() if c.isalnum() else ' ' for c in name).split())


def save(path, value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    path.write_bytes(gzip.compress(data, mtime=0))


def read(path):
    return json.loads(gzip.decompress(path.read_bytes()))


def request(url):
    for attempt in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': AGENT, 'Accept': 'application/json'}), timeout=100) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, http.client.IncompleteRead) as error:
            if attempt == 7:
                raise
            delay = min(60, 2 ** (attempt + 1))
            if isinstance(error, urllib.error.HTTPError):
                delay = max(delay, min(120, int(error.headers.get('Retry-After', '0') or '0')))
            print(f'Retrying after {delay}s: {error}', flush=True)
            time.sleep(delay)


def sparql(query):
    return request('https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': query, 'format': 'json'}))['results']['bindings']


def value(row, field):
    return row.get(field, {}).get('value', '')


def qid(uri):
    return uri.rsplit('/', 1)[-1]


def fetch_musicbrainz_dump(dump_url):
    """Stream only the artist/artist_alias tables from the CC0 core archive.

    Do not download the remaining archive. No supplementary dump is opened.
    Keep the allowlisted subset so offline regeneration needs no network.
    """
    path = SNAPSHOTS / 'musicbrainz-core.json.gz'
    if path.exists():
        if read(path).get('archive') != dump_url:
            raise ValueError('Core archive changed; clear the snapshots cache before refreshing.')
        return
    wanted = {identity for a in read(SNAPSHOTS / 'wikidata-artists.json.gz')['artists'] for identity in a.get('mbids', [a['mbid']])}
    core = {}
    name_owners = {}
    ambiguous = set()
    def register(name, owner):
        normalized = normalize(name)
        previous = name_owners.setdefault(normalized, owner)
        if previous != owner:
            ambiguous.add(normalized)
    headers = {'User-Agent': AGENT}
    found_aliases = False
    with urllib.request.urlopen(urllib.request.Request(dump_url, headers=headers), timeout=120) as response:
        with tarfile.open(fileobj=response, mode='r|bz2', bufsize=1024 * 1024) as archive:
            for member in archive:
                print(f'MusicBrainz core table {member.name}: {member.size} bytes', flush=True)
                if member.name == 'COPYING':
                    license_text = archive.extractfile(member).read().decode()
                    if 'CC0' not in license_text:
                        raise ValueError('Archive does not identify its CC0 core license')
                elif member.name == 'mbdump/artist':
                    for encoded in archive.extractfile(member):
                        line = encoded.decode('utf-8')
                        fields = line.rstrip('\n').split('\t')
                        register(unescape(fields[2]), fields[0])
                        if fields[1] in wanted:
                            core[fields[0]] = {'mbid': fields[1], 'name': unescape(fields[2]),
                                'disambiguation': unescape(fields[13]), 'aliases': []}
                    print(f'Matched {len(core)} MusicBrainz core artists', flush=True)
                elif member.name == 'mbdump/artist_alias':
                    found_aliases = True
                    for encoded in archive.extractfile(member):
                        line = encoded.decode('utf-8')
                        fields = line.rstrip('\n').split('\t')
                        register(unescape(fields[2]), fields[1])
                        if fields[1] in core:
                            core[fields[1]]['aliases'].append(unescape(fields[2]))
                    break
    if not core or not found_aliases:
        raise ValueError('No MusicBrainz artists extracted')
    for artist in core.values():
        artist['aliases'] = sorted(set(artist['aliases']))
        artist['ambiguousNames'] = sorted({normalize(name) for name in [artist['name'], *artist['aliases']] if normalize(name) in ambiguous})
    save(path, {'extractedAt': datetime.date.today().isoformat(), 'archive': dump_url,
        'tables': ['artist', 'artist_alias'], 'artists': sorted(core.values(), key=lambda a: a['mbid'])})


def unescape(text):
    if text == r'\N':
        return ''
    return re.sub(r'\\([\\tnr])', lambda m: {'t': '\t', 'n': '\n', 'r': '\r', '\\': '\\'}[m[1]], text)


def fetch(dump_url):
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOTS / 'wikidata-artists.json.gz'
    if not path.exists():
        # Only artists with explicit genres and an MBID. No per-track or user data.
        rows = sparql('SELECT ?a ?m ?g WHERE { ?a wdt:P434 ?m; wdt:P136 ?g }')
        artists = {}
        for row in rows:
            identity = qid(value(row, 'a'))
            mbid = value(row, 'm')
            try:
                uuid.UUID(mbid)
            except ValueError:
                continue
            artist = artists.setdefault(identity, {'wikidata': identity, 'mbid': mbid, 'name': value(row, 'name'), 'genres': [], 'mbids': []})
            artist['genres'].append(qid(value(row, 'g')))
            artist['mbids'].append(str(uuid.UUID(mbid)))
        for artist in artists.values():
            artist['genres'] = sorted(set(artist['genres']))
            artist['mbids'] = sorted(set(artist['mbids']))
        save(path, {'extractedAt': datetime.date.today().isoformat(), 'artists': sorted(artists.values(), key=lambda a: a['wikidata'])})
    artists = read(path)['artists']
    fetch_musicbrainz_dump(dump_url)
    genre_ids = sorted({g for a in artists for g in a['genres']})
    for offset in range(0, len(genre_ids), 150):
        path = SNAPSHOTS / f'genres-{offset:05}.json.gz'
        if path.exists():
            continue
        ids = genre_ids[offset:offset + 150]
        query = '''SELECT ?g ?name ?alias ?parent WHERE { VALUES ?g { %s }
          OPTIONAL { ?g rdfs:label ?name FILTER(LANG(?name)="en") }
          OPTIONAL { ?g skos:altLabel ?alias FILTER(LANG(?alias)="en") }
          OPTIONAL { ?g wdt:P279 ?parent } }''' % ' '.join('wd:' + g for g in ids)
        rows = sparql(query)
        genres = {g: {'wikidata': g, 'name': '', 'aliases': [], 'parents': []} for g in ids}
        for row in rows:
            genre = genres[qid(value(row, 'g'))]
            genre['name'] = value(row, 'name') or genre['name']
            if value(row, 'alias'):
                genre['aliases'].append(value(row, 'alias'))
            if value(row, 'parent'):
                genre['parents'].append(qid(value(row, 'parent')))
        for genre in genres.values():
            genre['aliases'] = sorted(set(genre['aliases']))
            genre['parents'] = sorted(set(genre['parents']))
        save(path, {'extractedAt': datetime.date.today().isoformat(), 'genres': list(genres.values())})
        print(f'Genres {offset + len(ids)}/{len(genre_ids)}', flush=True)
        time.sleep(1)
    # Stable catalog IDs let runtime avoid unsafe same-name matches.
    for provider, prop in [('spotify', 'P1902'), ('tidal', 'P4576'), ('qobuz', 'P11578')]:
        path = SNAPSHOTS / f'provider-{provider}.json.gz'
        if not path.exists():
            rows = sparql(f'SELECT ?a ?id WHERE {{ ?a wdt:{prop} ?id }}')
            wanted = {a['wikidata'] for a in artists}
            pairs = sorted({(qid(value(r, 'a')), value(r, 'id')) for r in rows if qid(value(r, 'a')) in wanted})
            save(path, {'extractedAt': datetime.date.today().isoformat(), 'provider': provider, 'ids': pairs})

def archive_sources():
    sources = sorted(p for p in SNAPSHOTS.glob('*.json.gz') if not p.name.startswith('wikidata-shard-'))
    if (SNAPSHOTS / 'musicbrainz-core.json.gz').exists():
        sources = [p for p in sources if not re.match(r'musicbrainz-\d', p.name)]
    save(SOURCE_ARCHIVE, {p.name: read(p) for p in sources})


def build(output):
    if not SOURCE_ARCHIVE.exists():
        archive_sources()
    snapshots = read(SOURCE_ARCHIVE)
    sources = sorted(snapshots)
    if not sources:
        raise SystemExit('Missing source snapshots. Run --fetch first.')
    wiki = snapshots['wikidata-artists.json.gz']['artists']
    labels = {wid: name for p in sources if p.startswith('labels-') for wid, name in snapshots[p]['labels']}
    for artist in wiki:
        artist['name'] = labels.get(artist['wikidata'], artist['name'])
    mb = {a['mbid']: a for p in sources if p.startswith('musicbrainz-') for a in snapshots[p]['artists']}
    genres = {g['wikidata']: g for p in sources if p.startswith('genres-') for g in snapshots[p]['genres'] if g['name']}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(temporary)
    db.executescript((ROOT / 'server/assets/recommendations-schema.sql').read_text())
    genre_map = {}
    for i, (wid, g) in enumerate(sorted(genres.items()), 1):
        genre_map[wid] = i
        db.execute('INSERT INTO genres VALUES(?,?,?,?,0)', (i, wid, g['name'], normalize(g['name'])))
        for alias in sorted({g['name'], *g['aliases']}):
            if normalize(alias):
                db.execute('INSERT OR IGNORE INTO genre_aliases VALUES(?,?)', (normalize(alias), i))
    artist_map = {}
    enriched_count = 0
    for a in sorted(wiki, key=lambda a: a['wikidata']):
        identities = []
        for identity in a.get('mbids', [a['mbid']]):
            try:
                identities.append(str(uuid.UUID(identity)))
            except ValueError:
                continue
        if not identities:
            continue
        cores = [mb[identity] for identity in identities if identity in mb]
        cores.sort(key=lambda core: (normalize(core['name']) != normalize(a['name']), core['mbid']))
        core = cores[0] if cores else {}
        name = core.get('name') or a['name']
        matched_genres = sorted({genre_map[g] for g in a['genres'] if g in genre_map})
        if not name or not matched_genres:
            continue
        enriched_count += bool(core)
        i = len(artist_map) + 1
        artist_map[a['wikidata']] = i
        db.execute('INSERT INTO artists VALUES(?,?,?,?)', (i, int(a['wikidata'][1:]), name, core.get('disambiguation', '')))
        db.executemany('INSERT INTO artist_mbids VALUES(?,?)', [(uuid.UUID(identity).bytes, i) for identity in identities])
        aliases = {name, a['name']}
        for item in cores:
            aliases.update([item['name'], *item.get('aliases', [])])
            db.executemany('INSERT OR IGNORE INTO ambiguous_artist_names VALUES(?)', [(name,) for name in item.get('ambiguousNames', [])])
        for alias in sorted(aliases):
            if normalize(alias):
                db.execute('INSERT OR IGNORE INTO artist_aliases VALUES(?,?)', (normalize(alias), i))
        db.executemany('INSERT INTO artist_genres VALUES(?,?)', [(i, g) for g in matched_genres])
    # P279 only, one hop at runtime, and both endpoints must already be genres used by artists.
    for wid, g in sorted(genres.items()):
        for parent in g['parents']:
            if parent in genre_map and parent != wid:
                db.execute('INSERT OR IGNORE INTO genre_parents VALUES(?,?)', (genre_map[wid], genre_map[parent]))
    for path in sources:
        if not path.startswith('provider-'):
            continue
        source = snapshots[path]
        for wid, identity in source['ids']:
            if wid in artist_map:
                db.execute('INSERT OR IGNORE INTO artist_provider_ids VALUES(?,?,?)', (artist_map[wid], source['provider'], identity))
    db.execute('UPDATE genres SET artist_count=(SELECT count(*) FROM artist_genres WHERE genre_id=genres.id)')
    manifest = {'schemaVersion': 1, 'license': 'CC0-1.0', 'methodology': 'scripts/recommendations/build.py',
                'sources': [{'file': p, 'extractedAt': snapshots[p]['extractedAt']} for p in sources],
                'sourceArchiveSha256': hashlib.sha256(SOURCE_ARCHIVE.read_bytes()).hexdigest(),
                'wikidata': 'https://www.wikidata.org/wiki/Wikidata:Licensing',
                'musicbrainz': 'https://musicbrainz.org/doc/About/Data_License',
                'musicbrainzEnrichedArtists': enriched_count,
                'musicbrainzCoreArchive': snapshots.get('musicbrainz-core.json.gz', {}).get('archive'),
                'musicbrainzCoreTables': ['artist', 'artist_alias'],
                'sqliteVersion': sqlite3.sqlite_version,
                'coverage': {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in ['artists', 'artist_mbids', 'genres', 'artist_genres', 'artist_aliases', 'ambiguous_artist_names', 'genre_parents', 'artist_provider_ids']}}
    db.execute('INSERT INTO metadata VALUES(?,?)', ('provenance', json.dumps(manifest, sort_keys=True)))
    db.commit()
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    db.execute('VACUUM')
    db.close()
    raw = temporary.read_bytes()
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    output.write_bytes(compressed)
    temporary.unlink()
    manifest.update({'sqliteBytes': len(raw), 'gzipBytes': len(compressed), 'sqliteSha256': hashlib.sha256(raw).hexdigest(), 'gzipSha256': hashlib.sha256(compressed).hexdigest()})
    output.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'sources'}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--musicbrainz-dump', default=DEFAULT_CORE_ARCHIVE, help='Pinned URL of a MusicBrainz CC0 mbdump.tar.bz2 core archive; stream only artist tables.')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'server/assets/recommendations.sqlite.gz')
    args = parser.parse_args()
    if args.fetch:
        fetch(args.musicbrainz_dump)
        archive_sources()
    build(args.output)
