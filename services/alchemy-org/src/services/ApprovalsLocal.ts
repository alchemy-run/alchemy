import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Approvals,
  type ApprovalOutcome,
  type ApprovalRequest,
} from "./Approvals.ts";

/** How long an armed request waits before failing closed. */
const ANSWER_WINDOW = "5 minutes";

/**
 * The LOCAL physics of {@link Approvals}: one process, pending
 * requests in memory, the answer window on the process clock. The
 * durable placement ({@link ApprovalsD1}) swaps this Layer — the
 * contract in Approvals.ts is what tools and the HTTP surface
 * write to.
 */
export const ApprovalsLocal = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const mode = yield* Config.string("ORG_APPROVALS").pipe(
      Config.withDefault(""),
    );
    const armed = mode === "ask";
    const pending = new Map<
      string,
      {
        readonly request: ApprovalRequest;
        readonly deferred: Deferred.Deferred<ApprovalOutcome>;
      }
    >();
    let next = 1;

    return {
      ask: (request) =>
        !armed
          ? Effect.succeed("allowed-once" as const)
          : Effect.gen(function* () {
              const id = `approval-${next++}`;
              const deferred = yield* Deferred.make<ApprovalOutcome>();
              pending.set(id, {
                request: { ...request, id, at: Date.now() },
                deferred,
              });
              return yield* Deferred.await(deferred).pipe(
                Effect.timeout(ANSWER_WINDOW),
                // fail CLOSED: no answer in the window is not approval
                Effect.catch(() => Effect.succeed("unavailable" as const)),
                Effect.ensuring(Effect.sync(() => pending.delete(id))),
              );
            }),
      pending: () =>
        Effect.sync(() => [...pending.values()].map((entry) => entry.request)),
      answer: (id, outcome) =>
        Effect.gen(function* () {
          const entry = pending.get(id);
          if (entry === undefined) return false;
          yield* Deferred.succeed(entry.deferred, outcome);
          return true;
        }),
    };
  }),
);
