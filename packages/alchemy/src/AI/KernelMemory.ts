import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Context from "effect/Context";
import { isAgent } from "./Agent.ts";
import { KernelError } from "./Errors.ts";
import { eventId } from "./Ids.ts";
import { Kernel, type KernelService } from "./Kernel.ts";
import type { Parameter } from "./Parameter.ts";
import { renderTemplate } from "./Render.ts";
import * as Step from "./Step.ts";
import type { Tool } from "./Tool.ts";
import { makeMemoryTraceStore, TraceStore } from "./TraceStore.ts";

/**
 * The in-memory reference Kernel (design §2.6) — the smallest honest
 * implementation of the interpretation pipeline (§1.5 → §2.4):
 *
 * 1. **Compile** — walk the agent term's refs; each `Tool<Self>` tag is
 *    resolved from the *ambient context* (which is why `interpret`
 *    carries the term's `Req`), its parameters become an `effect/ai`
 *    tool schema, and its rendered template becomes the description.
 2. **Drive** — interpretation forks the term's **ring** (`forkScoped`,
 *    lifetime = the interpretation Scope): one serial loop draining one
 *    admission mailbox. `dispatch` = admit + join a reply seat; `send` =
 *    admit alone. Inside a turn the {@link Step} machine owns control;
 *    this kernel is just its command interpreter.
 *    `disableToolCallResolution: true` is load-bearing (§9.3):
 *    `effect/ai` never executes tools, the kernel does, so every
 *    settlement passes through the step machine's
 *    transcript/pairing/ceiling discipline.
 * 3. **Settle** — tool failures are model-visible results, never thrown
 *    (`Err = never` is a theorem); harness failures (`AiError`) are
 *    defects.
 *
 * 4. **Persist** — every external effect is preceded by a durable Trace
 *    row (§2.7 write-ahead: `model.requested` before the wire call,
 *    `tool.requested` before execution, terminals after) committed
 *    through the {@link TraceStore} seam — resolved via
 *    `Effect.serviceOption` with the in-memory store as the internal
 *    default (the §2.6 seam pattern), so `kernel.events` / `kernel.trace`
 *    are real streams and a different backend is one Layer away.
 *
 * Deliberately absent (later build-order steps): the loop runtime
 * (trigger/halt/fold/check refs), steering across fibers, the StepState
 * stash (recovery), and budget accounting off usage. `dispatch` resolves
 * with the turn's {@link Step.HaltOutcome} until the kernel `Message`
 * type lands.
 */
/**
 * The kernel-default agent policy — the execution ring's ceilings
 * (§8.2: control parameters of the innermost ring are kernel lore, never
 * charter prose). A `Context.Reference`: it has a default, so providing
 * it is optional — `Layer.succeed(KernelPolicy, { … })` tightens the
 * ceilings for a deployment or a test. Loop-charter `AI.budget` refs
 * will *narrow* these, never widen them.
 */
export const KernelPolicy = Context.Reference<{
  readonly maxModelCalls: number;
  /** Token ceiling per turn; unlimited when absent. */
  readonly maxTokens?: number;
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

      const interpretAgent = Effect.fn(function* (term: {
        "~alchemy/Name": string;
        template: TemplateStringsArray;
        refs: unknown[];
      }) {
        const termName = term["~alchemy/Name"];
        const system = renderTemplate(term.template, term.refs);
        const compiled = yield* compileTools(term.refs);
        // ceilings from the ambient policy (a Reference: defaults apply
        // when no Layer provides it)
        const policy = yield* KernelPolicy;

        const turn = Effect.fn(function* (item: unknown) {
          const session = `${termName}#${oneShot++}`;
          // durable Trace rows for this ring (§2.7): deterministic ids,
          // seq assigned by the store inside the commit
          const emit = (
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
          let state = Step.initialState({ session, ...policy });
          const inbox: Step.Feedback[] = [
            { _tag: "Dispatched", input: toMessages(item) },
          ];

          while (true) {
            const feedback = inbox.shift();
            if (feedback === undefined) {
              return yield* Effect.die(
                new Error(`step machine stalled without halting (${session})`),
              );
            }
            const [next, commands] = Step.step(state, feedback);
            state = next;

            for (const command of commands) {
              switch (command._tag) {
                case "CallModel": {
                  // write-ahead: the intent row is durable BEFORE the wire call
                  yield* emit("model.requested", command.id, "request");
                  const response = yield* model
                    .generateText({
                      prompt: Prompt.fromMessages([
                        Prompt.makeMessage("system", { content: system }),
                        ...command.messages,
                      ]),
                      toolkit: compiled.toolkit as never,
                      disableToolCallResolution: true,
                    })
                    // harness failure, not an agent error (Err = never)
                    .pipe(Effect.orDie);
                  const toolCalls = (
                    response.toolCalls as ReadonlyArray<{
                      id: string;
                      name: string;
                      params: unknown;
                    }>
                  ).map((part) => ({
                    callId: part.id,
                    name: part.name,
                    params: part.params,
                  }));
                  yield* emit("model.completed", command.id, "response", {
                    finishReason: response.finishReason,
                    usage: response.usage,
                    toolCalls: toolCalls.map((call) => call.callId),
                  });
                  inbox.push({
                    _tag: "ModelResponse",
                    commandId: command.id,
                    outcome: {
                      text: response.text,
                      toolCalls,
                      finishReason: response.finishReason,
                      tokens: usageTokens(response.usage),
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
                      : // model-visible failure text, never a thrown error
                        String(
                          (settled as Result.Failure<unknown, unknown>).failure,
                        ),
                  });
                  break;
                }
                case "Halt":
                  yield* emit("turn.halted", command.id, "halt", {
                    outcome: command.outcome._tag,
                  });
                  return command.outcome;
              }
            }
          }
        });

        // The ring: ONE serial loop per process term, started when the
        // Layer is built (forkScoped ties its lifetime to the interpretation
        // Scope — release the Layer, the ring dies). `send` and `dispatch`
        // are both admissions into the same mailbox; a turn never runs
        // outside the ring, so single-writer discipline holds by
        // construction. This is the local analogue of the Durable Object
        // kernel, where the mailbox is the admission ledger and the wake is
        // an alarm instead of Queue.take.
        interface Admission {
          readonly item: unknown;
          /** Present iff a dispatcher is joined on the outcome. */
          readonly reply?: Deferred.Deferred<Step.HaltOutcome>;
        }
        const mailbox = yield* Queue.unbounded<Admission>();
        const ring = yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(Queue.take(mailbox), (admission) =>
              Effect.flatMap(Effect.exit(turn(admission.item)), (exit) =>
                admission.reply !== undefined
                  ? Deferred.done(admission.reply, exit)
                  : Exit.isFailure(exit)
                    ? Effect.logWarning(
                        "memory kernel: unobserved turn failed",
                        exit.cause,
                      )
                    : Effect.void,
              ),
            ),
          ),
        );

        const todo = (what: string) =>
          Effect.die(
            new Error(`memory kernel: ${what} lands with the loop runtime`),
          );

        return {
          // dispatch = send + join: same admission path, plus a reply seat
          dispatch: (item: unknown) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<Step.HaltOutcome>();
              yield* Queue.offer(mailbox, { item, reply });
              return yield* Deferred.await(reply);
            }),
          // send = the admission half alone (fire-and-forget)
          send: (item: unknown) =>
            Effect.asVoid(Queue.offer(mailbox, { item })),
          // the ring is already serving; run joins its (unbounded) life
          run: () => Fiber.join(ring),
          steer: () => todo("steer"),
          interrupt: () => todo("interrupt"),
        };
      });

      return Kernel.of({
        interpret: ((term: any) =>
          isAgent(term)
            ? interpretAgent(term)
            : Effect.fail(
                new KernelError({
                  term: String(term?.["~alchemy/Name"] ?? term),
                  message:
                    "memory kernel interprets Agent terms only (loop runtime is a later build-order step)",
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

const compileTools = Effect.fn(function* (refs: ReadonlyArray<unknown>) {
  const aiTools: AiTool.Any[] = [];
  const handlers = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown>
  >();

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
