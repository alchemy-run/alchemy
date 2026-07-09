import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KernelError } from "./Errors.ts";

/**
 * The Ask protocol (design §2.4/§9.3, generalized): **"park durably
 * until a correlated answer arrives"** — one protocol for approvals,
 * structured questions, OAuth hand-offs, and budget continuations, and
 * (§2.8c) for `wait_for` on a subagent run: waiting on a human and
 * waiting on a machine are the same park.
 *
 * Two sides, one hub:
 *
 * - **Requesting** — a tool implementation yields the {@link Ask}
 *   service (provided by the kernel *to the tool execution*, scoped to
 *   the asking ring/session/command) and parks on `ask(payload)`. The
 *   park is an ordinary in-flight tool execution: it is raced against
 *   the ring's interrupt signal, so interrupting the asker settles the
 *   pending ask as an aborted result — never a leak.
 * - **Answering** — the world (a UI, a Discord bot, a test) resolves
 *   {@link AskHub}, lists `pending`, and delivers `answer(id, …)`.
 *   Answers are **verdict + optional amendment** (§9.3): an approval
 *   can carry a durable policy delta; a denial is a typed model-visible
 *   result, never a thrown error.
 *
 * The memory hub is process-local (Deferred per ask). The Cloudflare
 * harness swaps in ledger rows + webhook answers; ask ids are already
 * deterministic (derived from the asking command), so replayed requests
 * collide idempotently (§2.7).
 */
export interface AskPayload {
  /** What kind of answer the asker needs. */
  readonly kind: "approval" | "question";
  /** The question or the action needing approval, in prose. */
  readonly text: string;
  /** For questions: 2–4 structured options (§9.3). */
  readonly options?: ReadonlyArray<string>;
}

export interface AskAnswer {
  readonly verdict: "approved" | "denied" | "answered";
  /** The chosen option / free-text answer / denial reason. */
  readonly text?: string;
  /**
   * A durable policy delta riding the answer ("approved for session",
   * "never ask for this pattern") — fold-visible ring state; the
   * autonomy dial ratchets by use (§9.3).
   */
  readonly amendment?: string;
}

export interface PendingAsk {
  readonly id: string;
  /** The asking ring (term name). */
  readonly ring: string;
  /** The asking run's session key. */
  readonly session: string;
  readonly payload: AskPayload;
}

/**
 * The requesting side — provided by the kernel to tool executions.
 * A human-class tool implementation is ordinary user code:
 *
 * ```ts
 * Layer.succeed(Approve, ((input: { action: string }) =>
 *   Effect.gen(function* () {
 *     const ask = yield* Ask
 *     const answer = yield* ask({ kind: "approval", text: input.action })
 *     if (answer.verdict !== "approved") {
 *       return yield* Effect.fail(`denied: ${answer.text ?? "no reason"}`)
 *     }
 *     return `approved${answer.amendment ? ` (${answer.amendment})` : ""}`
 *   })) as never)
 * ```
 */
export class Ask extends Context.Service<
  Ask,
  (payload: AskPayload) => Effect.Effect<AskAnswer>
>()("alchemy/AI/Ask") {}

export interface AskHubService {
  /** Park until the correlated answer arrives (requesting side). */
  ask(request: PendingAsk): Effect.Effect<AskAnswer>;
  /** Asks currently parked (answering side). */
  pending: Effect.Effect<ReadonlyArray<PendingAsk>>;
  /** Deliver the correlated answer; unknown ids are typed failures. */
  answer(id: string, answer: AskAnswer): Effect.Effect<void, KernelError>;
}

export class AskHub extends Context.Service<AskHub, AskHubService>()(
  "alchemy/AI/AskHub",
) {}

/** The in-memory hub: a Deferred per parked ask. */
export const makeMemoryAskHub: Effect.Effect<AskHubService> = Effect.gen(
  function* () {
    const parked = new Map<
      string,
      {
        readonly request: PendingAsk;
        readonly seat: Deferred.Deferred<AskAnswer>;
      }
    >();

    return {
      ask: (request) =>
        Effect.gen(function* () {
          const seat = yield* Deferred.make<AskAnswer>();
          parked.set(request.id, { request, seat });
          return yield* Deferred.await(seat).pipe(
            // interrupt (via the ring's CallTool race) or answer — either
            // way the park is cleaned up
            Effect.ensuring(Effect.sync(() => parked.delete(request.id))),
          );
        }),
      pending: Effect.sync(() =>
        [...parked.values()].map((entry) => entry.request),
      ),
      answer: (id, answer) =>
        Effect.suspend(() => {
          const entry = parked.get(id);
          if (entry === undefined) {
            return Effect.fail(
              new KernelError({
                term: id,
                message: `no pending ask with id ${JSON.stringify(id)}`,
              }),
            );
          }
          return Effect.asVoid(Deferred.succeed(entry.seat, answer));
        }),
    };
  },
);

export const AskHubMemory: Layer.Layer<AskHub> = Layer.effect(
  AskHub,
  Effect.map(makeMemoryAskHub, (hub) => AskHub.of(hub)),
);
