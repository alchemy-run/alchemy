# Task-system evals

Scenarios and data against the task system's typesafe control logic —
the router's tag Choice (Router.ts/Tags.ts), the scheduler's affinity
Choice (Scheduler.ts), the forgotten-line disposition Choice
(Desks.ts), and the review Noul (Review.ts) — so a rubric or prompt
tweak has a scorecard, not vibes.

## Run

```sh
cd services/root

bun eval/run.ts all                     # every scenario, scripted (default)
bun eval/run.ts routing                 # one scenario
bun eval/run.ts routing --live --cap 3  # small smoke against the real stack
bun eval/run.ts width --live --ui       # live, with the board open to watch/steer
bun eval/run.ts --report-only eval/reports/<file>.json
```

or `bun run eval <args…>`.

Two modes:

- **scripted** (default) — the scenario runs through the desk world
  (`eval/world.ts`, the same in-memory fixture
  `test/tasks/desk-loop.test.ts` asserts): desks answer from the
  scenario's scripts, while the control plane is judged by the REAL
  TypeSafe System One when `TYPESAFE_API_KEY` is set (the same
  `CredentialsFromEnv` gate as `test/gate.test.ts`). Without the key
  everything degrades to scripted/FIFO fallbacks and judged metrics
  are skipped with a notice.
- **`--live`** — against the running dev stack (UI :1337, worker
  :1340; reused if up, spawned if not, state never wiped). Arrivals
  are filed over the API without tags so the live router runs; bodies
  carry an `[eval:<runId>]` marker and scoring only ever reads this
  run's task ids. `--ui` opens the board and streams a status line —
  moving cards yourself is part of the eval: your moves land in the
  report as `humanInterventions`, never failures. Real desk rounds
  run and spend the 20/hour dispatch budget — keep live runs small
  (`--cap`).

## Read the report

Each run writes `eval/reports/<timestamp>-<scenario>.json` and prints
a table: routing accuracy, affinity-optimal rate, disposition/review
judge agreement, outcome matches, fork/merge counts, watchdog fires,
recoveries, per-task lines.

The tuning loop lives in `judgedMisses`: every miss carries the FULL
System One exchange — the wire rubric cards exactly as the model saw
them, the state, its answer and calibration, and the ground truth —
so a miss points at the rubric to tweak (edit `src/tasks/Tags.ts`,
the Choice/Noul instructions in `Router.ts` / `Scheduler.ts` /
`Review.ts` / `Desks.ts`, re-run, compare). `metrics.routing.confusion`
aggregates chose-X-truth-Y pairs across the batch.

## Add a scenario

Create `eval/scenarios/<name>.ts` exporting a `Scenario`
(`eval/scenario.ts`): arrivals with ground truth (`tags`,
`expect.tag`, `expect.disposition`, `expect.maxRounds`), scripted
`rounds` per task (a worker reply WITHOUT its DISPOSITION line
exercises the judged fallback; `expect` on a round is the judged
edge's ground truth), and `interactions` notes for the human watching
a live run. Register it in `eval/scenarios/index.ts`.
