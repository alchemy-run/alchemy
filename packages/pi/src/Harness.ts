import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  Harness as PiHarness,
  type Agent,
  type AgentChange,
  type ConversationId,
  type EntryId,
  type SubmissionId,
  type ContextView,
  type Conversation as PiConversation,
  type ConversationView,
  type ConversationWindow,
  type EntryRecord,
  type HarnessInspection,
  type HarnessSettings,
  type SettledSubmissionRecord,
  type Submission as PiSubmission,
  type SubmissionRecord,
  type ToolRegistration,
  type Tx,
  type Wake,
} from "@earendil-works/pi-durable";
import * as Alchemy from "alchemy";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import { LanguageModel } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { EnvHost } from "./Env.ts";
import { ConversationNotFound, NotOnHarness, PiError } from "./Errors.ts";
import { fromPi, messageOf } from "./internal/promise.ts";
import { makeProvider } from "./internal/provider.ts";
import type { AnyModel, ModelService } from "./Model.ts";
import { Storage } from "./Storage.ts";
import {
  flattenTools,
  toRegistration,
  type AnyTool,
  type RunTool,
  type ToolRef,
  type ToolRequirements,
} from "./Tool.ts";

/** Names conversations by a key you choose; Pi's own ids are generated. */
const ConversationNames = defineDoc<{ names: Record<string, number> }>({
  scope: "session",
  kind: "alchemy.conversation-names",
  version: 1,
  initial: () => ({ names: {} }),
  checkpointWhen: () => false,
});

/** Options of {@link Harness}. */
export interface HarnessOptions<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<AnyTool>,
> {
  /**
   * Distinguishes several harnesses in one Durable Object: each keeps its
   * tables under its own prefix.
   * @default "pi"
   */
  readonly name?: string;
  /** Every model a conversation may run on. The first is the default. */
  readonly models: Models;
  /** Every tool a conversation may be given. */
  readonly tools?: Tools;
  /** Pi's run policy: retries, compaction, tool execution, queue modes. */
  readonly settings?: Omit<HarnessSettings, "extensions">;
}

/** What a conversation runs with. Unset fields keep their current value; `null` restores the harness default. */
export interface AgentOptions {
  readonly model?: AnyModel | null;
  readonly thinkingLevel?: ModelThinkingLevel | null;
  /**
   * The tools the conversation may use: exactly these, or `add`/`remove`
   * relative to what it has now.
   */
  readonly tools?:
    | ReadonlyArray<ToolRef>
    | { readonly add?: ReadonlyArray<ToolRef>; readonly remove?: ReadonlyArray<ToolRef> }
    | null;
  /** Rendered after every other system prompt section. */
  readonly instructions?: string | null;
  /** The working directory tools start in. */
  readonly cwd?: string | null;
  /** Tool rounds one run may take before it ends unanswered. */
  readonly maxTurns?: number | null;
}

/** A submission: an input, a passive write, or a continue. */
export type SubmissionDraft =
  | {
      readonly type: "input";
      readonly content: string;
      /** Makes the submission exactly-once: a retry returns the original. */
      readonly requestId?: string;
      /** While a run is going: join it (`steer`), queue after it (`followUp`), or refuse. */
      readonly whenBusy?: "steer" | "followUp" | "reject";
      /** Refuse when no run is going, so the input never starts one. */
      readonly whenIdle?: "reject";
    }
  | { readonly type: "continue"; readonly requestId?: string };

/** One admitted submission. */
export interface Submission {
  readonly id: SubmissionId;
  /** Resolves when the input is answered (`done`) or fails (`unanswered`). */
  readonly wait: Effect.Effect<SettledSubmissionRecord, PiError, RuntimeContext>;
  readonly status: Effect.Effect<SubmissionRecord, PiError, RuntimeContext>;
  /** Withdraw it while it is still queued. */
  readonly abort: Effect.Effect<"aborted" | "already_placed" | "settled", PiError, RuntimeContext>;
}

/** One conversation: a transcript and the agent it runs with. */
export interface Conversation {
  readonly id: ConversationId;
  /** What the conversation runs with, resolved against the harness. */
  readonly agent: Effect.Effect<Agent, PiError, RuntimeContext>;
  /** Change what it runs with, from the next model request. */
  readonly configure: (
    options: AgentOptions,
  ) => Effect.Effect<void, PiError | NotOnHarness, RuntimeContext>;
  readonly submit: (draft: SubmissionDraft) => Effect.Effect<Submission, PiError, RuntimeContext>;
  /** Start a new context; older entries stay in storage. A handoff note becomes its first message. */
  readonly reset: (handoff?: string) => Effect.Effect<void, PiError, RuntimeContext>;
  readonly compact: (instructions?: string) => Effect.Effect<void, PiError, RuntimeContext>;
  /** Stop: withdraw queued inputs, abort running work, wait until idle. */
  readonly abort: (options?: {
    readonly background?: boolean;
  }) => Effect.Effect<void, PiError, RuntimeContext>;
  readonly waitForIdle: Effect.Effect<void, PiError, RuntimeContext>;
  /** A new conversation that sees this one's entries up to `entryId`. */
  readonly fork: (
    entryId: EntryId,
    options?: AgentOptions & { readonly name?: string },
  ) => Effect.Effect<Conversation, PiError | NotOnHarness, RuntimeContext>;
  /** The entries the model sees next, and their messages. */
  readonly context: Effect.Effect<ContextView, PiError, RuntimeContext>;
  readonly entries: (options?: {
    readonly limit?: number;
    readonly order?: "ascending" | "descending";
  }) => Effect.Effect<ReadonlyArray<EntryRecord>, PiError, RuntimeContext>;
  /** The conversation's live view: the newest entries, the running generation, the inbox. */
  readonly watch: (
    window?: ConversationWindow,
  ) => Stream.Stream<ConversationView, PiError, RuntimeContext>;
  /** Pi's own handle, for what this view doesn't cover. */
  readonly raw: Effect.Effect<PiConversation, PiError, RuntimeContext>;
}

/** A harness: conversations, the models and tools they may use, and their storage. */
export interface Harness {
  /**
   * Create a conversation. With a `name`, creating it again returns the
   * existing one unchanged, so a retried call is harmless.
   */
  readonly createConversation: (
    options?: AgentOptions & { readonly name?: string },
  ) => Effect.Effect<Conversation, PiError | NotOnHarness, RuntimeContext>;
  readonly conversationByName: (
    name: string,
  ) => Effect.Effect<Conversation, PiError | ConversationNotFound, RuntimeContext>;
  readonly conversation: (
    id: ConversationId,
  ) => Effect.Effect<Conversation | undefined, PiError, RuntimeContext>;
  /** Pi's reserved root conversation, created on first use. */
  readonly root: (
    options?: AgentOptions,
  ) => Effect.Effect<Conversation, PiError | NotOnHarness, RuntimeContext>;
  /** Every named conversation: name → id. */
  readonly listConversations: Effect.Effect<
    Readonly<Record<string, ConversationId>>,
    PiError,
    RuntimeContext
  >;
  readonly usage: Effect.Effect<unknown, PiError, RuntimeContext>;
  readonly inspect: Effect.Effect<HarnessInspection, PiError, RuntimeContext>;
  /** Resolve once no conversation has work in progress. */
  readonly waitForIdle: Effect.Effect<void, PiError, RuntimeContext>;
  /** Pi's harness, for what this view doesn't cover. */
  readonly raw: Effect.Effect<PiHarness, PiError, RuntimeContext>;
}

type ModelServices<Models extends ReadonlyArray<AnyModel>> = Models[number] extends infer M
  ? M extends Context.Key<infer I, any>
    ? I
    : never
  : never;

/** How long one alarm keeps working before it hands off to the next. */
const ALARM_SLICE = "10 minutes";
/** How soon a pending wake is due while work is active. */
const HEARTBEAT = "30 seconds";

/**
 * A Pi Durable harness. Yield it where the runtime's dependencies are
 * resolved (a Durable Object's outer Effect): the models, tools and
 * storage it needs are Layers provided there, and the bindings its tools
 * declare are known at plan time. Each instance opens its own harness
 * lazily, on the first call.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * export default class Session extends Cloudflare.DurableObject<Session>()(
 *   "Session",
 *   Effect.gen(function* () {
 *     const harness = yield* Pi.Harness({ models: [Smart], tools: [Pi.CodingTools, RunTests] });
 *     return Effect.gen(function* () {
 *       return {
 *         prompt: Effect.fn(function* (name: string, text: string) {
 *           const conversation = yield* harness.conversationByName(name);
 *           const submission = yield* conversation.submit({ type: "input", content: text });
 *           return yield* submission.wait;
 *         }),
 *       };
 *     });
 *   }).pipe(Effect.provide(HarnessLive)),
 * ) {}
 * ```
 */
export const Harness = <
  const Models extends ReadonlyArray<AnyModel>,
  const Tools extends ReadonlyArray<AnyTool> = readonly [],
>(
  options: HarnessOptions<Models, Tools>,
): Effect.Effect<
  Harness,
  never,
  Storage | EnvHost | ModelServices<Models> | ToolRequirements<Tools[number]>
> =>
  Effect.gen(function* () {
    const prefix = `${options.name ?? "pi"}_`;
    const storage = yield* (yield* Storage).instance;
    const envHost = yield* EnvHost;

    // Resolve every model and tool implementation here, where their Layers
    // (and the bindings those declare) are provided.
    const models = yield* Effect.forEach(options.models, (model) =>
      Effect.map(Effect.service(model as Context.Key<unknown, ModelService>), (languageModel) => ({
        model,
        languageModel,
      })),
    );
    const tools = yield* Effect.forEach(flattenTools(options.tools ?? []), (tool) => {
      switch (tool["~alchemy/Pi/Tool" as keyof typeof tool] as string) {
        case "builtin":
          return Effect.succeed({ tool, handler: undefined });
        case "inline":
          return Effect.succeed({ tool, handler: (tool as { handler: any }).handler });
        default: {
          const cls = tool as unknown as { impl?: Effect.Effect<any> } & Context.Key<unknown, any>;
          return Effect.map(cls.impl ?? Effect.service(cls), (handler) => ({ tool, handler }));
        }
      }
    });
    const captured = yield* Effect.context<never>();

    let opened: Promise<PiHarness> | undefined;
    let wake: Alchemy.Callback<{}> | undefined;
    // Waiters for Pi to report that nothing can run now (idle, or asleep
    // until `at`): an alarm works until then and re-arms for `at`.
    const settled = new Set<() => void>();
    const onWake = (next: Wake) => {
      if (next.active) return;
      for (const resolve of settled) resolve();
      settled.clear();
    };
    const untilSettled = (harness: PiHarness) =>
      Effect.callback<void>((resume) => {
        if (!harness.wake().active) return resume(Effect.void);
        const done = () => resume(Effect.void);
        settled.add(done);
        return Effect.sync(() => void settled.delete(done));
      });

    const toolByName = new Map(tools.map(({ tool }) => [tool.toolName, tool]));
    const modelName = (model: AnyModel) => model.modelName;

    const open = Effect.gen(function* () {
      if (opened === undefined) {
        // Run tools and models with what the harness was yielded with, plus
        // this instance's runtime context (never a call's Scope).
        const call = yield* Effect.context<RuntimeContext>();
        const base = Context.merge(captured, call).pipe(
          Context.omit(Scope.Scope),
        ) as Context.Context<RuntimeContext>;
        const runModel = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal | undefined) =>
          Effect.runPromiseExit(
            Effect.provideContext(effect, base),
            signal ? { signal } : undefined,
          );
        const runTool: RunTool = (effect, services, signal) =>
          Effect.runPromiseExit(
            Effect.scoped(
              Effect.provideContext(effect, Context.merge(base, services) as Context.Context<any>),
            ),
            signal ? { signal } : undefined,
          ) as never;

        // Each model's Layer is built once per instance, with the instance's
        // runtime context. Its scope is never closed: workerd has no
        // instance teardown, and a model client holds nothing to release.
        const buildModels = Effect.gen(function* () {
          const scope = yield* Scope.make();
          const piModels = createModels();
          for (const { model, languageModel } of models) {
            const built = yield* Layer.buildWithScope(languageModel.languageModel, scope).pipe(
              Effect.mapError(
                (cause) =>
                  new PiError({ message: `Model ${model.modelName}: ${messageOf(cause)}`, cause }),
              ),
            );
            piModels.setProvider(
              makeProvider(
                model.modelName,
                Context.get(built, LanguageModel.LanguageModel),
                runModel,
                model.options,
              ),
            );
          }
          return piModels;
        }).pipe(Effect.provideContext(base));
        const registrations: ToolRegistration[] = tools.map(({ tool, handler }) =>
          handler === undefined
            ? (tool as { registration: ToolRegistration }).registration
            : toRegistration(tool.toolName, (tool as { spec: any }).spec, handler, runTool),
        );
        const registry = createRegistry();
        registry.install({ name: "alchemy", tools: registrations });

        opened = Effect.runPromise(
          Effect.all([buildModels, storage.open(prefix)]).pipe(
            Effect.flatMap(([piModels, piStorage]) =>
              fromPi((context) =>
                PiHarness.open(
                  piStorage,
                  {
                    models: piModels,
                    registry,
                    settings: {
                      ...options.settings,
                      extensions: undefined,
                    },
                    env: (target) =>
                      Effect.runPromise(
                        Effect.provideContext(envHost.make(target), base).pipe(
                          Effect.catch((error) => Effect.die(new Error(error.message))),
                        ),
                      ),
                    // With `onWake`, Pi arms no timers of its own: the
                    // instance's alarm wakes it (see `arm`).
                    ...(storage.evictable ? { onWake } : {}),
                  },
                  context,
                ),
              ),
            ),
          ),
        );
        // A long-lived process resumes once, when it opens.
        if (!storage.evictable) void opened.then((harness) => harness.resume());
      }
      return yield* Effect.tryPromise({
        try: () => opened!,
        catch: (cause) => new PiError({ message: messageOf(cause), cause }),
      }).pipe(Effect.tapError(() => Effect.sync(() => (opened = undefined))));
    });

    /** Keep the instance's alarm armed for Pi's pending work. */
    const arm = (harness: PiHarness) =>
      wake === undefined
        ? Effect.void
        : Effect.gen(function* () {
            const next: Wake = harness.wake();
            if (next.active) {
              yield* wake!.schedule("wake", { after: 0, payload: {}, progress: Date.now() });
            } else if (next.at !== undefined) {
              yield* wake!.schedule("wake", { at: next.at, payload: {}, progress: Date.now() });
            }
          }).pipe(Effect.ignore);

    if (storage.evictable) {
      const setup = yield* Effect.serviceOption(InstanceSetup);
      if (Option.isSome(setup)) {
        setup.value.add(
          Effect.gen(function* () {
            wake = yield* Alchemy.makeCallback(
              `pi:${options.name ?? "pi"}:wake`,
              Effect.fn(function* () {
                const harness = yield* open;
                harness.resume();
                // Work until Pi has nothing to run now (idle, or asleep until
                // a time), or for one slice; then arm the next alarm.
                yield* untilSettled(harness).pipe(Effect.timeoutOption(ALARM_SLICE));
                yield* arm(harness);
              }),
              { retry: { delay: HEARTBEAT } },
            ).pipe(Effect.orDie);
          }),
        );
      }
    }

    /** Run a Pi call on the open harness, then keep the alarm armed. */
    const withHarness = <A>(call: (harness: PiHarness) => Effect.Effect<A, PiError>) =>
      Effect.flatMap(open, (harness) => Effect.tap(call(harness), () => arm(harness)));

    const changeOf = (
      agent: AgentOptions,
      current?: ReadonlyArray<string>,
    ): Effect.Effect<AgentChange, NotOnHarness> =>
      Effect.gen(function* () {
        const registration = (ref: ToolRef) => {
          const tool = toolByName.get(ref.toolName);
          return tool === undefined
            ? Effect.fail(new NotOnHarness({ kind: "tool", name: ref.toolName }))
            : Effect.succeed({ name: ref.toolName } as ToolRegistration);
        };
        let tools: AgentChange["tools"];
        if (agent.tools === null) tools = null;
        else if (agent.tools === undefined) tools = undefined;
        else if (Array.isArray(agent.tools))
          tools = yield* Effect.forEach(agent.tools, registration);
        else {
          const edit = agent.tools as {
            add?: ReadonlyArray<ToolRef>;
            remove?: ReadonlyArray<ToolRef>;
          };
          const remove = new Set((edit.remove ?? []).map((tool) => tool.toolName));
          const add = (edit.add ?? []).map((tool) => tool.toolName);
          // Pi stores only a removal list or an exact list; adding means
          // writing out the exact list.
          const enabled = current ?? [...toolByName.keys()];
          const names = [...new Set([...enabled, ...add])].filter((name) => !remove.has(name));
          tools = yield* Effect.forEach(
            names.map((toolName) => ({ toolName }) as ToolRef),
            registration,
          );
        }
        if (agent.model != null && !models.some(({ model }) => model === agent.model)) {
          return yield* new NotOnHarness({ kind: "model", name: agent.model.modelName });
        }
        return {
          ...(agent.model !== undefined
            ? {
                model:
                  agent.model === null
                    ? null
                    : { provider: modelName(agent.model), modelId: modelName(agent.model) },
              }
            : {}),
          ...(agent.thinkingLevel !== undefined ? { thinkingLevel: agent.thinkingLevel } : {}),
          ...(tools !== undefined ? { tools } : {}),
          ...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
          ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
          ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
        } as AgentChange;
      });

    const defaultModel = models[0]?.model;
    const withDefaults = (agent: AgentOptions): AgentOptions =>
      agent.model === undefined && defaultModel !== undefined
        ? { ...agent, model: defaultModel }
        : agent;

    /** The tools a conversation has enabled now, by name. */
    const enabledTools = (conversation: PiConversation) =>
      fromPi((context) => conversation.agent(context)).pipe(
        Effect.map((agent) => [
          ...new Set(
            [...agent.tools, ...agent.callable, ...agent.deferred].map((tool) => tool.name),
          ),
        ]),
      );

    const submissionOf = (harness: PiHarness, submission: PiSubmission): Submission => ({
      id: submission.id,
      wait: withHarness(() => fromPi((context) => submission.wait(context))),
      status: fromPi((context) => submission.status(context)),
      abort: fromPi((context) => submission.abort(context)),
    });

    const conversationOf = (id: ConversationId): Conversation => {
      const raw = Effect.flatMap(open, (harness) =>
        fromPi((context) => harness.conversation(id, context)).pipe(
          Effect.flatMap((conversation) =>
            conversation === undefined
              ? Effect.fail(new PiError({ message: `No conversation ${id}` }))
              : Effect.succeed({ harness, conversation }),
          ),
        ),
      );
      const on = <A, E>(
        call: (conversation: PiConversation, harness: PiHarness) => Effect.Effect<A, E>,
      ) =>
        Effect.flatMap(raw, ({ harness, conversation }) =>
          Effect.tap(call(conversation, harness), () => arm(harness)),
        );
      return {
        id,
        raw: Effect.map(raw, ({ conversation }) => conversation),
        agent: on((conversation) => fromPi((context) => conversation.agent(context))),
        configure: (agent) =>
          on((conversation) =>
            Effect.gen(function* () {
              const current =
                agent.tools && !Array.isArray(agent.tools)
                  ? yield* enabledTools(conversation)
                  : undefined;
              const change = yield* changeOf(agent, current);
              yield* fromPi((context) => conversation.configure(change, context));
            }),
          ),
        submit: (draft) =>
          on((conversation, harness) =>
            fromPi((context) => conversation.submit(draft as never, context)).pipe(
              Effect.map((submission) => submissionOf(harness, submission)),
            ),
          ),
        reset: (handoff) =>
          on((conversation) => fromPi((context) => conversation.reset(handoff, context))),
        compact: (instructions) =>
          on((conversation) =>
            Effect.asVoid(fromPi((context) => conversation.compact(instructions, context))),
          ),
        abort: (abortOptions) =>
          on((conversation) => fromPi((context) => conversation.abort(context, abortOptions))),
        waitForIdle: on((conversation) => fromPi((context) => conversation.waitForIdle(context))),
        fork: (entryId, forkOptions = {}) =>
          on((conversation) =>
            Effect.gen(function* () {
              const { name, ...agent } = forkOptions;
              const change = yield* changeOf(agent);
              const fork = yield* fromPi((context) =>
                conversation.fork(
                  entryId,
                  {
                    ownership: { kind: "ownerless" },
                    agent: change,
                    ...(name !== undefined ? { init: nameIt(name) } : {}),
                  },
                  context,
                ),
              );
              return conversationOf(fork.id);
            }),
          ),
        context: on((conversation) => fromPi((context) => conversation.context(context))),
        entries: (query = {}) =>
          on((conversation) =>
            fromPi((context) =>
              conversation.entries(
                { order: query.order ?? "ascending" },
                query.limit ?? 100,
                undefined,
                context,
              ),
            ).pipe(Effect.map((page) => page.items)),
          ),
        watch: (window) =>
          Stream.unwrap(
            Effect.map(raw, ({ conversation }) =>
              Stream.callback<ConversationView, PiError>((queue) =>
                Effect.acquireRelease(
                  fromPi((context) => conversation.watch(context, window)).pipe(
                    Effect.tap((handle) =>
                      Effect.sync(() =>
                        handle.start(async (call) => {
                          if (call.kind === "value") Queue.offerUnsafe(queue, call.value);
                          else
                            Queue.failCauseUnsafe(
                              queue,
                              Cause.fail(new PiError({ message: messageOf(call.error) })),
                            );
                        }),
                      ),
                    ),
                  ),
                  (handle) => Effect.promise(() => handle.stop()),
                ),
              ),
            ),
          ),
      };
    };

    const nameIt = (name: string) => async (tx: Tx, conversationId: ConversationId) => {
      const names = (await tx.doc(ConversationNames)) as { names: Record<string, number> };
      names.names[name] = conversationId;
    };

    const namedId = (harness: PiHarness, name: string) =>
      fromPi((context) => harness.snapshot(ConversationNames, context)).pipe(
        Effect.map((doc) => doc?.names[name] as ConversationId | undefined),
      );

    return {
      raw: open,
      createConversation: (createOptions = {}) =>
        withHarness((harness) =>
          Effect.gen(function* () {
            const { name, ...agent } = createOptions;
            if (name !== undefined) {
              const existing = yield* namedId(harness, name);
              if (existing !== undefined) return conversationOf(existing);
            }
            const change = yield* changeOf(withDefaults(agent)).pipe(
              Effect.mapError(
                (error) =>
                  new PiError({ message: `${error.kind} ${error.name} is not on this harness` }),
              ),
            );
            const conversation = yield* fromPi((context) =>
              harness.createConversation(
                {
                  ownership: { kind: "ownerless" },
                  agent: change,
                  ...(name !== undefined ? { init: nameIt(name) } : {}),
                },
                context,
              ),
            );
            return conversationOf(conversation.id);
          }),
        ),
      conversationByName: (name) =>
        Effect.flatMap(open, (harness) =>
          Effect.flatMap(namedId(harness, name), (id) =>
            id === undefined
              ? Effect.fail(new ConversationNotFound({ name }))
              : Effect.succeed(conversationOf(id)),
          ),
        ),
      conversation: (id) =>
        Effect.flatMap(open, (harness) =>
          fromPi((context) => harness.conversation(id, context)).pipe(
            Effect.map((conversation) =>
              conversation === undefined ? undefined : conversationOf(id),
            ),
          ),
        ),
      root: (rootOptions = {}) =>
        withHarness((harness) =>
          Effect.gen(function* () {
            const change = yield* changeOf(withDefaults(rootOptions)).pipe(
              Effect.mapError(
                (error) =>
                  new PiError({ message: `${error.kind} ${error.name} is not on this harness` }),
              ),
            );
            const root = yield* fromPi((context) => harness.root(context, { agent: change }));
            return conversationOf(root.id);
          }),
        ),
      listConversations: Effect.flatMap(open, (harness) =>
        fromPi((context) => harness.snapshot(ConversationNames, context)).pipe(
          Effect.map((doc) => ({ ...(doc?.names ?? {}) }) as Record<string, ConversationId>),
        ),
      ),
      usage: Effect.flatMap(open, (harness) => fromPi((context) => harness.usage(context))),
      inspect: Effect.flatMap(open, (harness) => fromPi((context) => harness.inspect(context))),
      waitForIdle: Effect.flatMap(open, (harness) =>
        fromPi((context) => harness.waitForIdle(context)),
      ),
    } satisfies Harness;
  }) as Effect.Effect<
    Harness,
    never,
    Storage | EnvHost | ModelServices<Models> | ToolRequirements<Tools[number]>
  >;
