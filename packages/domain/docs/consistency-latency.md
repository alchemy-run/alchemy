# Design: how long a command takes, and how to make it shorter

Status: measured on 2026-11-17 at `consistency: "strong"` as first built (the Api's command handler polls each view). Nothing here is optimised yet. The options at the end are proposals.

Because of these numbers a command is `"eventual"` unless it asks for `"strong"`, or its client was built with `Domain.DefaultConsistency` set to `"strong"`. The default can be reconsidered once a strong command costs about what an eventual one does.

## What a command does

A command sent through an Api takes these steps:

1. The front (a Worker, or a server) calls the aggregate instance's object. The object decides, and stores the events, the state, the receipt and one outbox row per delivery in one transaction. It answers.
2. After it answers, the object drains its outbox: it calls each view key the events reach, one after another. A view key applies the delivery in its own transaction. A view fed by a view repeats this from the first view's object.
3. With `consistency: "eventual"` the front answers after step 1.
4. With `consistency: "strong"` the front then reads every view key the events reach, all at once, and compares its checkpoints. If any is behind, it pauses 25ms and reads again, until all have the events or 10 seconds pass.

So an eventual command costs one call. A strong one costs that call, the time the deliveries take, and at least one read of each view key from the front, rounded up to the next 25ms pause.

## How it was measured

`packages/integration-tests/test/Domain/conformance/latency.ts` times commands from inside the front, through the Api's in-process client, so the caller's own network is not in the numbers. Each cell sends commands one after another, on four lanes at once (two on the local platforms), and reports the time of each.

The shapes are in `latency-model.ts`: an aggregate with no view, one view, four views, a view fed by a view, and a view keyed by a group that many instances share. The conformance suite's `Counter` is the last shape: two views, a policy that starts a saga, and a projection fed by a view.

An instance is **warm** when it has just taken a command, **idle** when it and its views were left alone for 45 seconds (long enough for Cloudflare to unload them), and **new** when the command is the first it has ever taken, so its object and its views' objects do not exist yet.

Cloudflare ran live, with the front in Seattle, twice: with the model's Durable Objects created near the front (the default), and with all of them created in Asia-Pacific (`locationHint: "apac"`). Rivet and Effect Cluster ran in Docker on one laptop, so their numbers have no network in them: they show the floor of the protocol, not what a deployment sees.

Each warm and new cell is 300 commands on Cloudflare and 200 on the local platforms. Each idle cell is 120.

What the numbers do not include: the caller's round trip to the front, and commands that failed. The harness of that run sent a failed request again without counting it, so a `ConsistencyTimeout` is missing from the tables. The harness now counts them.

## Results

Every cell is p50 / p90 / p99 / max, in milliseconds.

### Cloudflare, objects near the front

| Shape | Instance | Eventual | Strong |
|---|---|---|---|
| No view | warm | 27 / 35 / 47 / 50 | 30 / 38 / 48 / 63 |
| No view | idle 45s | 114 / 396 / 871 / 1012 | 115 / 388 / 870 / 1012 |
| No view | new | 485 / 696 / 2185 / 7009 | 468 / 704 / 988 / 1369 |
| One view | warm | 55 / 78 / 106 / 204 | 89 / 140 / 986 / 1207 |
| One view | idle 45s | 147 / 256 / 743 / 813 | 204 / 407 / 786 / 935 |
| One view | new | 554 / 845 / 1085 / 1806 | 1000 / 1559 / 1929 / 2094 |
| Four views | warm | 63 / 85 / 137 / 168 | 370 / 419 / 576 / 2178 |
| Four views | idle 45s | 190 / 731 / 6388 / 7415 | 818 / 1317 / 1764 / 1926 |
| Four views | new | 492 / 808 / 1477 / 7096 | 1733 / 2287 / 5005 / 9959 |
| A view fed by a view | warm | 61 / 100 / 871 / 1654 | 156 / 323 / 1000 / 1145 |
| A view fed by a view | new | 510 / 743 / 1099 / 1293 | 2448 / 3440 / 4654 / 5012 |
| A view keyed by a shared group | warm | 81 / 159 / 284 / 1337 | 136 / 192 / 371 / 982 |
| A view keyed by a shared group | new | 586 / 796 / 1285 / 4896 | 597 / 985 / 1625 / 8062 |
| Two views, a policy, a saga and a projection | warm | 151 / 200 / 268 / 450 | 213 / 355 / 736 / 950 |
| Two views, a policy, a saga and a projection | new | 598 / 846 / 1548 / 3201 | 1637 / 2118 / 2570 / 3460 |

After an eventual command to a warm instance with one view, a reader polling the view saw the command after 74 / 121 / 301 / 410. One read of that view from the front takes 63 / 83 / 106 / 114.

### Cloudflare, objects a continent from the front

| Shape | Instance | Eventual | Strong |
|---|---|---|---|
| No view | warm | 170 / 286 / 536 / 5578 | 183 / 269 / 296 / 477 |
| No view | idle 45s | 194 / 416 / 488 / 490 | 222 / 433 / 695 / 727 |
| No view | new | 652 / 901 / 1363 / 2460 | 613 / 824 / 1120 / 2899 |
| One view | warm | 169 / 200 / 428 / 2031 | 337 / 412 / 2479 / 5937 |
| One view | idle 45s | 241 / 473 / 2403 / 2549 | 451 / 854 / 1076 / 1184 |
| One view | new | 649 / 813 / 5698 / 7156 | 1631 / 2088 / 3171 / 10137 |
| Four views | warm | 124 / 191 / 400 / 2259 | 497 / 647 / 2380 / 9233 |
| Four views | idle 45s | 245 / 470 / 2335 / 2384 | 585 / 995 / 2005 / 2303 |
| Four views | new | 647 / 857 / 1096 / 2436 | 2763 / 3343 / 7992 / 15337 |
| A view fed by a view | warm | 184 / 247 / 795 / 2850 | 779 / 916 / 1076 / 1128 |
| A view fed by a view | new | 712 / 842 / 3053 / 3312 | 2562 / 3289 / 5423 / 5936 |
| A view keyed by a shared group | warm | 202 / 229 / 313 / 346 | 368 / 459 / 485 / 536 |
| A view keyed by a shared group | new | 662 / 828 / 975 / 1319 | 933 / 1170 / 1655 / 2841 |
| Two views, a policy, a saga and a projection | warm | 209 / 255 / 269 / 390 | 413 / 444 / 464 / 1546 |
| Two views, a policy, a saga and a projection | new | 667 / 844 / 1057 / 2553 | 2072 / 2477 / 3946 / 6130 |

After an eventual command to a warm instance with one view, a reader polling the view saw the command after 138 / 152 / 184 / 329. One read of that view from the front takes 210 / 220 / 234 / 355.

### Rivet, local Docker

| Shape | Instance | Eventual | Strong |
|---|---|---|---|
| No view | warm | 3 / 5 / 6 / 8 | 3 / 4 / 7 / 7 |
| No view | new | 14 / 17 / 20 / 22 | 14 / 17 / 24 / 27 |
| One view | warm | 5 / 7 / 12 / 13 | 8 / 10 / 11 / 14 |
| One view | new | 23 / 29 / 38 / 48 | 60 / 64 / 73 / 73 |
| Four views | warm | 5 / 8 / 13 / 19 | 37 / 41 / 46 / 93 |
| Four views | new | 64 / 80 / 100 / 158 | 134 / 183 / 419 / 3426 |
| A view fed by a view | warm | 7 / 13 / 120 / 159 | 20 / 36 / 78 / 104 |
| A view fed by a view | new | 56 / 117 / 240 / 320 | 124 / 152 / 261 / 536 |
| A view keyed by a shared group | warm | 6 / 9 / 18 / 19 | 12 / 35 / 43 / 47 |
| A view keyed by a shared group | new | 22 / 31 / 153 / 265 | 44 / 48 / 70 / 154 |
| Two views, a policy, a saga and a projection | warm | 7 / 12 / 20 / 36 | 38 / 42 / 47 / 48 |
| Two views, a policy, a saga and a projection | new | 97 / 183 / 288 / 300 | 157 / 288 / 671 / 3467 |

After an eventual command to a warm instance with one view, a reader polling the view saw the command after 7 / 10 / 50 / 57. One read of that view from the front takes 1 / 2 / 6 / 6.

### Effect Cluster, local Docker

| Shape | Instance | Eventual | Strong |
|---|---|---|---|
| No view | warm | 2 / 4 / 6 / 7 | 2 / 4 / 5 / 7 |
| No view | new | 6 / 8 / 12 / 15 | 5 / 7 / 8 / 13 |
| One view | warm | 4 / 5 / 6 / 7 | 5 / 7 / 30 / 37 |
| One view | new | 12 / 17 / 20 / 25 | 37 / 43 / 48 / 50 |
| Four views | warm | 3 / 5 / 10 / 12 | 36 / 43 / 55 / 56 |
| Four views | new | 32 / 57 / 81 / 129 | 63 / 68 / 94 / 505 |
| A view fed by a view | warm | 3 / 5 / 7 / 8 | 9 / 13 / 25 / 35 |
| A view fed by a view | new | 18 / 32 / 42 / 56 | 40 / 42 / 70 / 215 |
| A view keyed by a shared group | warm | 3 / 4 / 7 / 11 | 5 / 6 / 8 / 8 |
| A view keyed by a shared group | new | 7 / 10 / 14 / 15 | 8 / 11 / 37 / 41 |
| Two views, a policy, a saga and a projection | warm | 3 / 5 / 12 / 16 | 34 / 40 / 49 / 52 |
| Two views, a policy, a saga and a projection | new | 38 / 51 / 92 / 119 | 44 / 64 / 148 / 329 |

After an eventual command to a warm instance with one view, a reader polling the view saw the command after 3 / 4 / 6 / 7. One read of that view from the front takes 1 / 1 / 2 / 2.
## What the numbers say

**An eventual command is one call.** On Cloudflare that is about 30ms to a warm instance with no view, and 55 to 80ms when it has views, because the commit also stores the outbox. On the local platforms it is 2 to 7ms.

**A strong command to a warm instance on Cloudflare is 90 to 400ms at the median, and about a second at p99.** One view adds about 35ms to the median. Each further view adds 70 to 90ms, which is one delivery: the outbox calls the views one after another, and the command waits for the last.

**The tail is the platform loading objects, not the wait.** A command to an idle instance with no view, which waits for nothing, has a p99 of 870ms. Idle and new instances pay to load or create every object the command touches, and a strong command touches the aggregate and each view key twice (the delivery and the read).

**The first command to a new instance is the slowest.** It takes about half a second eventual, and 1 to 2.5 seconds strong at the median, with a p99 of 2 to 5 seconds. Four new views reached 10 seconds, which is the timeout.

**A view many instances share is cheap to wait for.** Its object is warm even when the instance is new, so a strong command to a new instance costs what an eventual one does.

**Distance costs a round trip per call.** With the objects a continent from the front, an eventual command is 170ms and a strong one 340 to 780ms at the median. The objects were all in one place here, so the deliveries between them stayed short: the cost is the front's own calls, which a strong command makes at least twice.

**On the local platforms the pause is most of the wait.** A view has the events 3 to 9ms after the commit, but a strong command with four views takes 36ms: one of the four is behind on the first read, and the front pauses 25ms.

## What to tell people

On Cloudflare, with the model near its callers:

- An eventual command answers in 30 to 100ms.
- A strong command usually answers in 100 to 400ms, and within a second 99 times in 100, on instances in use. It grows with each view its events reach.
- The first command to a new instance takes about half a second eventual, and 1 to 2.5 seconds strong.
- A model whose objects are far from the front adds 100 to 300ms to each.

Rivet and Effect Cluster have only been measured locally, where an eventual command is 2 to 7ms and a strong one 5 to 40ms. A deployment adds its network to each call.

## Where views end up on Cloudflare

A Durable Object is created near whoever first calls it, and stays there. A view key is first called by the aggregate object that delivers to it, so a view keyed by its aggregate sits next to it. That is the common case, and it is why the deliveries here were short.

A view keyed by something else is created near the first instance that reaches it. Instances that feed it later from other regions each pay a cross-region delivery, and a strong command waits for it. A front far from the model pays for every call it makes, as measured above. `locationHint` puts a whole model in one region; it cannot put a view near each of its callers.

## Options

None of these is built. They are ordered by how much they save for how little they change.

### 1. Wait in the aggregate, not the front

The aggregate's object already knows when its deliveries have been applied: a delivery to a view key returns once the key has stored it. For a strong command the object can drain its outbox before it answers, and the front makes no reads at all.

This removes the 25ms pause, the reads from the front, and the front's distance from the wait: the calls that remain are between objects that sit together. It needs no data migration. A view fed by a view has to pass its own acknowledgement back, and a command that reaches a view through a decision's several commits has one outbox per instance.

It also fits read replicas: a view key acknowledges after its replicas have the events, and nothing else changes.

### 2. Deliver to views at once

The outbox calls each target in turn. Deliveries to different view keys do not depend on each other, so they can run together, keeping the order per target. Four views would then cost about what one does. No data migration.

### 3. Pace the wait better

If the wait stays in the front, start with short pauses (1, 2, 5, 10ms) before settling at 25ms, or have the view key hold a read until it has the events. This matters most where calls are fast: locally, it would take a strong command with four views from 36ms to under 10. No data migration.

### 4. Keep a view in its aggregate's object

A view that reads one aggregate and is keyed by it needs no delivery: the aggregate's object can fold the events into the view's state in the commit's own transaction. The command then costs one call, strong or eventual, and the view can never be behind.

What it costs:

- **Reads move to the writer.** Every `get`, `list` and `watch` of the view lands on the aggregate's object, which takes commands one at a time. Read replicas would then copy from the aggregate.
- **Existing data has to move.** The state is in the view key's object today. The aggregate has every event the view needs, so it can rebuild the view from its own log the first time it loads, with no call to another object. The old view objects are then garbage to collect.
- **It only fits some views.** A view with routes, a shared key or several sources still needs deliveries, as does anything fed by this view.

### 5. Run policies before answering

The same idea for policies: run the ones a command's events trigger before the command answers. A policy sends commands to other instances, so this makes the caller wait for a chain of commands whose length the model decides, and it needs an answer for a policy that fails after the first commit. A `Decision` already covers the case where the second write must happen with the first. Not recommended without a concrete need.

### 6. Shorten the first command

Half a second for a new instance with no view is the platform creating an object and its storage, plus whatever Domain does on first load. Which part is which has not been measured. Worth a trace before changing anything.
