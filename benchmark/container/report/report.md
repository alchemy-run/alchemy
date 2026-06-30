# Cold-start benchmark

Run `2026-06-30T06-44-37-666Z` — 500 samples. Metric: **time to usable service** (host start → first successful request).

Methodology: 10 batches × CONCURRENCY concurrent boots per variant (containers 10, MicroVM 5); each batch boots all at once, waits for every instance to become usable, then shuts them down before the next. The image is pre-warmed once (untimed) so we measure cold start, not first-pull distribution.

| environment | variant | ok | ready p50 | ready p95 | ready mean | ready max | batch 1 → last (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| container | effectful | 100/100 | 1.5s | 7.5s | 2.9s | 24.3s | 8.6s → 1.2s |
| container | bun | 100/100 | 1.4s | 10.4s | 2.8s | 16.8s | 6.5s → 1.2s |
| container | remote | 100/100 | 1.9s | 9.9s | 3.3s | 22.2s | 8.5s → 1.7s |
| lambda→microvm | effectful | 50/50 | 3.0s | 4.4s | 2.9s | 4.9s | 4.3s → 2.8s |
| lambda→microvm | external | 50/50 | 2.1s | 2.4s | 2.0s | 2.5s | 2.0s → 1.8s |
| worker→microvm | effectful | 50/50 | 3.2s | 3.8s | 3.1s | 4.1s | 2.7s → 3.4s |
| worker→microvm | external | 50/50 | 2.0s | 2.8s | 2.1s | 3.3s | 1.9s → 2.0s |

Raw per-boot samples: `data/samples-2026-06-30T06-44-37-666Z.csv`. Aggregates: `report/summary.csv`.
