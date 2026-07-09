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
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import type * as Response from "effect/unstable/ai/Response";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { isAgent } from "./Agent.ts";
import { type Budget, isBudget } from "./Budget.ts";
import { BudgetExceeded, KernelError, Refused } from "./Errors.ts";
import { type Halt, isHalt } from "./Halt.ts";
import { eventId } from "./Ids.ts";
import { Kernel, type KernelService } from "./Kernel.ts";
import { isLoop } from "./Loop.ts";
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
 *    A Loop charter's `AI.until` additionally compiles to **halt-as-tool**
 *    (§2.5): synthetic `resolve` (input schema = the halt schema) and
 *    `give_up` tools the kernel owns.
 * 2. **Drive** — interpretation forks the term's **ring** (`forkScoped`,
 *    lifetime = the interpretation Scope): one serial loop draining one
 *    admission mailbox. `dispatch` = admit + join a reply seat; `send` =
 *    admit alone. An Agent run is ONE step-machine turn; a Loop run
 *    **iterates** turns per work item — same machine, same ring, with
 *    the boundary between iterations doing the §2.5 work (steer drain
 *    via the park, ceilings, fold = carry the transcript, nag when the
 *    model stops without resolving). `disableToolCallResolution: true`
 *    is load-bearing (§9.3): `effect/ai` never executes tools.
 * 3. **Settle** — tool failures are model-visible results, never thrown
 *    (`Err = never` on agents is a theorem); a Loop's typed exits are
 *    `Refused` (ratified give-up) and `BudgetExceeded` (charter budget);
 *    harness failures are defects.
 * 4. **Persist** — every external effect is preceded by a durable Trace
 *    row (§2.7 write-ahead) through the {@link TraceStore} seam.
 *
 * Deliberately absent (later build-order steps): trigger streams feeding
 * `run()` (EventSource channels), `AI.check`/`AI.fold` agents at the
 * boundary (the defaults apply: no check, transcript-carry fold), the
 * StepState stash (recovery), and N-consecutive `Refused` ratification
 * (a single evidence-bearing give_up refuses). Perpetual charters
 * (`AI.never` / no halt) are rejected until the trigger runtime lands.
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
      let oneShot = 0;

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
        /** Serve one work item; a Loop's typed exits ride the error channel. */
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
          },
        ) => Effect.Effect<unknown, unknown>;
      }) {
        const { termName, system, compiled, policy } = options;

        // Steering (§2.4/§9.3): a steer is an admission, never an
        // interruption. Mid-turn it lands in the ACTIVE turn's feedback
        // inbox as `Steered`; between turns it parks here and enters the
        // next turn ahead of its Dispatched (round-1 promotion). For a
        // Loop this IS the §2.5 boundary drain: parked steers enter the
        // next iteration's first round. Single-threaded mutation is safe.
        const parkedSteers: Prompt.Message[] = [];
        let activeInbox: Step.Feedback[] | undefined;
        // set by interrupt(): un-started commands of the current batch
        // are abandoned (the machine settles them as aborted results);
        // in-flight I/O is never fiber-killed
        let interruptRequested = false;

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
                    yield* model
                      .streamText({
                        prompt: Prompt.fromMessages([
                          Prompt.makeMessage("system", { content: system }),
                          ...command.messages,
                        ]),
                        toolkit: compiled.toolkit as never,
                        disableToolCallResolution: true,
                      })
                      .pipe(
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
                        // harness failure, not an agent error
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
                    // write-ahead: intent before execution (§2.7)
                    yield* emit("tool.requested", command.id, "request", {
                      callId: command.callId,
                      name: command.name,
                    });
                    const handler = compiled.handlers.get(command.name);
                    const settled = handler
                      ? yield* Effect.result(handler(command.params))
                      : Result.fail(`no such tool: ${command.name}`);
                    const isFailure = Result.isFailure(settled);
                    yield* emit(
                      isFailure ? "tool.failed" : "tool.completed",
                      command.id,
                      "result",
                      { callId: command.callId, name: command.name },
                    );
                    inbox.push({
                      _tag: "ToolSettled",
                      callId: command.callId,
                      isFailure,
                      result: Result.isSuccess(settled)
                        ? settled.success
                        : // model-visible failure text, never thrown
                          String(
                            (settled as Result.Failure<unknown, unknown>)
                              .failure,
                          ),
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
          /** Present iff a dispatcher is joined on the outcome. */
          readonly reply?: Deferred.Deferred<unknown, unknown>;
        }
        const mailbox = yield* Queue.unbounded<Admission>();
        const ring = yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(Queue.take(mailbox), (admission) =>
              Effect.flatMap(
                Effect.exit(
                  options.runItem(admission.item, {
                    session: `${termName}#${oneShot++}`,
                    runTurn,
                    emitRow,
                  }),
                ),
                (exit) =>
                  admission.reply !== undefined
                    ? Deferred.done(admission.reply, exit)
                    : Exit.isFailure(exit)
                      ? Effect.logWarning(
                          "memory kernel: unobserved run failed",
                          exit.cause,
                        )
                      : Effect.void,
              ),
            ),
          ),
        );

        return {
          // dispatch = send + join: same admission path, plus a reply seat
          dispatch: (item: unknown) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<unknown, unknown>();
              yield* Queue.offer(mailbox, { item, reply });
              return yield* Deferred.await(reply);
            }),
          // send = the admission half alone (fire-and-forget)
          send: (item: unknown) =>
            Effect.asVoid(Queue.offer(mailbox, { item })),
          // the ring is already serving; run joins its (unbounded) life
          run: () => Fiber.join(ring),
          // steer = mid-run admission: into the active turn's feedback
          // inbox (promoted at its next boundary), or parked for the
          // next turn's/iteration's round 1 when nothing is active
          steer: (input: unknown) =>
            Effect.sync(() => {
              const messages = toMessages(input);
              if (activeInbox !== undefined) {
                activeInbox.push({ _tag: "Steered", messages });
              } else {
                parkedSteers.push(...messages);
              }
            }),
          // interrupt = Scope authority as a control admission (§0.6):
          // never a fiber kill. The active turn settles its in-flight
          // batch and halts as Interrupted; idle rings have nothing to
          // interrupt.
          interrupt: () =>
            Effect.sync(() => {
              if (activeInbox !== undefined) {
                interruptRequested = true;
                activeInbox.push({ _tag: "Interrupt" });
              }
            }),
        };
      });

      // ── Agent: a run is ONE turn at kernel-default control parameters ──

      const interpretAgent = Effect.fn(function* (term: {
        "~alchemy/Name": string;
        template: TemplateStringsArray;
        refs: unknown[];
      }) {
        const policy = yield* KernelPolicy;
        const compiled = yield* compileTools(term.refs);
        return yield* makeRing({
          termName: term["~alchemy/Name"],
          system: renderTemplate(term.template, term.refs),
          compiled,
          policy,
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
      });

      // ── Loop: a run ITERATES turns per work item (§2.5) ──────────────

      const interpretLoop = Effect.fn(function* (term: {
        "~alchemy/Name": string;
        template: TemplateStringsArray;
        refs: unknown[];
      }) {
        const termName = term["~alchemy/Name"];
        const halt = term.refs.find(isHalt) as Halt | undefined;
        if (halt === undefined || halt.mode !== "until") {
          return yield* Effect.fail(
            new KernelError({
              term: termName,
              message:
                "the memory kernel runs bounded loops only (AI.until) — perpetual rings land with the trigger runtime",
            }),
          );
        }
        const budget = (term.refs.find(isBudget) as Budget | undefined)?.limits;
        const policy = yield* KernelPolicy;

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
            description:
              "Call when the halt condition is met. This ends the run" +
              (haltSchema !== undefined
                ? ". `value` is the run's result as a JSON-encoded string" +
                  " matching the halt condition's shape."
                : "."),
            parameters: (haltSchema !== undefined
              ? S.Struct({ value: S.String })
              : S.Struct({})) as never,
          }),
          AiTool.make("give_up", {
            description:
              "Call ONLY when you have concrete evidence the goal is " +
              "unachievable. `reason` must state the blocker and the evidence.",
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
                return Effect.succeed("resolved: the run will halt");
              }
              const raw = (params as { value?: unknown } | undefined)?.value;
              let parsed: unknown;
              try {
                parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
              } catch (error) {
                return Effect.fail(
                  `resolve rejected — value is not valid JSON: ${String(error)}`,
                );
              }
              const decoded = S.decodeUnknownResult(haltSchema as never)(
                parsed,
              );
              if (Result.isFailure(decoded)) {
                // model-visible bounce: self-correct and resolve again
                return Effect.fail(
                  `resolve rejected — value does not match the halt schema: ${String(decoded.failure)}`,
                );
              }
              currentRun.resolved = { value: decoded.success };
              return Effect.succeed("resolved: the run will halt");
            },
          ],
          [
            "give_up",
            (params) => {
              currentRun.refusal = String(
                (params as { reason?: unknown } | undefined)?.reason ??
                  "no reason given",
              );
              return Effect.succeed("acknowledged: the run will refuse");
            },
          ],
        ]);

        const compiled = yield* compileTools(term.refs, {
          tools: syntheticTools,
          handlers: syntheticHandlers,
        });

        const system =
          renderTemplate(term.template, term.refs) +
          "\n\n# Halt condition\n" +
          `This run ends when: ${renderTemplate(halt.template, halt.refs)}\n` +
          "When that condition is met, call the `resolve` tool" +
          (haltSchema !== undefined ? " with the result value" : "") +
          ". If you conclude the goal is unachievable, call `give_up` " +
          "with your evidence. Keep working until you call one of them.";

        const maxIterations = budget?.iterations ?? policy.maxIterations ?? 24;
        const tokenCeiling =
          budget?.tokens !== undefined
            ? parseTokenBudget(budget.tokens)
            : undefined;

        const service = yield* makeRing({
          termName,
          system,
          compiled,
          policy,
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
                  input,
                });
                cumulativeTokens += state.tokensUsed;

                // a turn-level harness ceiling inside a budgeted loop is
                // the loop's typed exit; without a budget it is a defect
                if (outcome._tag === "BudgetExceeded") {
                  if (budget === undefined) {
                    return yield* Effect.die(
                      new Error(
                        `loop ${termName} hit the per-turn harness ceiling (${outcome.limit}) without a charter budget`,
                      ),
                    );
                  }
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

                // resolution first: an achieved goal trumps a give-up
                if (currentRun.resolved !== undefined) {
                  yield* run.emitRow(
                    run.session,
                    "run.resolved",
                    run.session,
                    "resolved",
                    { iterations },
                  );
                  return currentRun.resolved.value;
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
                      budget: budget!.tokens!,
                      used: cumulativeTokens,
                      resumeHint: "raise the token budget to resume",
                    }),
                  );
                }
                if (iterations >= maxIterations) {
                  if (budget?.iterations === undefined) {
                    return yield* Effect.die(
                      new Error(
                        `loop ${termName} exceeded the kernel's default iteration guard (${maxIterations}) without a charter budget`,
                      ),
                    );
                  }
                  return yield* Effect.fail(
                    new BudgetExceeded({
                      loop: termName,
                      limit: "iterations",
                      budget: budget.iterations,
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
                // fold = carry the transcript; nag = the bounded reminder
                transcript = state.messages;
                input = toMessages(
                  "The run has not ended: the halt condition is not met and " +
                    "you have not given up. Continue working. When done, call " +
                    "`resolve`; if truly blocked, call `give_up` with evidence.",
                );
              }
            }),
        });
        return service;
      });

      return Kernel.of({
        interpret: ((term: any) =>
          isAgent(term)
            ? interpretAgent(term)
            : isLoop(term)
              ? interpretLoop(term)
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

const compileTools = Effect.fn(function* (
  refs: ReadonlyArray<unknown>,
  synthetic?: {
    readonly tools: ReadonlyArray<AiTool.Any>;
    readonly handlers: ReadonlyMap<
      string,
      (params: unknown) => Effect.Effect<unknown, unknown>
    >;
  },
) {
  const aiTools: AiTool.Any[] = [...(synthetic?.tools ?? [])];
  const handlers = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown>
  >(synthetic?.handlers ?? []);

  for (const ref of refs) {
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
