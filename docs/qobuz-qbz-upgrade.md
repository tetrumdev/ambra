# QBZ 2.1.2 in Ambra

Ambra vendors `qbz-qobuz`, `qbz-models`, and `qbz-cmaf` from [QBZ commit 455441014b38e27b1d0c4054e04e6a66aa2753db](https://github.com/volkertb/qbz/commit/455441014b38e27b1d0c4054e04e6a66aa2753db). The CMAF parser and cryptography sources match the prior pin. The CMAF changes are in the Qobuz client and Ambra's native stream adapter. QBZ's final models provide the ReplayGain and original release-date fields that Ambra previously patched in. Ambra retains its signed playlist operations and signing-secret rejection behavior.

The ordinary Qobuz stream endpoint still proxies direct audio and HTTP byte ranges. If Qobuz cannot supply a full direct stream to a lossless subscriber, Ambra can serve the lossless CMAF stream as native FLAC from the same endpoint. It translates ranges using the decrypted lengths in the init table and keeps at most three segment fetches in flight per response. The encrypted download store can consume the same stream incrementally. A provider preview is excluded from full playback and saves. Account entitlements cap the initial quality request where the subscription tiers are known, and a network or account error stops quality fallback.

`GET /api/auth/status` includes `qobuzEntitlements` when Qobuz is connected. `GET /api/providers/qobuz/tracks/{id}/radio?limit=12` returns playable recommendations for a single selected track. Discover continues to use Ambra's local recommendation engine.

Saved session JSON, metadata cache paths, and the encrypted download format remain compatible with the prior server. The source rollback point is Ambra commit `1a4980f` with its original vendored manifest and lockfile.

## Playback accounting

Ambra updates listening history when the active native output reports playback for the loaded track. URL warming, stream requests, byte-range seeks, download requests, and queueing do not write play entries. The session engine deduplicates native reports for a track start and excludes buffering, end-only, and failed reports.

Qobuz's integration guidelines require playback reporting and direct integrators to Qobuz for details. The pinned crates have no royalties reporting integration, and Ambra's local history cannot verify royalty attribution. Verifying reports end to end requires the approved partner specification and credentials, plus confirmation that Qobuz accepted the reports. [Qobuz integration guidelines](https://static.qobuz.com/apps/api/Qobuz-AppsGuidelines-V1.0.pdf)

## Performance

Benchmarked on Apple Silicon with loopback HTTP fixtures, three process runs per scenario, alternating revisions. The fixtures served 24 encrypted 2 MiB segments and validated every byte of the 48 MiB FLAC payload. Both full-download implementations retained three-way concurrency and their existing per-slot CDN pacing. Wall time excludes init and authentication. Peak footprint is the macOS process metric from `/usr/bin/time -l`.

| Full CMAF assembly, median | QBZ 2.0.2 | QBZ 2.1.2 |
| --- | ---: | ---: |
| Normal wall time | 4.44 s | 4.55 s |
| Normal process CPU time | 0.43 s | 0.45 s |
| Normal peak memory footprint | 117.4 MiB | 71.0 MiB |
| First segment delayed 800 ms, wall time | 4.92 s | 5.28 s |
| First segment delayed 800 ms, process CPU time | 0.41 s | 0.41 s |
| First segment delayed 800 ms, peak memory footprint | 114.8 MiB | 76.2 MiB |
| Media requests per full track | 24 | 24 |

Ordered, bounded full assembly lowered peak footprint by 40% with normal delivery and by 34% with the delayed segment. Its wall time increased by 2% and 7%, respectively. Ambra's incremental path uses the same segment verification and decryption and can emit audio before assembly completes. In the same fixture it delivered the first media segment in 38 ms normally and 820 ms with the injected delay. Median peak footprint was 26.2 MiB and 29.1 MiB, respectively. The range test also verified that a header-only request makes zero media requests and a range spanning two segments makes exactly two.

Stripped macOS ARM64 server builds measured 103,212,720 bytes before and 103,228,512 bytes after, an increase of 0.02%. Both used the same optimized development profile. QBZ now shares the server's reqwest 0.13 build, and Ambra's other integrations still use reqwest 0.12.

These measurements characterize local fetch, decryption, and buffering. Internet latency, device output, and Qobuz royalty processing require live verification.
