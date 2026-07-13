/**
 * MOCK Cloudflare kernel: the harness-side `Context.Service` combinations
 * that interpret the org's terms on Workers + Durable Objects.
 *
 * The shape follows the harness-archaeology decisions (design §9.3):
 *
 * - `Ring` — one Durable Object class; one *instance* per ring (the
 *   org currently runs one: ResolveGitHubIssue). Its
 *   storage holds **two planes** (never a second transcript):
 *   plane 1 — the mutable admission ledger (idempotent by delivery id,
 *   per-ring FIFO; leases are advisory because DOs are single-threaded);
 *   plane 2 — the append-only Trace (per-ring `seq` is the only durable
 *   cursor) plus the fold (the durability checkpoint, committed in the
 *   same transaction as the events that motivated it).
 * - `CloudflareKernelLive` — implements `AI.Kernel` over the Ring
 *   namespace: interpreting a Process term routes its runs to the loop's DO
 *   instance; `trace(ring, after)` is replay-then-tail over plane 2
 *   (rows are truth, wakes are hints).
 *
 * Seams deliberately *absent from the Kernel interface* would also live
 * here as private services of this layer (ContextPolicy, Sandbox,
 * ToolInterceptor, Durability) — the kernel tag never learns their names.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";

export class Ring extends Cloudflare.DurableObject<Ring>()(
  "Ring",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      return {
        /**
         * Plane 1: admit a work item / stimulus. Idempotent by
         * `deliveryId` — an exact retry returns the prior receipt, so
         * webhook redeliveries and duplicate wakes collapse. Everything
         * (work items, steers, cancels, budget edits) flows through this
         * one ordered inbox; there is no second control plane.
         */
        admit: Effect.fn(function* (delivery: {
          deliveryId: string;
          kind: "work" | "steer" | "control";
          item: unknown;
        }) {
          const inbox =
            (yield* state.storage.get<Record<string, unknown>>("inbox")) ?? {};
          if (delivery.deliveryId in inbox) {
            return { admitted: false, deliveryId: delivery.deliveryId };
          }
          yield* state.storage.put("inbox", {
            ...inbox,
            [delivery.deliveryId]: delivery,
          });
          return { admitted: true, deliveryId: delivery.deliveryId };
        }),
        /**
         * Plane 2: read the Trace from a cursor. `seq` is the only
         * durable cursor; live deltas never advance it. (The mock returns
         * the persisted suffix; the real harness tails live commits after
         * replay, woken by an edge-triggered dirty signal.)
         */
        trace: Effect.fn(function* (after?: number) {
          const events =
            (yield* state.storage.get<AI.KernelEvent[]>("trace")) ?? [];
          return events.filter((event) => (event.seq ?? 0) > (after ?? 0));
        }),
        /**
         * The ring's carried state. The fold write and the events that
         * motivated it commit together; the fold snapshot records the
         * `promptHash` it was created under so recovery can detect
         * checkpoint fossils after a redeploy.
         */
        fold: Effect.fn(function* () {
          return (
            (yield* state.storage.get<{
              term: string;
              seq: number;
              state: unknown;
            }>("fold")) ?? null
          );
        }),
      };
    });
  }),
) {}

/**
 * `AI.Kernel` implemented over the Ring DO namespace.
 *
 * Note what the layer *requires*: only the `Ring` namespace (and, in a
 * real implementation, a model provider). The tools each term needs are
 * NOT required here — they were captured per-term by `AI.layer(term)`,
 * which is what lets two agents in the same Worker hold different `Bash`
 * physics.
 */
export const CloudflareKernelLive = Layer.effect(
  AI.Kernel,
  Effect.gen(function* () {
    const rings = yield* Ring;

    return AI.Kernel.of({
      // deterministic handler path (reassess §C) — sketch: the handler
      // is the DO's per-item work; run identity is the work item.
      process: (_term, _handler) =>
        Effect.die(
          new Error("TODO(Phase 2): handler processes on the Ring DO"),
        ) as any,
      // One interpretation method: Agent and Process denote the same object
      // (a Process); they differ only in who supplies the control
      // parameters (kernel defaults vs charter refs).
      // TODO(Phase 2): the pure step machine (state, feedback) → commands,
      // running inside the host DO's fiber. Default recovery is resume +
      // repair (fail orphaned in-flight work as typed interruptions,
      // deliver the last fold), not command replay — §9.3.
      interpret: (term) =>
        Effect.gen(function* () {
          if (!AI.isProcess(term)) return agentService();

          // A loop's runs live in its named DO instance. Subscribe the
          // charter's MACHINE-OBSERVED exit sources
          // (`AI.exit(AI.when(source, …))` — possibly several): resolve
          // each source's channel tag from ambient context (it is in the
          // loop's Req — the same mechanism as tool refs) and let the
          // channel Layer do the two-phase bind (plan: provision the
          // webhook; runtime: stream). `AI.when` sources are NOT
          // subscribed — delivery is always outside code (the front door).
          for (const halt of (term.refs as any[]).filter(AI.isHalt)) {
            for (const source of (halt as { sources?: unknown[] }).sources ??
              []) {
              if (AI.isEventSource(source) && source.channel) {
                const channel = yield* source.channel;
                const stream = yield* channel.subscribe(source);
                // TODO(Phase 2): correlate the stream against this ring's
                // parked runs (the source's `key`, or the halt's `match`
                // override), keyed by delivery id.
                void stream;
              }
            }
          }
          return loopService(term);
        }) as any,

      // live firehose (deltas included, no replay guarantee)
      events: Stream.never,

      // durable replay-then-tail over one ring's Trace (mock: replay
      // only; the real harness tails live commits after the cursor)
      trace: (ring: string, after?: number) =>
        Stream.fromIterableEffect(
          rings.getByName(ring).trace(after),
        ) as unknown as Stream.Stream<AI.KernelEvent, AI.KernelError>,
    });

    function agentService() {
      // Kernel-default control parameters: inbox = the send/dispatch
      // mailbox, halt = "model returned no tool calls" (kernel policy),
      // fold = the carried transcript. Same five verbs as a ring.
      const todo = () =>
        Effect.die(new Error("TODO(Phase 2): interpret the agent turn"));
      return {
        dispatch: todo,
        send: todo,
        run: todo,
        steer: todo,
        interrupt: todo,
      };
    }

    function loopService(term: { "~alchemy/Name": string }) {
      return {
        dispatch: (item: unknown) =>
          rings
            .getByName(term["~alchemy/Name"])
            .admit({
              // deterministic identity: duplicate dispatches of the
              // same work item collapse in the ledger
              deliveryId: `dispatch/${term["~alchemy/Name"]}/${JSON.stringify(item)}`,
              kind: "work",
              item,
            })
            .pipe(
              Effect.flatMap(() =>
                Effect.die(
                  new Error(
                    "TODO(Phase 2): await the run's halt via the ring DO",
                  ),
                ),
              ),
            ),
        send: (item: unknown) =>
          rings
            .getByName(term["~alchemy/Name"])
            .admit({
              // the admission half of dispatch alone — same ledger, no join
              deliveryId: `dispatch/${term["~alchemy/Name"]}/${JSON.stringify(item)}`,
              kind: "work",
              item,
            })
            .pipe(Effect.asVoid),
        run: () =>
          Effect.die(
            new Error(
              "TODO(Phase 2): serve the mailbox via DO alarms + queues",
            ),
          ),
        steer: (input: unknown) =>
          rings
            .getByName(term["~alchemy/Name"])
            .admit({
              deliveryId: `steer/${term["~alchemy/Name"]}/${JSON.stringify(input)}`,
              kind: "steer",
              item: input,
            })
            .pipe(Effect.asVoid),
        interrupt: () =>
          rings
            .getByName(term["~alchemy/Name"])
            .admit({
              deliveryId: `interrupt/${term["~alchemy/Name"]}`,
              kind: "control",
              item: { type: "interrupt" },
            })
            .pipe(Effect.asVoid),
      };
    }
  }),
);
