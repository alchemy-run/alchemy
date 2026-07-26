/**
 * The Distilled process — the recurring maintenance job that keeps
 * the ./distilled submodule tracking upstream cloud-provider specs.
 * Where the other processes react to the world (issues, PRs,
 * mentions), this one is woken on a schedule by its substrate — a
 * cron clause in code, not in prose.
 *
 * It works through the same door as everyone else: its output is a
 * pull request, reviewed and merged by the PullRequests process. The
 * factory has one merge authority, and this process isn't it.
 *
 * SEALED by construction: {@link Distilled} is a plain
 * `Context.Service` resolving to {@link DistilledService}, and `wake`
 * is the ONE seam the scheduler (a Cloudflare cron trigger, a local
 * Effect.schedule loop) calls through.
 */
import * as AI from "alchemy/AI";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Coding } from "./Coding.ts";
import { Engineer } from "./Engineer.ts";
import { Ledger } from "./Ledger.ts";
import { testAlchemy } from "./Repos.ts";
import { OpenIssue, OpenPullRequest } from "./tools/index.ts";

/** The event: value is the term (spliced into the charter), type is the payload. */
export class Wake extends AI.Event("Wake", {
  /** The cron fire time — re-fires with the same stamp collapse to one pass. */
  stamp: S.String,
})`
A scheduled wake — one sync pass against upstream, identified by its
stamp (the cron fire time), so re-fires collapse to one pass.` {}

/**
 * The ONE door: the scheduler calls this, nobody else. Colored
 * `RuntimeContext` — a wake can only fire inside the running host
 * (cron trigger on Cloudflare, an Effect.schedule loop locally).
 */
export interface DistilledService {
  /**
   * Run one sync pass, identified by `stamp` (e.g. the cron fire time,
   * `2026-07-17`): re-fires with the same stamp collapse in the
   * Ledger, so an at-least-once scheduler still runs one pass.
   */
  readonly wake: (stamp: string) => Effect.Effect<void, never, RuntimeContext>;
}

export class Distilled extends Context.Service<Distilled, DistilledService>()(
  "alchemy-org/Distilled",
) {}

/**
 * The implementation: resolve the private agent and expose `wake`.
 * Each distinct stamp is one run; the run ends when the charter
 * concludes (nothing to do, or PR opened) — there is nothing for the
 * world to settle here.
 */
export const DistilledLive = Layer.effect(
  Distilled,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const distilled = yield* DistilledAgent;

    return {
      wake: (stamp) =>
        Effect.gen(function* () {
          const wake = new Wake({ stamp });
          const { status } = yield* ledger.offer("distilled", stamp, wake);
          if (status === "accepted")
            yield* distilled.send(wake, { key: stamp });
        }),
    };
  }),
).pipe(Layer.provide(Layer.suspend(() => DistilledAgentLive)));

/** The loop behind the desk — {@link DistilledLive} wires the world to it. */
export class DistilledAgent extends AI.Agent<DistilledAgent>()("Distilled") {}

export const DistilledAgentLive = DistilledAgent.make`
  This process keeps the ./distilled submodule of ${testAlchemy}
  current against upstream provider specs.

  Each ${Wake} begins a ${Coding} pass: fetch the upstream specs and
  diff them against the checked-in generation. No changes ends the
  pass — a run that changes nothing is a good run.

  When specs did change, regenerate and read the fallout over the
  diff, sorted into (a) mechanical churn, (b) new surface — resources,
  operations, fields not covered yet — and (c) breaking changes to
  covered surface. Then run the test suite; it is the only oracle of
  whether alchemy still holds.

  Tests green: ${OpenPullRequest} carries the regeneration,
  summarizing the upstream changes and calling out new surface worth
  covering — each such item also becomes an ${OpenIssue} with
  acceptance criteria, so coverage work is tracked where the Issues
  process will find it.

  Tests broken: the pass becomes an engineering task. The breakage
  goes to ${Engineer} — failing tests and the upstream diff are the
  specification — and the resulting pull request carries both the
  regeneration and the fix.

  Nothing merges here and nothing is pushed to main; the PullRequests
  process drives these pull requests like anyone else's.`;
