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
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DistilledMaintainer,
  DistilledMaintainerLive,
  Wake,
} from "../agents/DistilledMaintainer.ts";
import { Ledger } from "../Ledger.ts";

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
    const distilled = yield* DistilledMaintainer;

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
).pipe(Layer.provide(Layer.suspend(() => DistilledMaintainerLive)));
