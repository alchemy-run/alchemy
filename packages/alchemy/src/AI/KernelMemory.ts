import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AiError from "effect/unstable/ai/AiError";
import type { ProcessContext } from "./ProcessContext.ts";
import { toPromptText } from "./Text.ts";
import { type Value, isValue } from "./Value.ts";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import type * as Response from "effect/unstable/ai/Response";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Schedule from "effect/Schedule";
import { isAgent } from "./Agent.ts";
import { Ask, AskHub, makeMemoryAskHub } from "./Ask.ts";
import { BudgetPolicy } from "./Budget.ts";
import {
  type Check,
  type CheckVerdict,
  isCheck,
  type MachineCheck,
} from "./Check.ts";
import { BudgetExceeded, KernelError, Refused } from "./Errors.ts";
import { EventBus, makeMemoryEventBus } from "./EventBus.ts";
import {
  type EventChannelService,
  type EventSource,
  isWorldOwned,
} from "./EventSource.ts";
import { type Halt, isHalt } from "./Signature.ts";
import { eventId } from "./Ids.ts";
import { Kernel, type KernelService } from "./Kernel.ts";
import { kernelPrompts } from "./KernelPrompts.ts";
import { isProcess } from "./Process.ts";
import type { Parameter } from "./Parameter.ts";
import { renderTemplate } from "./Render.ts";
import * as Step from "./Step.ts";
import type { Tool } from "./Tool.ts";
import { makeMemoryTraceStore, TraceStore } from "./TraceStore.ts";

/**
 * The in-memory reference Kernel (design §2.6) — the smallest honest
 * implementation of the interpretation pipeline (§1.5 → §2.4 → §2.5):
 *
 * 1. **Compile** — walk the term's refs; each `Tool<Self>` tag is
 *    resolved from the *ambient context* (which is why `interpret`
 *    carries the term's `Req`), its parameters become an `effect/ai`
 *    tool schema, and its rendered template becomes the description.
 *    A Process charter's `AI.until` additionally compiles to **halt-as-tool**
 *    (§2.5): synthetic `resolve` (input schema = the halt schema) and
 *    `give_up` tools the kernel owns.
 * 2. **Drive** — interpretation forks the term's **ring** (`forkScoped`,
 *    lifetime = the interpretation Scope): one serial loop draining one
 *    admission mailbox. `dispatch` = admit + join a reply seat; `send` =
 *    admit alone. An Agent run is ONE step-machine turn; a Process run
 *    **iterates** turns per work item — same machine, same ring, with
 *    the boundary between iterations doing the §2.5 work (steer drain
 *    via the park, ceilings, fold = carry the transcript, nag when the
 *    model stops without resolving). `disableToolCallResolution: true`
 *    is load-bearing (§9.3): `effect/ai` never executes tools.
 * 3. **Settle** — tool failures are model-visible results, never thrown
 *    (`Err = never` on agents is a theorem); a Process's typed exits are
 *    `Refused` (ratified give-up) and `BudgetExceeded` (the provided —
 *    or default — budget policy); harness failures are defects.
 * 4. **Persist** — every external effect is preceded by a durable Trace
 *    row (§2.7 write-ahead) through the {@link TraceStore} seam.
 *
 * Deliberately absent: auto-delivery (canon §2 — `AI.when` is a pure
 * input declaration; delivery is ALWAYS explicit outside code via
 * `send`/`dispatch`/`steer`; only machine-observed halts subscribe, and
 * that subscription is kernel-internal), `AI.check`/`AI.fold` agents at
 * the boundary beyond the defaults (no check, transcript-carry fold),
 * the StepState stash (recovery), and N-consecutive `Refused`
 * ratification (a single evidence-bearing give_up refuses).
 */
export const KernelPolicy = Context.Reference<{
  readonly maxModelCalls: number;
  /** Token ceiling per turn; unlimited when absent. */
  readonly maxTokens?: number;
  /**
   * Iteration cap for budget-less loops (a harness guard, not a budget).
   * @default 24
   */
  readonly maxIterations?: number;
}>("alchemy/AI/KernelPolicy", {
  defaultValue: () => ({ maxModelCalls: 24 }),
});

/**
 * The default machine-exit correlation for one source (precedence:
 * explicit `halt.match` > THIS > any-event): settle only when the run's
 * work item and the observed event name the same world entity —
 * `source.key` equality, the same function the front door steers by.
 * Guarded: if computing either side's key throws or yields `undefined`
 * (a work item that isn't the event's shape — e.g. a plain-string demo
 * item), fall back to ACCEPTING the event, preserving the keyless
 * any-event behavior rather than parking the run forever.
 */
const keyEqualityMatch = (
  source: EventSource<any, any, any>,
): ((item: unknown, event: unknown) => boolean) => {
  const key = source.key;
  if (key === undefined) return () => true;
  return (item, event) => {
    try {
      const itemKey = key(item);
      const eventKey = key(event);
      if (itemKey === undefined || eventKey === undefined) return true;
      return itemKey === eventKey;
    } catch {
      return true;
    }
  };
};

/** Sum a response's known token totals; `undefined` = provider reported none. */
const usageTokens = (usage: {
  readonly inputTokens: { readonly total: number | undefined };
  readonly outputTokens: { readonly total: number | undefined };
}): number | undefined =>
  usage.inputTokens.total === undefined &&
  usage.outputTokens.total === undefined
    ? undefined
    : (usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0);

/** Parse a Budget token limit: `"5M"`, `"200k"`, `"120000"`. */
const parseTokenBudget = (limit: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(limit.trim());
  if (match === null) {
    throw new Error(`unparseable token budget: ${JSON.stringify(limit)}`);
  }
  const scale =
    match[2] === undefined ? 1 : match[2].toLowerCase() === "k" ? 1e3 : 1e6;
  return Number(match[1]) * scale;
};

/**
 * Internal, kernel-to-kernel surface (§2.8b): rings built by this kernel
 * expose a cancellable admission alongside the public verbs, so a parent
 * ring's interrupt can cancel exactly *its* child admissions (queued →
 * tombstone; active → control admission). Custom Layers that implement a
 * process tag by hand simply don't carry it — the cascade then degrades
 * to nothing for that child (the ledger makes this durable in Phase 3).
 */
const internalAdmit = Symbol.for("alchemy/AI/KernelMemory/admit");

interface AdmissionHandle {
  readonly await: Effect.Effect<unknown, unknown>;
  readonly cancel: Effect.Effect<void>;
}

/** The result a ring's turn runner hands back to its run driver. */
interface TurnResult {
  readonly outcome: Step.HaltOutcome;
  readonly state: Step.StepState;
}

type RunTurn = (options: {
  /** Turn-unique session key (command ids derive from it). */
  readonly session: string;
  /** Carried transcript from the previous iteration (the default fold). */
  readonly seed: ReadonlyArray<Prompt.Message>;
  /** This turn's fresh input (the work item or the boundary nag). */
  readonly input: ReadonlyArray<Prompt.Message>;
}) => Effect.Effect<TurnResult>;

export const memory: Layer.Layer<Kernel, never, LanguageModel.LanguageModel> =
  Layer.effect(
    Kernel,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      const store = yield* Effect.serviceOption(TraceStore).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => makeMemoryTraceStore,
          }),
        ),
      );
      // the Ask hub seam (§2.4 Ask protocol): in-memory default; a
      // harness (or test) provides its own Layer to hold the answering
      // side
      const askHub = yield* Effect.serviceOption(AskHub).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => makeMemoryAskHub,
          }),
        ),
      );
      // the harness event bus seam: delivery for kernel-internal
      // EventSources (Channel = never). Tests provide EventBusMemory to
      // hold the publishing side.
      const eventBus = yield* Effect.serviceOption(EventBus).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => makeMemoryEventBus,
          }),
        ),
      );
      let oneShot = 0;

      // subscribe one KERNEL-INTERNAL (channel-less) EventSource → its
      // harness-bus stream. Used ONLY by machine-observed halts on
      // internal sources (tests, same-harness stimuli). World-side
      // (channel-backed) sources are never subscribed by the kernel:
      // their exits arrive by explicit delivery — `settle(key, event)`
      // from the implementation Layer that consumed the wire (canon §5:
      // implementations own delivery — exits included).
      const subscribeSource = Effect.fn(function* (
        source: EventSource<any, any, any>,
      ) {
        return yield* eventBus.subscribe(source);
      });

      // resolve a term's charter to prose, filling any dynamic-prose
      // Value refs from ambient context (reassess §F). Resolution
      // happens ONCE per interpretation (not per run) — promptHash
      // stamps once, prompt-caching stays effective.
      const renderCharter = Effect.fn(function* (term: {
        template: TemplateStringsArray | ReadonlyArray<string>;
        refs: ReadonlyArray<unknown>;
      }) {
        const resolved = new Map<unknown, string>();
        for (const ref of term.refs) {
          if (isValue(ref)) {
            const v = yield* Effect.serviceOption((ref as Value).tag as never);
            resolved.set(
              ref,
              Option.isSome(v)
                ? String(v.value)
                : `{${(ref as any).tag?.key ?? "value"}}`,
            );
          }
        }
        return renderTemplate(term.template, term.refs, (ref) =>
          resolved.get(ref),
        );
      });

      /**
       * The ring: ONE serial loop per process term, started when the
       * Layer is built (forkScoped — release the Layer, the ring dies).
       * `send` and `dispatch` are admissions into the same mailbox; a
       * run never executes outside the ring, so single-writer discipline
       * holds by construction. This is the local analogue of the Durable
       * Object kernel: the mailbox is the admission ledger, `Queue.take`
       * is the alarm wake.
       */
      const makeRing = Effect.fn(function* (options: {
        readonly termName: string;
        readonly system: string;
        readonly compiled: CompiledTools;
        readonly policy: { maxModelCalls: number; maxTokens?: number };
        /** Serve one work item; a Process's typed exits ride the error channel. */
        readonly runItem: (
          item: unknown,
          run: {
            readonly session: string;
            readonly runTurn: RunTurn;
            readonly emitRow: (
              session: string,
              type: string,
              cause: string,
              kind: string,
              payload?: unknown,
            ) => Effect.Effect<unknown>;
            /** Drain any run-key–addressed steers parked for this run. */
            readonly takeSteers: () => Prompt.Message[];
            /** Park until a run-key–addressed steer arrives for this run. */
            readonly awaitSteer: Effect.Effect<Prompt.Message[]>;
            /**
             * Park until `settle(key, event)` delivers this run's
             * machine-observed exit (or an internal channel-less source
             * completes the same seat via the bus).
             */
            readonly awaitSettle: Effect.Effect<unknown>;
          },
        ) => Effect.Effect<unknown, unknown>;
        /**
         * In-flight delegations of this ring (§2.8b): `interrupt` fans
         * out to every registered child before settling its own turn —
         * authority flows down, no orphaned token burn.
         */
        readonly children?: Set<{ readonly cancel: Effect.Effect<void> }>;
      }) {
        const { termName, system, compiled, policy } = options;

        // Steering (§2.4/§9.3): a steer is an admission, never an
        // interruption. Mid-turn it lands in the ACTIVE turn's feedback
        // inbox as `Steered`; between turns it parks here and enters the
        // next turn ahead of its Dispatched (round-1 promotion). For a
        // Process this IS the §2.5 boundary drain: parked steers enter the
        // next iteration's first round. Single-threaded mutation is safe.
        const parkedSteers: Prompt.Message[] = [];
        // Run-key addressing (canon §1: `steer(runKey, msg)` is the
        // actor-model tell to a running actor). The run key is the
        // session minted at admission — the `run.admitted` row's
        // `session`, so outside code correlates from the Trace. Keyed
        // steers park here until THEIR run's next boundary; a keyed
        // steer to a parked machine-exit run completes its wake seat so
        // the run serves another work round. Single-threaded mutation.
        const keyedSteers = new Map<string, Prompt.Message[]>();
        const parkWakes = new Map<string, Deferred.Deferred<void>>();
        // Run naming (canon §5: implementations own delivery): `send(item,
        // { key })` names the run with its WORLD identity ("owner/repo#7")
        // so steer/settle address it without ever seeing the kernel
        // session. names: world key → session, live for the run's life.
        const names = new Map<string, string>();
        // Every run's machine-exit seat, by session: `settle(key, event)`
        // completes it; a machine-exit run awaits it as its exit (internal
        // channel-less sources complete the same seat via the bus).
        const settleSeats = new Map<string, Deferred.Deferred<unknown>>();
        const resolveRunKey = (runKey: string): string =>
          names.get(runKey) ?? runKey;
        let activeSession: string | undefined;
        const takeKeyedSteers = (runKey: string): Prompt.Message[] => {
          const messages = keyedSteers.get(runKey) ?? [];
          keyedSteers.delete(runKey);
          return messages;
        };
        const awaitKeyedSteer = (
          runKey: string,
        ): Effect.Effect<Prompt.Message[]> =>
          Effect.suspend(() => {
            const now = takeKeyedSteers(runKey);
            if (now.length > 0) return Effect.succeed(now);
            return Effect.gen(function* () {
              const wake = yield* Deferred.make<void>();
              parkWakes.set(runKey, wake);
              yield* Deferred.await(wake).pipe(
                Effect.ensuring(Effect.sync(() => parkWakes.delete(runKey))),
              );
              return takeKeyedSteers(runKey);
            });
          });
        let activeInbox: Step.Feedback[] | undefined;
        // set by interrupt(): un-started commands of the current batch
        // are abandoned (the machine settles them as aborted results)
        let interruptRequested = false;
        // completed by interrupt(): the IN-FLIGHT tool execution is raced
        // against this and settles as an aborted result — a delegation
        // blocked on a slow child unblocks immediately (§2.8b)
        let interruptSignal: Deferred.Deferred<void> | undefined;

        const emitRow = (
          session: string,
          type: string,
          cause: string,
          kind: string,
          payload?: unknown,
        ) =>
          store.commit([
            {
              v: 1,
              type,
              id: eventId(cause, kind),
              durable: true,
              ring: [termName],
              session,
              cause,
              payload,
            },
          ]);

        const runTurn: RunTurn = Effect.fn(function* ({
          session,
          seed,
          input,
        }) {
          const emit = (
            type: string,
            cause: string,
            kind: string,
            payload?: unknown,
          ) => emitRow(session, type, cause, kind, payload);

          let state = Step.initialState({
            session,
            messages: seed,
            ...policy,
          });
          let steerOrdinal = 0;
          // parked steers precede Dispatched: the machine queues them
          // first, so round 1's boundary already promotes them
          const inbox: Step.Feedback[] = [
            ...(parkedSteers.length > 0
              ? [
                  {
                    _tag: "Steered" as const,
                    messages: parkedSteers.splice(0),
                  },
                ]
              : []),
            { _tag: "Dispatched", input },
          ];
          activeInbox = inbox;
          interruptRequested = false; // an old interrupt never leaks forward
          interruptSignal = yield* Deferred.make<void>();

          try {
            while (true) {
              const feedback = inbox.shift();
              if (feedback === undefined) {
                return yield* Effect.die(
                  new Error(
                    `step machine stalled without halting (${session})`,
                  ),
                );
              }
              if (feedback._tag === "Interrupt" && inbox.length > 0) {
                // already-paid work folds into the transcript first (its
                // commands are abandoned by the flag); the interrupt then
                // settles whatever remains un-run
                inbox.push(feedback);
                continue;
              }
              if (feedback._tag === "Steered") {
                // a steer is a durable admission — it must survive
                // recovery and be visible to folds, so it rows the Trace
                yield* emit(
                  "turn.steered",
                  session,
                  `steer-${steerOrdinal++}`,
                  { messages: feedback.messages.length },
                );
              }
              const [next, commands] = Step.step(state, feedback);
              state = next;

              for (const command of commands) {
                // an interrupt abandons commands that haven't started
                if (interruptRequested && command._tag !== "Halt") break;
                switch (command._tag) {
                  case "CallModel": {
                    // write-ahead: durable intent BEFORE the wire call
                    yield* emit("model.requested", command.id, "request");

                    // fold streaming parts into the distilled ModelOutcome;
                    // text deltas fan out to the firehose as LIVE events
                    // (durable: false — invisible to the trace, §2.3)
                    const folded = {
                      text: "",
                      toolCalls: [] as Step.PendingToolCall[],
                      finishReason: "unknown",
                      tokens: undefined as number | undefined,
                      usage: undefined as unknown,
                      deltas: 0,
                    };
                    // each retry attempt starts from a clean fold — a
                    // half-consumed failed stream must never double-append
                    const attempt = Effect.suspend(() => {
                      folded.text = "";
                      folded.toolCalls = [];
                      folded.finishReason = "unknown";
                      folded.tokens = undefined;
                      folded.usage = undefined;
                      folded.deltas = 0;
                      return model
                        .streamText({
                          prompt: Prompt.fromMessages([
                            Prompt.makeMessage("system", { content: system }),
                            ...command.messages,
                          ]),
                          toolkit: compiled.toolkit as never,
                          disableToolCallResolution: true,
                        })
                        .pipe(
                          // a wire connection that produces NOTHING for
                          // this long is dead, not slow — without a stall
                          // guard a silently dropped SSE connection wedges
                          // the ring FOREVER (found live: a #support post
                          // hung at model.requested with no terminal).
                          // Retryable: the retry loop below reconnects.
                          Stream.timeoutOrElse({
                            duration: "45 seconds",
                            orElse: () =>
                              Stream.fail(
                                new AiError.InternalProviderError({
                                  description:
                                    "provider stream stalled: no parts for 45s",
                                }),
                              ),
                          }),
                          // widened: the `as never` toolkit collapses the
                          // inferred Tools to {}, dropping tool-call parts
                          Stream.runForEach((part: Response.AnyPart) => {
                            switch (part.type) {
                              case "text-delta":
                                return Effect.sync(() => {
                                  folded.text += part.delta;
                                  return folded.deltas++;
                                }).pipe(
                                  Effect.flatMap((ordinal) =>
                                    store.commit([
                                      {
                                        v: 1,
                                        type: "model.delta",
                                        id: eventId(
                                          command.id,
                                          "delta",
                                          String(ordinal),
                                        ),
                                        durable: false,
                                        ring: [termName],
                                        session,
                                        cause: command.id,
                                        payload: { delta: part.delta },
                                      },
                                    ]),
                                  ),
                                  Effect.asVoid,
                                );
                              // reasoning is LIVE-ONLY (never journaled):
                              // it renders while streaming and is absent
                              // from trace replay by design
                              case "reasoning-delta":
                                return Effect.sync(() => folded.deltas++).pipe(
                                  Effect.flatMap((ordinal) =>
                                    store.commit([
                                      {
                                        v: 1,
                                        type: "model.delta",
                                        id: eventId(
                                          command.id,
                                          "delta",
                                          String(ordinal),
                                        ),
                                        durable: false,
                                        ring: [termName],
                                        session,
                                        cause: command.id,
                                        payload: {
                                          delta: part.delta,
                                          kind: "reasoning",
                                        },
                                      },
                                    ]),
                                  ),
                                  Effect.asVoid,
                                );
                              case "tool-call":
                                return Effect.sync(() => {
                                  folded.toolCalls.push({
                                    callId: part.id,
                                    name: part.name,
                                    params: part.params,
                                  });
                                });
                              case "finish":
                                return Effect.sync(() => {
                                  folded.finishReason = part.reason;
                                  folded.usage = part.usage;
                                  folded.tokens = usageTokens(part.usage);
                                });
                              default:
                                return Effect.void;
                            }
                          }),
                        );
                    });
                    // transient provider failures (5xx, rate limits,
                    // network resets) retry with bounded backoff — the
                    // provider marks retryability; everything else is a
                    // harness failure (a defect, not an agent error)
                    yield* attempt.pipe(
                      Effect.retry({
                        // the `as never` toolkit collapses the inferred
                        // error union; the wire errors are AiError (the
                        // stall guard's InternalProviderError included)
                        while: (error: AiError.AiErrorReason) =>
                          error.isRetryable,
                        schedule: Schedule.exponential("500 millis"),
                        times: 4,
                      }),
                      Effect.orDie,
                    );

                    yield* emit("model.completed", command.id, "response", {
                      finishReason: folded.finishReason,
                      usage: folded.usage,
                      toolCalls: folded.toolCalls.map((call) => call.callId),
                    });
                    inbox.push({
                      _tag: "ModelResponse",
                      commandId: command.id,
                      outcome: {
                        text: folded.text,
                        toolCalls: folded.toolCalls,
                        finishReason: folded.finishReason,
                        tokens: folded.tokens,
                      },
                    });
                    break;
                  }
                  case "CallTool": {
                    // write-ahead: intent before execution (§2.7); params
                    // ride the row so UIs can render the call from the
                    // Trace alone
                    yield* emit("tool.requested", command.id, "request", {
                      callId: command.callId,
                      name: command.name,
                      params: command.params,
                    });
                    const handler = compiled.handlers.get(command.name);
                    // the Ask service scoped to THIS command (§2.4): a
                    // tool that parks gets a deterministic ask id, a
                    // durable ask.requested row BEFORE the park, and
                    // ask.answered after — the park itself is just an
                    // in-flight tool execution
                    const provideAsk = (
                      effect: Effect.Effect<unknown, unknown>,
                    ) =>
                      Effect.provideService(effect, Ask, (payload) =>
                        Effect.gen(function* () {
                          const askId = eventId(command.id, "ask");
                          yield* emit("ask.requested", command.id, "ask", {
                            askId,
                            payload,
                          });
                          const answer = yield* askHub.ask({
                            id: askId,
                            ring: termName,
                            session,
                            payload,
                          });
                          yield* emit("ask.answered", command.id, "answer", {
                            askId,
                            verdict: answer.verdict,
                            ...(answer.amendment !== undefined && {
                              amendment: answer.amendment,
                            }),
                          });
                          return answer;
                        }),
                      );
                    // raced against the interrupt signal: an interrupt
                    // fiber-interrupts the in-flight execution and settles
                    // it as an aborted, model-visible result (§2.8b) —
                    // a delegation blocked on a slow child (or a parked
                    // ask) unblocks NOW
                    const signal = interruptSignal!;
                    const settled = handler
                      ? yield* Effect.result(
                          Effect.raceFirst(
                            provideAsk(handler(command.params)),
                            Deferred.await(signal).pipe(
                              Effect.andThen(
                                Effect.fail(kernelPrompts.abortedByInterrupt()),
                              ),
                            ),
                          ),
                        )
                      : Result.fail(kernelPrompts.noSuchTool(command.name));
                    const isFailure = Result.isFailure(settled);
                    const result = Result.isSuccess(settled)
                      ? settled.success
                      : // model-visible failure text, never thrown
                        String(
                          (settled as Result.Failure<unknown, unknown>).failure,
                        );
                    yield* emit(
                      isFailure ? "tool.failed" : "tool.completed",
                      command.id,
                      "result",
                      { callId: command.callId, name: command.name, result },
                    );
                    inbox.push({
                      _tag: "ToolSettled",
                      callId: command.callId,
                      isFailure,
                      result,
                    });
                    break;
                  }
                  case "Halt": {
                    // a steer racing the final round parks for the next turn
                    for (const remaining of inbox) {
                      if (remaining._tag === "Steered") {
                        parkedSteers.push(...remaining.messages);
                      }
                    }
                    yield* emit("turn.halted", command.id, "halt", {
                      outcome: command.outcome._tag,
                      // the final text rides the row so a transcript view
                      // can finalize the assistant message from the Trace
                      ...(command.outcome._tag === "Completed" && {
                        text: command.outcome.text,
                      }),
                      ...(command.outcome._tag === "Interrupted" && {
                        abandoned: command.outcome.abandoned,
                      }),
                    });
                    return { outcome: command.outcome, state };
                  }
                }
              }
            }
          } finally {
            activeInbox = undefined;
          }
        });

        interface Admission {
          readonly item: unknown;
          /** The caller's world-identity name for the run (send options.key). */
          readonly key?: string;
          /** Present iff a dispatcher is joined on the outcome. */
          readonly reply?: Deferred.Deferred<unknown, unknown>;
          /** Tombstoned by a cascade cancel; the ring skips it. */
          cancelled?: boolean;
        }
        const mailbox = yield* Queue.unbounded<Admission>();
        let current: Admission | undefined;
        const ring = yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(Queue.take(mailbox), (admission) =>
              // cancelled while queued: reply already settled by cancel
              admission.cancelled === true
                ? Effect.void
                : Effect.suspend(() => {
                    current = admission;
                    const session = `${termName}#${oneShot++}`;
                    activeSession = session;
                    // the run's world name (if the implementation gave
                    // one) and its machine-exit seat, live for the run
                    if (admission.key !== undefined) {
                      names.set(admission.key, session);
                    }
                    return Effect.flatMap(
                      Effect.exit(
                        // the admission is a durable fact (§2.7): without
                        // it the run's INPUT is not reconstructible from
                        // the Trace — the serving tier's transcript view
                        // derives its user half from this row
                        Effect.andThen(
                          Effect.tap(
                            Deferred.make<unknown>().pipe(
                              Effect.tap((seat) =>
                                Effect.sync(() =>
                                  settleSeats.set(session, seat),
                                ),
                              ),
                            ),
                            () =>
                              emitRow(
                                session,
                                "run.admitted",
                                session,
                                "admitted",
                                {
                                  item: admission.item,
                                  ...(admission.key !== undefined && {
                                    key: admission.key,
                                  }),
                                },
                              ),
                          ),
                          options.runItem(admission.item, {
                            session,
                            runTurn,
                            emitRow,
                            takeSteers: () => takeKeyedSteers(session),
                            awaitSteer: awaitKeyedSteer(session),
                            awaitSettle: Effect.suspend(() =>
                              Deferred.await(settleSeats.get(session)!),
                            ),
                          }),
                        ).pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              current = undefined;
                              activeSession = undefined;
                              // a settled run's undelivered keyed steers,
                              // name, and settle seat are dropped (the
                              // actor is gone)
                              keyedSteers.delete(session);
                              settleSeats.delete(session);
                              if (admission.key !== undefined) {
                                names.delete(admission.key);
                              }
                            }),
                          ),
                        ),
                      ),
                      (exit) =>
                        Effect.andThen(
                          // the UNIFORM durable terminal: every run
                          // settles, success or failure — without this
                          // row a failed run (BudgetExceeded, Refused,
                          // defect) is not reconstructible from the
                          // Trace and a serving window has nothing to
                          // close on (§2.7; found by the org channel: a
                          // process run's window hung forever because
                          // only per-ITERATION turn.halted rows exist)
                          emitRow(
                            session,
                            "run.settled",
                            session,
                            "settled",
                            Exit.isSuccess(exit)
                              ? { outcome: "Completed" }
                              : {
                                  outcome: "Failed",
                                  error: describeRunFailure(exit.cause),
                                },
                          ),
                          admission.reply !== undefined
                            ? Effect.asVoid(
                                Deferred.done(admission.reply, exit),
                              )
                            : Exit.isFailure(exit)
                              ? Effect.logWarning(
                                  "memory kernel: unobserved run failed",
                                  exit.cause,
                                )
                              : Effect.void,
                        ),
                    );
                  }),
            ),
          ),
        );

        const requestInterrupt = Effect.suspend(() => {
          if (activeInbox === undefined) return Effect.void;
          interruptRequested = true;
          activeInbox.push({ _tag: "Interrupt" });
          // release the in-flight tool execution (raced in CallTool)
          return interruptSignal !== undefined
            ? Effect.asVoid(Deferred.succeed(interruptSignal, void 0))
            : Effect.void;
        });

        /**
         * Internal cancellable admission (§2.8b) — the substrate for
         * `dispatch` and for the delegation compiler's cascade. `cancel`
         * is run-addressed: a queued admission tombstones (its reply
         * settles as Interrupted without ever running); the ACTIVE
         * admission interrupts the ring's current turn — safe on shared
         * delegates because the ring is serial: active means *this* item.
         */
        const admit = (item: unknown, key?: string) =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<unknown, unknown>();
            const admission: Admission = { item, key, reply };
            yield* Queue.offer(mailbox, admission);
            return {
              await: Deferred.await(reply),
              cancel: Effect.suspend(() => {
                admission.cancelled = true;
                const settle = Effect.asVoid(
                  Deferred.done(
                    reply,
                    Exit.succeed({
                      _tag: "Interrupted",
                      abandoned: [],
                    } satisfies Step.HaltOutcome),
                  ),
                );
                return current === admission
                  ? Effect.andThen(requestInterrupt, settle)
                  : settle;
              }),
            };
          });

        return {
          // dispatch = send + join: same admission path, plus a reply seat
          dispatch: (item: unknown, options?: { readonly key?: string }) =>
            Effect.flatMap(admit(item, options?.key), (handle) => handle.await),
          // send = the admission half alone (fire-and-forget); options.key
          // NAMES the run with its world identity for steer/settle
          send: (item: unknown, options?: { readonly key?: string }) =>
            Effect.asVoid(Queue.offer(mailbox, { item, key: options?.key })),
          // run = join the ring's unbounded life. Vestigial (canon §2):
          // auto-delivery is demoted — the mailbox drain is
          // kernel-internal and delivery is explicit outside code.
          run: () => Fiber.join(ring),
          // steer = mid-run admission, two addressing forms:
          //
          // - steer(msg): into the ACTIVE turn's feedback inbox
          //   (promoted at its next boundary), or parked for the next
          //   turn's/iteration's round 1 when nothing is active;
          // - steer(runKey, msg): addressed to a SPECIFIC run. The
          //   active run's turn takes it now; otherwise it parks keyed
          //   and wakes the run's park seat (a parked machine-exit run
          //   serves another work round).
          steer: (first: unknown, second?: unknown) =>
            Effect.suspend(() => {
              if (second !== undefined) {
                // the caller addresses by world name or kernel session
                const runKey = resolveRunKey(String(first));
                const messages = toMessages(second);
                if (runKey === activeSession && activeInbox !== undefined) {
                  activeInbox.push({ _tag: "Steered", messages });
                  return Effect.void;
                }
                keyedSteers.set(runKey, [
                  ...(keyedSteers.get(runKey) ?? []),
                  ...messages,
                ]);
                const wake = parkWakes.get(runKey);
                return wake !== undefined
                  ? Effect.asVoid(Deferred.succeed(wake, void 0))
                  : Effect.void;
              }
              const messages = toMessages(first);
              if (activeInbox !== undefined) {
                activeInbox.push({ _tag: "Steered", messages });
              } else {
                parkedSteers.push(...messages);
              }
              return Effect.void;
            }),
          // settle = the machine-observed exit, DELIVERED (canon §5:
          // implementations own delivery — exits included). Completes the
          // named run's exit seat with the event; the parked machine-exit
          // run resolves with it as Out. A key with no live run is an
          // idempotent no-op: the run may have settled already — the
          // world outranks the org's beliefs.
          settle: (runKey: string, event: unknown) =>
            Effect.suspend(() => {
              const session = resolveRunKey(runKey);
              const seat = settleSeats.get(session);
              return seat !== undefined
                ? Effect.asVoid(Deferred.succeed(seat, event))
                : Effect.void;
            }),
          // interrupt = Scope authority as a control admission (§0.6),
          // CASCADING (§2.8b): children first — every in-flight
          // delegation is cancelled on its own ring — then the active
          // turn settles its batch and halts as Interrupted. Idle rings
          // have nothing to interrupt.
          interrupt: () =>
            Effect.gen(function* () {
              const children = [...(options.children ?? [])];
              yield* Effect.forEach(children, (child) => child.cancel, {
                discard: true,
              });
              yield* requestInterrupt;
            }),
          [internalAdmit]: admit,
        };
      });

      // ── Agent: a run is ONE turn at kernel-default control parameters ──

      const interpretAgent = Effect.fn(function* (term: {
        "~alchemy/Name": string;
        template: TemplateStringsArray;
        refs: unknown[];
      }) {
        const policy = yield* KernelPolicy;
        // late-bound: completion steers from background delegations route
        // to this ring's own steer verb once the ring exists (§2.8)
        const steerCell: SteerCell = {};
        const children = new Set<{ readonly cancel: Effect.Effect<void> }>();
        const compiled = yield* compileTools(
          term.refs,
          undefined,
          steerCell,
          children,
        );
        const service = yield* makeRing({
          termName: term["~alchemy/Name"],
          system: yield* renderCharter(term),
          compiled,
          policy,
          children,
          runItem: (item, run) =>
            Effect.map(
              run.runTurn({
                session: run.session,
                seed: [],
                input: toMessages(item),
              }),
              (result) => result.outcome,
            ),
        });
        steerCell.current = service.steer;
        return service;
      });

      // ── Process: a run ITERATES turns per work item (§2.5) ──────────────

      const interpretProcess = Effect.fn(function* (term: {
        "~alchemy/Name": string;
        template: TemplateStringsArray;
        refs: unknown[];
      }) {
        const termName = term["~alchemy/Name"];
        const halt = term.refs.find(isHalt) as Halt | undefined;
        if (halt === undefined) {
          // the §1.4 lint: undeclared perpetuity. The missing exit is a
          // type (Out = never); running it requires DECLARING it
          return yield* Effect.fail(
            new KernelError({
              term: termName,
              message:
                "undeclared perpetuity: wire an AI.until halt or declare the ring perpetual with AI.never",
            }),
          );
        }
        // budget is provided where the term is provided (a Layer via
        // AI.budget({...})), never spliced in prose — resolved here per
        // term at interpretation, defaulting to no explicit ceilings
        // (the kernel's own guards below still apply)
        const budget = yield* BudgetPolicy;
        const policy = yield* KernelPolicy;

        // ── perpetual rings (AI.never): now legal — each work item is
        // served as ONE kernel-default turn (agent semantics per item);
        // the RING never resolves. Health is the Trace, not an exit.
        if (halt.mode === "never") {
          const steerCell: SteerCell = {};
          const children = new Set<{ readonly cancel: Effect.Effect<void> }>();
          const compiled = yield* compileTools(
            term.refs,
            undefined,
            steerCell,
            children,
          );
          const service = yield* makeRing({
            termName,
            // the never-halt is in term.refs; the renderer emits the
            // perpetual note in place (§A) — no kernel re-append
            system: yield* renderCharter(term),
            compiled,
            policy,
            children,
            runItem: (item, run) =>
              Effect.map(
                run.runTurn({
                  session: run.session,
                  seed: [],
                  input: toMessages(item),
                }),
                (result) => result.outcome,
              ),
          });
          steerCell.current = service.steer;
          return service;
        }

        // ── machine-observed exit (reassess §B): the WORLD declares the
        // end, not the model's claim. No resolve/give_up tools — the
        // model works the item with its own tools; the run settles when
        // the exit source delivers a matching event (Out = the payload).
        // The halt's `match` correlates events to THIS run's work item
        // (canon §2: per-item correlation is P0) — concurrent runs of
        // one term each exit only on THEIR event. Reconciler doctrine:
        // the model may CAUSE the event (closing the issue), but the run
        // settles on OBSERVING it. Each round parks on the exit; a
        // run-key steer (`steer(runKey, msg)`) wakes the parked run for
        // another work round with the steered input.
        if (halt.sources !== undefined) {
          const sources = halt.sources;
          const steerCell: SteerCell = {};
          const children = new Set<{ readonly cancel: Effect.Effect<void> }>();
          const compiled = yield* compileTools(
            term.refs,
            undefined,
            steerCell,
            children,
          );
          const service = yield* makeRing({
            termName,
            system: yield* renderCharter(term),
            compiled,
            policy,
            children,
            runItem: (item, run) =>
              // scoped: the exit watcher fibers die when the run returns
              Effect.scoped(
                Effect.gen(function* () {
                  // The exit arrives by DELIVERY (canon §5: implementations
                  // own delivery — exits included): the implementation
                  // Layer that received the world's event calls
                  // `settle(key, event)`, completing this run's seat. The
                  // kernel subscribes to NOTHING for channel-backed world
                  // sources. Channel-less (kernel-internal) sources keep
                  // the harness-bus path — tests and same-harness stimuli
                  // publish there, correlated by match/key as before.
                  const exit = yield* Deferred.make<unknown>();
                  yield* Effect.forkScoped(
                    Effect.flatMap(run.awaitSettle, (event) =>
                      Effect.asVoid(Deferred.succeed(exit, event)),
                    ),
                  );
                  for (const source of sources) {
                    if (source.channel !== undefined) continue; // world: delivered, never subscribed
                    const match = halt.match ?? keyEqualityMatch(source);
                    const stream = yield* subscribeSource(source);
                    yield* Effect.forkScoped(
                      Stream.runForEach(stream, (event) =>
                        match(item, event)
                          ? Effect.asVoid(Deferred.succeed(exit, event))
                          : Effect.void,
                      ),
                    );
                  }
                  let seed: ReadonlyArray<Prompt.Message> = [];
                  let input = toMessages(item);
                  let iterations = 0;
                  while (true) {
                    iterations++;
                    // a work round: the model does what it can (comment,
                    // call a close tool, …) — its own action may cause
                    // the exit event. Keyed steers that raced the round
                    // join its input.
                    const { outcome, state } = yield* run.runTurn({
                      session: `${run.session}/i${iterations}`,
                      seed,
                      input: [...input, ...run.takeSteers()],
                    });
                    if (outcome._tag === "Interrupted") {
                      return yield* Effect.die(
                        new Error("interim: interrupted source-halt run"),
                      );
                    }
                    // PARK until the world declares the exit (immediate
                    // if the turn already caused it) — or a run-key
                    // steer wakes the run for another work round
                    yield* run.emitRow(
                      run.session,
                      "run.parked",
                      run.session,
                      `parked-${iterations}`,
                      {},
                    );
                    const wake = yield* Effect.raceFirst(
                      Effect.map(Deferred.await(exit), (event) => ({
                        _tag: "exit" as const,
                        event,
                      })),
                      Effect.map(run.awaitSteer, (messages) => ({
                        _tag: "steer" as const,
                        messages,
                      })),
                    );
                    if (wake._tag === "exit") {
                      yield* run.emitRow(
                        run.session,
                        "run.resolved",
                        run.session,
                        "resolved",
                        { observed: true, value: wake.event },
                      );
                      return wake.event;
                    }
                    // steered awake: fold = carry the transcript; the
                    // steer is the next round's input
                    yield* run.emitRow(
                      run.session,
                      "run.steered",
                      run.session,
                      `steered-${iterations}`,
                      { messages: wake.messages.length },
                    );
                    seed = state.messages;
                    input = wake.messages;
                  }
                }),
              ),
          });
          steerCell.current = service.steer;
          return service;
        }

        // ── the check (§2.5/§8.2/§2.9): maker/checker on the stop
        // condition. The verifier is a positional arrow the KERNEL
        // invokes at the boundary — never a tool the worker may consult
        // or impersonate. Two kinds of arrow (§2.9: occurrence is
        // deterministic either way; only the judgment differs in kind):
        // an Agent judge (fuzzy — resolves from ambient context like a
        // delegate, its run/read-only physics a Layer fact) or a
        // MachineCheck (a deterministic oracle the kernel calls directly).
        const checkRef = term.refs.find(isCheck) as
          | Check<any, any[]>
          | undefined;
        const machineCheck =
          checkRef !== undefined && !isAgent(checkRef.agent)
            ? (checkRef.agent as MachineCheck)
            : undefined;
        const judge =
          checkRef === undefined || machineCheck !== undefined
            ? undefined
            : yield* Effect.serviceOption(checkRef.agent as never).pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: (service) =>
                      Effect.succeed(
                        service as {
                          dispatch: (
                            item: unknown,
                          ) => Effect.Effect<unknown, unknown, never>;
                        },
                      ),
                    onNone: () =>
                      Effect.die(
                        new Error(
                          `check agent ${checkRef.agent["~alchemy/Name"]} has no implementation in context (Req should have caught this)`,
                        ),
                      ),
                  }),
                ),
              );
        const checkInstructions =
          checkRef?.template !== undefined
            ? renderTemplate(checkRef.template, checkRef.refs)
            : undefined;

        // halt-as-tool (§2.5/§9.3): the cheapest correct AI.until. The
        // model ends a run by CALLING a tool, so resolution flows through
        // the same command/settlement discipline as everything else;
        // schema-invalid resolves bounce back as tool errors for
        // self-correction.
        const haltSchema = halt.schema;
        // set per run by runItem; written by the synthetic handlers.
        // Single-writer ring makes this safe.
        let currentRun: { resolved?: { value: unknown }; refusal?: string } =
          {};
        // The advertised wire schema is a JSON-encoded STRING, not the
        // halt schema itself: effect/ai decodes tool-call parts against
        // the advertised schema at the stream layer, and a schema-invalid
        // resolve must bounce back as a tool error for self-correction
        // (§2.5) — never kill the stream. A string always wire-decodes;
        // the KERNEL parses and validates strictly in the handler, and
        // the halt prose in the system prompt carries the shape.
        const syntheticTools: AiTool.Any[] = [
          AiTool.make("resolve", {
            description: kernelPrompts.resolveDescription({
              hasSchema: haltSchema !== undefined,
            }),
            // schema-less halts still need a non-empty params object:
            // Anthropic rejects an empty struct's input_schema
            parameters: (haltSchema !== undefined
              ? S.Struct({ value: S.String })
              : S.Struct({ note: S.String })) as never,
          }),
          AiTool.make("give_up", {
            description: kernelPrompts.giveUpDescription(),
            parameters: S.Struct({ reason: S.String }) as never,
          }),
        ];
        const syntheticHandlers = new Map<
          string,
          (params: unknown) => Effect.Effect<unknown, unknown>
        >([
          [
            "resolve",
            (params) => {
              if (haltSchema === undefined) {
                currentRun.resolved = { value: undefined };
                return Effect.succeed(kernelPrompts.resolveAck());
              }
              const raw = (params as { value?: unknown } | undefined)?.value;
              let parsed: unknown;
              try {
                parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
              } catch {
                // a bare string is a legal wire: models reasonably send
                // prose unquoted for string-shaped halts (found by the
                // org channel — every plain-sentence resolution bounced
                // until the budget killed the run). Strictness lives in
                // the schema decode below, not in JSON syntax.
                parsed = raw;
              }
              const decoded = S.decodeUnknownResult(haltSchema as never)(
                parsed,
              );
              if (Result.isFailure(decoded)) {
                // model-visible bounce: self-correct and resolve again
                return Effect.fail(
                  kernelPrompts.resolveSchemaMismatch(String(decoded.failure)),
                );
              }
              currentRun.resolved = { value: decoded.success };
              return Effect.succeed(kernelPrompts.resolveAck());
            },
          ],
          [
            "give_up",
            (params) => {
              currentRun.refusal = String(
                (params as { reason?: unknown } | undefined)?.reason ??
                  "no reason given",
              );
              return Effect.succeed(kernelPrompts.giveUpAck());
            },
          ],
        ]);

        const steerCell: SteerCell = {};
        const children = new Set<{ readonly cancel: Effect.Effect<void> }>();
        const compiled = yield* compileTools(
          term.refs,
          { tools: syntheticTools, handlers: syntheticHandlers },
          steerCell,
          children,
        );

        // haltProse still feeds the verifier prompt + boundary nag; the
        // halt CONTRACT now renders in place via the interpolated
        // ${AI.until(…)} ref (§A). The kernel only appends the verified
        // note, which the halt ref can't know (it depends on a check).
        const haltProse = renderTemplate(halt.template, halt.refs);
        const system =
          (yield* renderCharter(term)) +
          (judge !== undefined || machineCheck !== undefined
            ? kernelPrompts.verifiedNote()
            : "");

        const maxIterations = budget.iterations ?? policy.maxIterations ?? 24;
        const tokenCeiling =
          budget.tokens !== undefined
            ? parseTokenBudget(budget.tokens)
            : undefined;

        const service = yield* makeRing({
          termName,
          system,
          compiled,
          policy,
          children,
          runItem: (item, run) =>
            Effect.gen(function* () {
              currentRun = {};
              let transcript: ReadonlyArray<Prompt.Message> = [];
              let input = toMessages(item);
              let iterations = 0;
              let cumulativeTokens = 0;

              while (true) {
                iterations++;
                const { outcome, state } = yield* run.runTurn({
                  session: `${run.session}/i${iterations}`,
                  seed: transcript,
                  // run-key–addressed steers join this run's boundary
                  input: [...input, ...run.takeSteers()],
                });
                cumulativeTokens += state.tokensUsed;

                // a turn-level harness ceiling is the loop's typed exit:
                // the kernel always enforces SOME ceiling (provided
                // budget or default guard), so exhaustion is always a
                // typed possibility (ProcessErr carries BudgetExceeded
                // unconditionally)
                if (outcome._tag === "BudgetExceeded") {
                  return yield* Effect.fail(
                    new BudgetExceeded({
                      loop: termName,
                      limit:
                        outcome.limit === "tokens" ? "tokens" : "iterations",
                      budget: outcome.budget,
                      used: outcome.used,
                    }),
                  );
                }
                if (outcome._tag === "Interrupted") {
                  return yield* Effect.die(
                    new Error(
                      "interim: interrupted loop runs surface with the kernel Message type",
                    ),
                  );
                }

                // resolution first: an achieved goal trumps a give-up —
                // but with a check ref, the claim is GRADED before it is
                // believed (§8.2: the worker's claim of done-ness is not
                // a signal)
                let rejection: string | undefined;
                if (currentRun.resolved !== undefined) {
                  if (judge !== undefined || machineCheck !== undefined) {
                    yield* run.emitRow(
                      run.session,
                      "check.requested",
                      run.session,
                      `check-${iterations}`,
                      { iterations },
                    );
                    // a machine verifier is invoked directly (no model,
                    // no parse — a deterministic oracle); an agent judge
                    // is dispatched and its verdict parsed from text
                    const verdict: CheckVerdict | undefined =
                      machineCheck !== undefined
                        ? yield* machineCheck({
                            workItem: item,
                            haltProse,
                            claim: currentRun.resolved.value,
                          })
                        : parseVerdict(
                            yield* judge!.dispatch(
                              kernelPrompts.verifierPrompt({
                                // the judge needs the run's mandate, not
                                // just the claim: without the work item
                                // there is nothing to verify AGAINST (a
                                // gap the live tests caught)
                                workItem: toPromptText(item),
                                haltProse,
                                claim:
                                  currentRun.resolved.value === undefined
                                    ? undefined
                                    : toPromptText(currentRun.resolved.value),
                                ringInstructions: checkInstructions,
                              }),
                            ),
                          );
                    if (verdict === undefined) {
                      // check-failed (§9.3): a broken judge NEVER silently
                      // re-loops; the memory kernel parks as a defect (the
                      // ledger makes this a durable park in Phase 3)
                      return yield* Effect.die(
                        new Error(
                          `check-failed: the ${termName} verifier returned an ungradable verdict`,
                        ),
                      );
                    }
                    yield* run.emitRow(
                      run.session,
                      "check.verdict",
                      run.session,
                      `verdict-${iterations}`,
                      { iterations, ...verdict },
                    );
                    if (verdict.verdict === "off-goal") {
                      // the claim is rejected: the resolution is discarded
                      // and the judge's feedback becomes the next
                      // iteration's first input (§2.5 off-goal arm)
                      currentRun = {};
                      rejection = kernelPrompts.rejectionSteer(
                        verdict.reason ?? "no reason given",
                      );
                    }
                  }
                  if (rejection === undefined) {
                    yield* run.emitRow(
                      run.session,
                      "run.resolved",
                      run.session,
                      "resolved",
                      { iterations },
                    );
                    return currentRun.resolved!.value;
                  }
                }
                if (currentRun.refusal !== undefined) {
                  yield* run.emitRow(
                    run.session,
                    "run.refused",
                    run.session,
                    "refused",
                    { iterations, reason: currentRun.refusal },
                  );
                  return yield* Effect.fail(
                    new Refused({
                      loop: termName,
                      reason: currentRun.refusal,
                      observed: 1,
                    }),
                  );
                }

                // ── the §2.5 boundary: ceilings, fold, nag ──
                if (
                  tokenCeiling !== undefined &&
                  cumulativeTokens >= tokenCeiling
                ) {
                  return yield* Effect.fail(
                    new BudgetExceeded({
                      loop: termName,
                      limit: "tokens",
                      budget: budget.tokens!,
                      used: cumulativeTokens,
                      resumeHint: "raise the token budget to resume",
                    }),
                  );
                }
                if (iterations >= maxIterations) {
                  // provided ceiling or the kernel's default guard — both
                  // exhaust as the SAME typed exit (BudgetExceeded is
                  // unconditional in ProcessErr)
                  return yield* Effect.fail(
                    new BudgetExceeded({
                      loop: termName,
                      limit: "iterations",
                      budget: budget.iterations ?? maxIterations,
                      used: iterations,
                      resumeHint: "raise the iteration budget to resume",
                    }),
                  );
                }
                yield* run.emitRow(
                  run.session,
                  "run.iteration",
                  run.session,
                  `iteration-${iterations}`,
                  { iterations, cumulativeTokens },
                );
                // fold = carry the transcript; the boundary input is the
                // judge's rejection when there is one, else the bounded nag
                transcript = state.messages;
                input = toMessages(rejection ?? kernelPrompts.boundaryNag());
              }
            }),
        });
        steerCell.current = service.steer;
        return service;
      });

      // ── deterministic handler path (reassess §C): the same ring, a
      // per-item runItem that calls the user's handler with a
      // ProcessContext instead of running model turns. Steer, interrupt,
      // run.admitted/run.settled all come from makeRing.
      const interpretHandler = Effect.fn(function* (
        term: { "~alchemy/Name": string; refs: unknown[] },
        handler: (
          item: unknown,
          ctx: ProcessContext,
        ) => Effect.Effect<unknown, unknown>,
      ) {
        const termName = term["~alchemy/Name"];
        const policy = yield* KernelPolicy;
        const service = yield* makeRing({
          termName,
          system: "",
          compiled: { toolkit: undefined, handlers: new Map() },
          policy,
          runItem: (item, run) => {
            let ordinal = 0;
            const emit = (type: string, payload?: unknown) => {
              const id = `${run.session}:handler:${ordinal++}`;
              return Effect.asVoid(
                run.emitRow(run.session, type, id, type, payload),
              );
            };
            const ctx: ProcessContext = {
              // typed emit (canon §4 addition 1): one durable
              // `message.emitted` row AND a typed EventBus publication.
              // No staged-commit machinery exists in the memory kernel —
              // the row commits immediately, like every other ctx emit;
              // atomicity with the run's terminal is Phase-3 ledger work.
              emit: ((
                typeOrSource: string | EventSource<any, any, any>,
                payload?: unknown,
              ) =>
                typeof typeOrSource === "string"
                  ? emit(typeOrSource, payload)
                  : // owner gate (canon §2a ruling 4): a world-owned
                    // source has no publish affordance — a process
                    // cannot publish what only the world emits
                    isWorldOwned(typeOrSource)
                    ? Effect.die(
                        new Error(
                          `cannot ctx.emit(${typeOrSource["~alchemy/Name"]}): the source is world-owned — only the world publishes it; a process may observe it (AI.when / AI.until), never publish it`,
                        ),
                      )
                    : Effect.andThen(
                        emit("message.emitted", {
                          source: typeOrSource["~alchemy/Name"],
                          event: payload,
                        }),
                        eventBus.publish(typeOrSource, payload),
                      )) as ProcessContext["emit"],
              post: (author, text) => emit("message.posted", { author, text }),
              run: <A, E, R>(
                agent: string,
                effect: Effect.Effect<A, E, R>,
              ): Effect.Effect<A, E, R> =>
                Effect.gen(function* () {
                  const runId = `${run.session}:child:${ordinal++}`;
                  yield* Effect.asVoid(
                    run.emitRow(
                      run.session,
                      "child.started",
                      runId,
                      "started",
                      { runId, agent },
                    ),
                  );
                  const result = yield* Effect.result(effect);
                  if (Result.isSuccess(result)) {
                    yield* Effect.asVoid(
                      run.emitRow(
                        run.session,
                        "child.completed",
                        runId,
                        "completed",
                        { runId, agent },
                      ),
                    );
                    return result.success;
                  }
                  yield* Effect.asVoid(
                    run.emitRow(run.session, "child.failed", runId, "failed", {
                      runId,
                      agent,
                      error: toPromptText(
                        (result as Result.Failure<A, E>).failure,
                      ),
                    }),
                  );
                  return yield* Effect.fail(
                    (result as Result.Failure<A, E>).failure,
                  );
                }),
            };
            return handler(item, ctx).pipe(
              Effect.tap((value) =>
                emit("run.resolved", {
                  value,
                  deterministic: true,
                }),
              ),
            );
          },
        });
        return service;
      });

      return Kernel.of({
        process: ((term: any, handler: any) =>
          interpretHandler(term, handler)) as KernelService["process"],
        interpret: ((term: any) =>
          isAgent(term)
            ? interpretAgent(term)
            : isProcess(term)
              ? interpretProcess(term)
              : Effect.fail(
                  new KernelError({
                    term: String(term?.["~alchemy/Name"] ?? term),
                    message: "not an interpretable (process) term",
                  }),
                )) as KernelService["interpret"],
        events: store.events,
        trace: (ring, after) => store.trace(ring, after),
      });
    }),
  );

/** A run failure's model/UI-visible description (typed exits keep their tag). */
const describeRunFailure = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  if (typeof squashed === "object" && squashed !== null && "_tag" in squashed) {
    const tagged = squashed as { _tag: string; reason?: unknown };
    return tagged.reason !== undefined
      ? `${tagged._tag}: ${String(tagged.reason)}`
      : tagged._tag;
  }
  return String(squashed);
};

// ─── compilation ─────────────────────────────────────────────────

interface CompiledTools {
  /** The effect/ai toolkit advertised to the model (schemas only). */
  readonly toolkit: unknown;
  /** The kernel's own executor map — the model never runs these. */
  readonly handlers: ReadonlyMap<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown>
  >;
}

const isToolTerm = (ref: unknown): ref is Tool & { new (): any } =>
  (typeof ref === "object" || typeof ref === "function") &&
  ref !== null &&
  (ref as Record<string, unknown>)["~alchemy/Kind"] === "Tool";

const isParam = (ref: unknown): ref is Parameter =>
  (typeof ref === "object" || typeof ref === "function") &&
  ref !== null &&
  (ref as Record<string, unknown>)["~alchemy/Kind"] === "Param";

/**
 * Summarize a delegate's dispatch result for the caller's transcript —
 * the subagent-summary pattern (§2.5 upward channel 1): the caller sees
 * a distilled result, never the delegate's transcript. Abnormal ends
 * surface as model-visible tool failures.
 */
const summarizeDelegation = (
  value: unknown,
): Effect.Effect<unknown, string> => {
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const outcome = value as Step.HaltOutcome;
    switch (outcome._tag) {
      case "Completed":
        return Effect.succeed(outcome.text);
      case "BudgetExceeded":
        return Effect.fail(
          kernelPrompts.delegateBudgetExceeded({
            limit: outcome.limit,
            used: outcome.used,
            budget: outcome.budget,
          }),
        );
      case "Interrupted":
        return Effect.fail(kernelPrompts.delegateInterrupted());
    }
  }
  // a Process delegate resolves with its typed halt value
  return Effect.succeed(value);
};

/** Late-bound access to the host ring's own steer verb (§2.8): the
 * delegation compiler runs before the ring exists, so completion steers
 * route through this cell, wired right after `makeRing` returns. */
interface SteerCell {
  current?: (input: unknown) => Effect.Effect<void, never, never>;
}

/**
 * Extract the judge's verdict from its (agent) dispatch outcome: the
 * first JSON object in the completed text with a recognized `verdict`.
 * `undefined` = ungradable ⇒ check-failed, never a silent re-loop.
 */
const parseVerdict = (outcome: unknown): CheckVerdict | undefined => {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    (outcome as { _tag?: unknown })._tag !== "Completed"
  ) {
    return undefined;
  }
  const match = /\{[\s\S]*\}/.exec((outcome as { text: string }).text);
  if (match === null) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as {
      verdict?: unknown;
      reason?: unknown;
    };
    if (parsed.verdict === "goal-met") return { verdict: "goal-met" };
    if (parsed.verdict === "off-goal") {
      return {
        verdict: "off-goal",
        reason:
          typeof parsed.reason === "string" ? parsed.reason : "no reason given",
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const compileTools = Effect.fn(function* (
  refs: ReadonlyArray<unknown>,
  synthetic?: {
    readonly tools: ReadonlyArray<AiTool.Any>;
    readonly handlers: ReadonlyMap<
      string,
      (params: unknown) => Effect.Effect<unknown, unknown>
    >;
  },
  steerCell?: SteerCell,
  children?: Set<{ readonly cancel: Effect.Effect<void> }>,
) {
  const aiTools: AiTool.Any[] = [...(synthetic?.tools ?? [])];
  const handlers = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown>
  >(synthetic?.handlers ?? []);

  // background-run bookkeeping for this host (§2.8 spawn-and-continue).
  // Forks live in the interpretation Scope: release the host's Layer and
  // pending background dispatches die with the ring.
  const scope = yield* Effect.scope;
  const backgroundRuns = new Map<
    string,
    {
      delegate: string;
      status: "running" | "completed" | "failed";
      summary?: string;
      /** Completed when the run settles — `wait_run`'s park seat. */
      settled: Deferred.Deferred<void>;
    }
  >();
  let spawnOrdinal = 0;
  let hasDelegates = false;

  for (const ref of refs) {
    // ── delegation (§1.5 Stage A / §2.8): an interpolated Agent/Process
    // becomes a tool whose handler is the DELEGATE'S dispatch. The tag
    // resolves the live ProcessService from ambient context — which ring
    // serves it, with which tool physics, is entirely the Layer graph's
    // decision (per-agent physics, shared vs private delegates).
    if (isAgent(ref) || isProcess(ref)) {
      const name = ref["~alchemy/Name"];
      hasDelegates = true;
      const delegate = yield* Effect.serviceOption(ref as never);
      if (Option.isNone(delegate)) {
        return yield* Effect.die(
          new Error(
            `delegate ${name} has no implementation in context — provide AI.layer(${name}) or a custom Layer (Req should have caught this)`,
          ),
        );
      }
      const service = delegate.value as {
        dispatch: (item: unknown) => Effect.Effect<unknown, unknown, never>;
        [internalAdmit]?: (item: unknown) => Effect.Effect<AdmissionHandle>;
      };
      const distill = (raw: Effect.Effect<unknown, unknown>) =>
        raw.pipe(
          Effect.flatMap(summarizeDelegation),
          // typed loop exits (Refused/BudgetExceeded) become
          // model-visible failure text for the caller
          Effect.mapError((error) => String(error)),
        );
      /**
       * Cascade-registered call (§2.8b): admit on the child's ring and
       * register the admission with the HOST's children set for the
       * lifetime of the join — a host interrupt cancels exactly this
       * admission (tombstone if queued, control admission if active).
       */
      const call = (task: unknown): Effect.Effect<unknown, string> => {
        const admitChild = service[internalAdmit];
        if (admitChild === undefined || children === undefined) {
          return distill(service.dispatch(task));
        }
        return Effect.gen(function* () {
          const handle = yield* admitChild(task);
          const entry = { cancel: handle.cancel };
          children.add(entry);
          return yield* distill(handle.await).pipe(
            Effect.ensuring(Effect.sync(() => children.delete(entry))),
          );
        });
      };
      aiTools.push(
        AiTool.make(name, {
          description: kernelPrompts.delegateDescription({
            name,
            charter: renderTemplate(
              (ref as { template: TemplateStringsArray }).template,
              (ref as { refs: unknown[] }).refs,
            ),
          }),
          parameters: S.Struct({
            task: S.String,
            background: S.optionalKey(S.Boolean),
          }) as never,
        }),
      );
      handlers.set(name, (params) => {
        const input = params as
          | { task?: unknown; background?: unknown }
          | undefined;
        const task = input?.task ?? params;

        // sync call (§2.8 pattern 1): admit + join
        if (input?.background !== true) return call(task);

        // spawn-and-continue (§2.8 pattern 3): send now; the settled
        // result arrives at the HOST's next boundary as a steer (or
        // parks for its next run) — the host never polls, never blocks
        return Effect.gen(function* () {
          const runKey = `${name}#bg${spawnOrdinal++}`;
          const settled = yield* Deferred.make<void>();
          backgroundRuns.set(runKey, {
            delegate: name,
            status: "running",
            settled,
          });
          yield* Effect.result(call(task)).pipe(
            Effect.flatMap((result) => {
              const [status, summary] = Result.isSuccess(result)
                ? (["completed", toPromptText(result.success)] as const)
                : ([
                    "failed",
                    toPromptText(
                      (result as Result.Failure<unknown, unknown>).failure,
                    ),
                  ] as const);
              backgroundRuns.set(runKey, {
                delegate: name,
                status,
                summary,
                settled,
              });
              return Effect.andThen(
                Effect.asVoid(Deferred.succeed(settled, void 0)),
                steerCell?.current?.(
                  kernelPrompts.completionSteer({ runKey, status, summary }),
                ) ?? Effect.void,
              );
            }),
            Effect.forkIn(scope),
          );
          return kernelPrompts.spawnAck(runKey);
        });
      });
      continue;
    }

    if (!isToolTerm(ref)) continue;
    const name = ref["~alchemy/Name"];

    // resolve the tool's implementation from the ambient context; the
    // type system already guaranteed presence via the term's Req.
    const impl = yield* Effect.serviceOption(ref as never);
    if (Option.isNone(impl)) {
      return yield* Effect.die(
        new Error(
          `tool ${name} has no implementation in context — its tag must be provided (Req should have caught this)`,
        ),
      );
    }
    // a tool impl is either the callable or an init Effect producing it
    const callable = Effect.isEffect(impl.value)
      ? yield* impl.value as Effect.Effect<
          (params: unknown) => Effect.Effect<unknown, unknown>
        >
      : (impl.value as (params: unknown) => Effect.Effect<unknown, unknown>);
    handlers.set(name, callable);

    const params = ref.refs.filter(isParam);
    aiTools.push(
      AiTool.make(name, {
        description: renderTemplate(ref.template, ref.refs),
        parameters: S.Struct(
          Object.fromEntries(params.map((p) => [p["~alchemy/Name"], p.schema])),
        ) as never,
      }),
    );
  }

  // check-in (§2.8): a pure read over the background-run registry —
  // status is derived from settled state, never a wake. Only compiled
  // when the term can actually delegate.
  if (hasDelegates) {
    aiTools.push(
      AiTool.make("check_runs", {
        description: kernelPrompts.checkRunsDescription(),
        parameters: S.Struct({ reason: S.optionalKey(S.String) }) as never,
      }),
    );
    handlers.set("check_runs", () =>
      Effect.sync(() =>
        backgroundRuns.size === 0
          ? "no background runs"
          : [...backgroundRuns.entries()]
              .map(
                ([key, run]) =>
                  `${key} [${run.delegate}] ${run.status}` +
                  (run.summary === undefined ? "" : `: ${run.summary}`),
              )
              .join("\n"),
      ),
    );

    // join (§2.8c): park until the correlated run settles — the same
    // shape as waiting on a human (the park is an in-flight tool
    // execution, raced by the interrupt signal like any other)
    aiTools.push(
      AiTool.make("wait_run", {
        description: kernelPrompts.waitRunDescription(),
        parameters: S.Struct({ key: S.String }) as never,
      }),
    );
    handlers.set("wait_run", (params) =>
      Effect.suspend(() => {
        const key = (params as { key?: unknown } | undefined)?.key;
        const run =
          typeof key === "string" ? backgroundRuns.get(key) : undefined;
        if (run === undefined) {
          return Effect.fail(
            `no background run with key ${JSON.stringify(key)} — see check_runs`,
          );
        }
        return Deferred.await(run.settled).pipe(
          Effect.flatMap(() => {
            const latest = backgroundRuns.get(key as string)!;
            return latest.status === "completed"
              ? Effect.succeed(latest.summary ?? "completed")
              : Effect.fail(latest.summary ?? "the run failed");
          }),
        );
      }),
    );
  }

  // effect/ai wants a WithHandler; with disableToolCallResolution the
  // handlers are never invoked, so stubs satisfy the shape honestly.
  const toolkit = Toolkit.make(...aiTools);
  const stubs = Object.fromEntries(
    [...handlers.keys()].map((name) => [
      name,
      () => Effect.die(new Error("unreachable: the kernel executes tools")),
    ]),
  );
  const withHandler = yield* (
    toolkit as Effect.Effect<unknown, never, any>
  ).pipe(Effect.provide(toolkit.toLayer(stubs as never) as Layer.Layer<any>));

  return { toolkit: withHandler, handlers } satisfies CompiledTools;
});

const toMessages = (item: unknown): ReadonlyArray<Prompt.Message> => {
  if (typeof item === "string") {
    return [
      Prompt.makeMessage("user", {
        content: [Prompt.makePart("text", { text: item })],
      }),
    ];
  }
  if (Array.isArray(item)) return item as ReadonlyArray<Prompt.Message>;
  return [
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text: JSON.stringify(item) })],
    }),
  ];
};
