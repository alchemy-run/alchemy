# The Bootstrap: an Agent That Builds Itself

Design for turning `services/alchemy-org` into a **self-building
agent** — the bootstrap of the self-improvement loop described in
[reports/prime-agent.md](./reports/prime-agent.md) §3–4. The agent's
charter, tools, skills, and UI are TypeScript source in this
repository; the agent edits that source and **hot-reloads itself**, so
the next tick runs the code it just wrote. Locally this is the whole
mechanism. In the cloud it becomes worker-loader hot-swap for behavior
and PR-staged deploys for infrastructure — documented in §7, built
later. Once bootstrapped, nothing fences the agent off from the
drivers themselves: the harness is in the same repo, behind the same
typechecker.

## The mission: alchemy's development is the feedback substrate

The bootstrap is not self-improvement in a vacuum — its purpose is to
**work alchemy's own development queue, under the governor's
supervision**, and to improve by doing that work:

- **Sensors (the inputs):** GitHub issues and pull requests on the
  real alchemy repositories (triage, reproduce, review, fix), Discord
  (users reporting problems and asking questions), CI/tests (objective
  pass/fail), and the GOVERNOR — the operator's steering messages and
  corrections through the board, which are ground truth.
- **Why this beats trajectory-self-review** (what Prime Agent does):
  every signal here is EXTERNAL — a reproduction either reproduces or
  doesn't, CI passes or fails, the governor approves or corrects. The
  FLE reward-hack (prime-agent report §1c) is what happens when the
  improvement loop grades its own homework; this loop can't.
- **The recursion is material, not metaphorical:** the org is built ON
  alchemy. Fixing an alchemy bug improves the agent's own driver,
  bindings, and deploy machinery; reviewing an alchemy PR is quality
  control on its own substrate. Work product and self-improvement are
  the same artifact.
- **Governance is capability grants, not policy prose.** Autonomy
  tiers are type-level facts per mention-is-presence: the
  triage/reproduce tier holds read tools + bash + comment; the fix
  tier adds write tools in a worktree + draft `openPullRequest`;
  NOTHING holds merge — merging is the governor. Doors
  (`AI.Dispatch` policies) are the "with my permission" primitive for
  actions in between. ReviewBot returns as a capability of this org,
  not its identity.
- **Two improvement targets, two gates:** changes to ALCHEMY (the
  product) always ride PRs and the governor's merge — git-speed is
  correct there. Changes to ITSELF (the harness in
  `services/alchemy-org`) ride the hot-reload loop below at
  conversation speed — but every reload is a git checkpoint the
  governor can audit and revert, and anything pushed rides the same
  PR gate.
- **Graduation path:** bootstrap locally (phases 1–2) → work
  `test-alchemy` until the loop is trustworthy → point at the real
  repositories with the read/comment tier → widen grants as earned.
  Each graduation is a one-line layer change.

## The trajectory

Four acts, each one bootstrapped from the last, all journaled (§4b)
for post-hoc filming:

1. **A chat prompt** (generation 0): one agent, one durable thread, a
   barely-there chat UI, and four capabilities — read, write, bash,
   reload. The operator talks to it; it edits its own source and
   hot-reloads. Nothing else ships pre-built.
2. **A coding agent**: everything a real coding agent has — lessons,
   richer transcript UI, more tools, sub-threads — built BY the agent,
   on request, generation by generation. `services/alchemy-org` is
   adapted or discarded freely along the way; the design docs and the
   chronicle are the continuity, not the current code.
3. **A deployed agent**: the same organism moved to the cloud by its
   own deploy machinery (IaE deploys itself); behavior hot-swap via
   worker loaders, infrastructure changes via PR-staged deploys (§7).
4. **The organization**: multiplayer — the sensors turn on (GitHub
   issues, pull requests, Discord), tiered grants govern autonomy,
   and the governor supervises alchemy's own development from the
   board. Work and self-improvement become the same loop (see "The
   mission").

The two-lane doctrine (prime-agent report §3) is enacted literally:

- **Lane 2 (behavior)** = source files. Changing behavior = editing
  code + reload. The compiler is the first gate, git the provenance
  and rollback.
- **Lane 1 (data)** = durable stores that survive reloads without
  requiring one — `PersistentRef` over sqlite, the ledger, chats. The
  agent will predictably build its own data tools on this lane the
  first time a reload feels too heavy for a value that isn't behavior.
  That is the system working, not a workaround.

---

## 1. The decisive call: reload = process restart, not module swap

Two candidate mechanisms:

**(a) In-process module hot-swap** — query-busted dynamic import of the
charter module, rebuild the Layer graph in place. Rejected for the
bootstrap. We already met its failure mode in production this week:
an in-process layer rebuild that didn't tear down its predecessor left
two drivers and two GitHub pollers running in one process (double
reviews on one PR). Module identity makes it worse: a re-imported
module re-evaluates the graph, minting NEW term objects and closures
while the old Layer graph still holds the old ones. Getting this right
means solving scope teardown, tag identity, and re-init semantics all
at once — a research project standing between us and the bootstrap.

**(b) Process restart over a durable substrate** — the harness-survey
finding applied to ourselves: *"every shipped perpetual agent is a
relay of bounded episodes over durable external state."* Restart is
only expensive if state dies with the process. Make the state durable
and the restart IS hot reload, with a restart surface you can state in
one table.

**(b) wins**, and level-triggered stances are what make it cheap:
threads never store their prompt — they re-render it every tick — so a
restarted process wakes parked threads directly into the NEW charter.
No migration, no prompt patching. The only thing restart would
otherwise destroy is run state, so run state becomes durable (§3).

`Local.Service` already does the supervision half: the reconciler
tracks the pid, restarts on input-hash changes, and **resurrects the
process when it dies**. Under `alchemy dev` this reconciliation is
continuous. The bootstrap adds: durable run state, a quiescent exit,
and an explicit `reload` tool.

## 2. The Bootstrap agent

`services/alchemy-org/src/Bootstrap.ts` replaces ReviewBot as the
served agent (ReviewBot's code stays in-tree, unwired — review returns
later as a capability of the bootstrapped org, not its identity).

- **Workspace = the live checkout.** No git worktrees, no clone: the
  agent's file tools operate on this repository's working tree,
  scoped by containment root to the repo. The stance directs
  attention to `services/alchemy-org/**` first; `packages/alchemy/**`
  (the drivers) is reachable — the endgame is explicitly that it can
  modify its own driver — with the stance teaching escalating care,
  not a hard fence. The typechecker and git are the fences.
- **Toolkit:** the read/run set (grep, glob, listDirectory, readFile,
  readOutput, bash) plus the write set restored from the pre-trim
  history (`editFile`, `writeFile` — digest-guarded), plus `reload`
  (§4). One durable thread (`org/bootstrap`) the operator talks to
  through the existing UI; more threads when the agent spawns them.
- **Charter sketch:**

  ```
  You are the Bootstrap: the agent that builds services/alchemy-org —
  including yourself. Your charter, tools, and UI are TypeScript in
  your workspace; your behavior IS that source. To change how you
  work: edit the source, then ${reload} — it typechecks first (errors
  come back to you; nothing reloads on red), checkpoints your changes
  as a git commit, and restarts you into the new code at the end of
  this round. Your conversation survives reloads; your process does
  not — anything else you want to survive belongs in code or in a
  durable store you can build. Verify behavior changes by using the
  changed behavior, not by re-reading the diff.
  ```

## 3. The restart surface (what survives, and how)

| State | Today | Bootstrap | Work |
|---|---|---|---|
| Event ledger | sqlite | unchanged | — |
| `PersistentRef` (local) | in-memory backend | **`PersistentRefStoreSqlite`** (bun:sqlite over the existing `Store` seam — same contract as the DO store) | small, new |
| Chats (UI transcripts) | in-memory ring | **`ChatsSqlite`** behind the existing `Chats` contract (its docstring already promises this) | medium, new |
| **Driver run state** (thread log, parked runs) | dies with process | **run journal + restore**: DriverMemory journals each run's thread through the run's `PersistentRef.Store` (the seam already provided per-run); on boot, persisted runs are restored PARKED with their thread primed | the real work |
| In-flight rounds | — | never restarted over: reload is **scheduled at park** (§4) | part of reload |
| Worktrees / checkout | disk | live checkout, untouched by restart | — |
| The UI's socket | reconnects | board/SSE + RunSocket already re-subscribe with cursors; a restart is a reconnect | verify only |

The driver-journal design rides the seam we already built for
PersistentRef rather than inventing a second persistence path: the
thread is run-scoped durable state like any other. Restore semantics:
every persisted run comes back parked (never mid-round — reload waits
for park), with a driver-minted note as its next wake context:
`"[note] you reloaded; the process restarted into the code you wrote —
verify the change behaves"`.

## 4. The `reload` tool contract

Prime Agent's one genuinely correct refine mechanic, transplanted:
mutation of the running system is **scheduled at the turn boundary**,
never executed mid-round (their `refine.run()` schedules for turn end
because applying mid-cell would abort the requesting cell — identical
constraint here: a restart mid-round kills the round that asked).

```
reload(reason: string) — schedule a reload at the end of this round
  1. bun tsc -b (org project; references pull in alchemy)  ← the gate
     · red: tool FAILS with the compiler errors; nothing scheduled;
       fix and call again (compiler-in-the-loop self-correction)
  2. chronicle: screenshot the board (puppeteer, best-effort) +
     append the generation entry (§4b) to chronicle/journal.jsonl
  3. git add -A && git commit -m "bootstrap: ${reason}"     ← rollback + provenance
     (the chronicle entry and shot ride the commit they describe)
  4. mark reload-pending; tool returns "reloading at end of round"
  5. at park: flush journals → process.exit(0)
  6. the Local.Service reconciler observes the dead pid and restarts
  7. boot: rehydrate runs from the journal; the bootstrap thread wakes
     with the reload note
```

## 4b. The Chronicle: journaling for the documentary

The recursive development process should be FILMABLE POST-HOC — never
filmed live. Durable artifacts make every scene reconstructable later,
in whatever UI exists by then:

- **git** — the code timeline; every generation is a checkpoint commit
  with a conversational cause (gource-style animation for free).
- **ChatsSqlite** — the dialogue track; any past thread replays in the
  board at any speed, screen-recordable whenever.
- **Wire types per commit** — the capability curve ("what could it do
  at gen N") is computable retroactively: `ToolNames<...>` is source.
- **chronicle/journal.jsonl** — the correlation layer, appended by the
  reload tool, committed with the checkpoint it describes:

  ```jsonl
  {"kind":"reload","gen":42,"at":1765...,"commit":"abc123",
   "reason":"add note_lesson tool","thread":"bootstrap",
   "ask":"add a way to remember lessons across sessions",
   "diffstat":{"files":3,"added":120,"removed":8},
   "wire":["reload","note_lesson",...],"shots":["chronicle/shots/42.png"]}
  ```

  `gen` is the frame index. `ask` ties the commit to the request that
  caused it. The screenshot captures the UI THE AGENT IS BUILDING at
  that moment — a historical artifact once it self-modifies past it.
  Same shape later for `kind: "deploy"` (stage, url), `"milestone"`,
  and `"correction"` (governor steers wrong-to-right — the dramatic
  beats of a supervision story).

**Generation 0 is deliberately minimal**: one agent, ONE durable
thread, read/write/bash/reload, a barely-there chat UI. Lessons,
richer cards, more threads, sensors — all of it gets asked for in
conversation and built by the agent. That is both the point and the
plot.

Rollback is a conversation away: `bash("git revert HEAD")` + `reload`.

**Watch semantics:** the service's `memo.include` must EXCLUDE the
agent-editable source in bootstrap mode — otherwise the dev watcher
restarts the process on the first `writeFile` of a round, killing the
agent mid-edit. Reload is explicit and quiescence-scheduled; the
watcher keeps only `local.run.ts`-level inputs. (Operator-initiated
edits in an IDE ride the same tool: tell the agent to reload, or run
`alchemy deploy` which restarts by hash as today.)

## 5. Safety: the capability envelope

We never trust the model; we shape what its identity can reach. The
question is never "will it decide to delete a repository" but "does
any code path from its credentials reach deletion". Layers, strongest
first — the strong ones all live OUTSIDE the agent's process, where no
self-edit or prompt injection can reach them:

1. **Identity (GitHub App permissions + installation scope).** The
   app holds `pull_requests: rw`, `issues: rw`, `contents: read` —
   repo deletion requires `administration: write`, which is never
   granted, so deletion is unreachable regardless of model behavior.
   The installation covers only the repos we chose. Corollary: the
   OPERATOR's PAT must never enter the runtime environment (finish
   the App migration; drop the profile fallback when sensors go
   live). Cloud-side: per-stage credentials; the agent's stage never
   holds prod keys.
2. **Typed capabilities (mention-is-presence) — with the bash
   exception named honestly.** No `deleteRepo` tool exists, and the
   wire types enumerate everything that does. But `bash` on the
   operator's machine reaches the keychain-authed `gh` CLI (and `bun
   nuke`): typed tools are a fence, bash is an open gate. Fixes in
   order: (a) NOW — allowlisted env for the service process, scrubbed
   env for the bash tool (no `GITHUB_TOKEN`, no cloud creds); (b)
   BEFORE UNTRUSTED INPUT — bash moves into a container (the
   sandbox-as-service seam) with the workspace mounted and nothing
   else: no keychain, no `~/.config/gh`, no doppler.
3. **Injection defense = tier separation, not filters.** Issues, PRs,
   and Discord are attacker-controlled text. The lethal combination
   is one context holding all three of: untrusted content, secrets,
   and write/exfiltration. Rule: any tier that ingests untrusted
   content is missing at least one other leg. Triage reads with
   read-only tools and no secrets; the Fix tier receives the
   structured summary a TRUSTED agent minted, never the raw attacker
   text. Doors carry the approvals for the gray zone, surfaced as
   buttons on the governor's board.
4. **Self-modification cannot reach the fences.** Guardrails written
   in the agent-editable tree are advisory (it could edit the reload
   tool). The load-bearing fences are elsewhere: App permissions
   (GitHub's servers), the container boundary (OS), the env allowlist
   (`local.run.ts`, operator-owned), branch protection on real repos
   (require PR review to merge — enable it), and the reload
   checkpoint commits — the board renders reload diffs, so self-edits
   are always visible.
5. **Reversibility triage.** Everything reachable is either
   reversible (git revert, comments, reopen) or door-gated. The
   irreversible set — delete, force-push, prod destroy, secret
   exfiltration — is structurally absent via layers 1–2, never merely
   policy-forbidden. Alchemy itself is a destruction engine
   (`alchemy destroy`): the agent's stage credentials and state are
   part of the envelope, so its stage is its blast radius.

## 5b. Guardrails — deliberately few, all structural

- **The typechecker** — nothing reloads on red. This is the analog of
  Prime Agent's "immutable base prompt", except it guards *coherence*
  rather than a text region: the agent can edit anything, including
  eventually the driver, but never into a state that doesn't compile.
  (The wire types make several mistakes uncompilable: a tool mentioned
  in the stance without a renderer, an input field that doesn't
  exist.)
- **Git checkpoints on every reload** — total ordering, provenance,
  one-command rollback. `refinements.jsonl`, as a commit log.
- **Session scope for Lane 1** — durable stores are per-deployment
  files under `.alchemy/`; nothing the agent stores as data leaks into
  another install. Only code (committed, eventually pushed/reviewed)
  crosses machines. Code review is ABANDONED for the bootstrap phase
  by explicit decision — the operator watching the board is the
  review — and returns as the loop's gate when the org grows past one
  operator.

## 6. Build plan

1. **Durability substrate**: `PersistentRefStoreSqlite`; `ChatsSqlite`;
   DriverMemory run journal + parked-restore (through the
   `PersistentRef.Store` seam); quiescent-exit hook on the driver
   (`onIdle` or drain-then-run callback).
2. **The Bootstrap agent (generation 0)**: `Bootstrap.ts` (charter
   above), restore `EditFile`/`WriteFile` from `bed14a933^`,
   `Reload.ts` tool (tsc gate + chronicle + checkpoint + schedule),
   `Local.ts` rewire (drop GitHub poller from the critical path; keep
   creds for tools), `local.run.ts` memo exclusion + env allowlist,
   board generalized from PR-keyed to thread-keyed with ONE thread.
   Deliberately minimal everywhere else (§4b) — features get built by
   the agent, on request, on camera.
3. **First self-build exercises** (acceptance tests of the loop, run
   as conversations): (a) "add a `noteLesson` tool that stores lessons
   in a durable store and render them into your stance" — the agent
   builds Lane 1 for itself; (b) "add a tool you're missing and use
   it in the same conversation"; (c) "change how you present tool
   results in the UI" — crosses into ui/, proving the wire-type
   renderer gate fires for an agent-authored tool.
4. **Point at the work** (the mission section): re-wire the GitHub
   sensors at `test-alchemy` — issue triage, reproduce-in-worktree,
   ReviewBot-as-capability for PRs — with the tiered grants; run real
   issues through; the governor steers from the board. Graduate to
   the real alchemy repositories when trustworthy; add Discord as a
   sensor.
5. **Later (documented, not built):** §7.

## 7. Cloud path (later)

Git-as-transport is the *slow* lane by design — but the fast lane must
exist in the cloud too, or cloud agents can't self-modify between
deploys:

- **Behavior hot-swap: Cloudflare Worker Loaders.** The Worker Loader
  API loads worker code dynamically (isolate-per-code-version, same
  machinery Cloudflare built for user-code platforms). The cloud
  analog of §1(b): the driver DO stays resident (threads/journals in
  DO storage — already durable there), while the CHARTER bundle is
  loaded through a loader keyed by content hash. `reload` compiles
  (typecheck in a sandbox or CI-lite), uploads the bundle, flips the
  loader key at the next park. Level-triggered stances make the swap
  exactly as clean as the local restart. Infrastructure changes
  (bindings, new resources) still require a real deploy — the loader
  only swaps code within the deployed capability envelope, which is a
  *feature*: infra changes are precisely the ones that deserve the PR
  stage.
- **Infra changes: PR-tied stages** (prime-agent report §4): Refiner
  opens a PR; CI deploys stage `pr-N` as a full organism; eval-by-
  replay runs recorded ledger traffic against it; merge redeploys.
  The wire-surface types double as the version-compat contract
  between stages.

## 8. Open questions

- **Restore fidelity**: is thread-log-only enough, or do parked
  waiters/reminders need journaling in phase 1? (Bias: thread-only;
  reminders re-arm from stance/lessons; waiters are HTTP-scoped and
  die with their callers anyway.)
- **Restart latency**: bun boot + layer build is ~1–3s today; if the
  vite build rides the restart it's ~8s. UI assets should not rebuild
  on behavior reloads (split the memo surfaces).
- **Typecheck scope**: `tsc -b` of the org project pulls in alchemy
  project references — correct but slow-ish (~15–20s cold). Acceptable
  for reload cadence; a warm `tsc --watch` sidecar is the optimization
  if it isn't.
- **Concurrent operator + agent edits**: both write the same tree; the
  checkpoint commit sweeps operator changes into the agent's commit.
  Fine for one operator; needs staging discipline later.
