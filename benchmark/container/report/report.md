# Cold-start benchmark

Run `2026-06-30T08-13-56-066Z` — 550 samples. Metric: **time to usable service** (host start → first successful request).

Methodology: targets run sequentially so they never contend for shared quotas. Containers are measured under concurrent load (10 rounds × 10 simultaneous boots). MicroVMs are measured **independently** — 25 serial boots at concurrency 1 — because the Lambda MicroVM API is throttled per account/Region (RunMicrovm 5 TPS/burst 5, TerminateMicrovm 10 TPS), so concurrent boots would measure API admission rather than VM cold start. Each boot launches, waits until the service is usable, then terminates before the next; the image is pre-warmed once (untimed) so we measure cold start, not first-pull distribution.

| environment | variant | ok | ready p50 | ready p95 | ready mean | ready max | first → last round (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| container | effectful | 100/100 | 1.4s | 8.6s | 2.5s | 17.2s | 6.6s → 1.3s |
| container | bun | 100/100 | 1.0s | 10.4s | 2.3s | 12.4s | 5.7s → 1.2s |
| container | remote | 100/100 | 1.5s | 10.5s | 2.8s | 19.8s | 7.7s → 1.5s |
| lambda→microvm | effectful-bun | 25/25 | 2.9s | 3.6s | 3.0s | 5.0s | 2.0s → 3.6s |
| lambda→microvm | effectful-node | 25/25 | 3.0s | 3.9s | 2.9s | 4.4s | 3.4s → 2.6s |
| lambda→microvm | bun | 25/25 | 2.6s | 3.3s | 2.6s | 3.9s | 3.0s → 2.7s |
| lambda→microvm | node | 25/25 | 3.1s | 4.5s | 3.1s | 4.5s | 2.5s → 3.2s |
| lambda→microvm | external | 25/25 | 2.2s | 3.1s | 2.2s | 4.0s | 2.1s → 2.2s |
| worker→microvm | effectful-bun | 23/25 | 3.0s | 3.7s | 2.9s | 4.1s | 3.7s → 2.9s |
| worker→microvm | effectful-node | 25/25 | 3.0s | 4.1s | 3.0s | 4.3s | 3.0s → 1.7s |
| worker→microvm | bun | 25/25 | 3.1s | 3.6s | 3.0s | 3.7s | 3.3s → 3.2s |
| worker→microvm | node | 24/25 | 3.3s | 4.9s | 3.2s | 5.3s | 2.9s → 3.1s |
| worker→microvm | external | 25/25 | 2.4s | 2.6s | 2.3s | 3.5s | 2.3s → 2.4s |

Raw per-boot samples: `data/samples-2026-06-30T08-13-56-066Z.csv`. Aggregates: `report/summary.csv`.
