# Bundled recommendation metadata

`recommendations.sqlite.gz` is a release asset derived only from CC0 Wikidata
structured data and MusicBrainz core artist metadata. It is embedded in every
AMBRA Rust server binary, including standalone installations. No runtime data
source download is required.

`recommendations.sqlite.manifest.json` records source dates, licensing links,
coverage, sizes, the pinned MusicBrainz core archive, toolchain metadata, and
SHA-256 digests. The SQLite database also contains its source provenance.

See [`docs/recommendations.md`](../../docs/recommendations.md) for licenses,
methodology, architecture, schema details, measured coverage, and limitations.
Rebuild offline with `python3 scripts/recommendations/build.py` from the repository
root. The source snapshot and generator are release tools, not runtime services.
