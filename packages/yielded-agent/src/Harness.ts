import type { AnyModel, ModelService } from "@alchemy.run/ai/Model";
import { makeRuns } from "@alchemy.run/ai/Runs";
import { Sandbox, SandboxError, Sandboxes, sandboxOf } from "@alchemy.run/ai/Sandbox";
import { ToolCall, toolKind, type ToolHandler, type ToolSpec } from "@alchemy.run/ai/Tool";
import type { Agent } from "@yielded/agent";
import { AgentRuntime } from "@yielded/agent";
import { ThreadId } from "@yielded/agent/identifiers";
import type { RunEvent } from "@yielded/agent/run-event";
import { ThreadHistory } from "@yielded/agent/thread-history";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Model, Prompt, type Tool as AiTool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { YieldedAgentError } from "./Errors.ts";
import { History } from "./History.ts";
import {
  flattenTools,
  toEffectTool,
  type AnyTool,
  type EffectTool,
  type ToolRef,
  type ToolRequirements,
} from "./Tool.ts";

type ModelServices<Models extends ReadonlyArray<AnyModel>> = {
  [K in keyof Models]: Models[K] extends Context.Key<infer Self, any> ? Self : never;
}[number];

type Flatten<T> = T extends { readonly tools: infer Tools extends ReadonlyArray<unknown> }
  ? Tools[number]
  : T;

/** The Effect AI handlers a harness supplies: one for each tool it lists. */
type Handlers<Tools extends ReadonlyArray<AnyTool>> =
  EffectTool<Flatten<Tools[number]>> extends infer T
    ? T extends AiTool.Any
      ? AiTool.Handler<T["name"]>
      : never
    : never;

/** Anything Yielded can run: a definition, or one bound to its own model. */
type ExecutableAgent = Parameters<typeof AgentRuntime.run>[0];

/** What Yielded asks of an application to run `A`. */
type RunOf<A extends ExecutableAgent> = ReturnType<typeof AgentRuntime.run<A, never, never>>;

/** What a run still needs once the harness has given it history, a model and its tools' handlers. */
type Remaining<A extends ExecutableAgent, Tools extends ReadonlyArray<AnyTool>> =
  | Exclude<Effect.Services<RunOf<A>>, ThreadHistory | Handlers<Tools> | Agent.ModelServices>
  | RuntimeContext;

export interface RunOptions<Models extends ReadonlyArray<AnyModel>> {
  /**
   * The Thread the run belongs to, by a name of your choosing. Runs with
   * the same name on the same instance share one conversation and one
   * sandbox.
   */
  readonly thread: string;
  /** The model the run uses: one the harness lists. @default the first listed */
  readonly model?: Models[number];
}

export interface HarnessOptions<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<AnyTool>,
> {
  /** The models a run may use. A run uses the first unless it names another. */
  readonly models: Models;
  /**
   * The `AI.Tool`s agents call. Each needs its Layer provided where the
   * harness is yielded, unless it carries its handler.
   */
  readonly tools?: Tools;
  /**
   * The agents `submit` can run. A submitted run may be finished by another
   * instance, which finds the agent here by its id.
   */
  readonly agents?: ReadonlyArray<ExecutableAgent>;
}

/** Where a submitted run stands. */
export type SubmittedRun<A extends ExecutableAgent> =
  | { readonly status: "running" }
  | { readonly status: "done"; readonly output: Agent.Output<A> }
  | { readonly status: "failed"; readonly message: string };

export interface SubmitOptions<Models extends ReadonlyArray<AnyModel>> extends RunOptions<Models> {
  /**
   * Identifies the run. Submitting it again is the same run: it is not
   * started twice.
   */
  readonly requestId: string;
}

/** A Yielded Agent harness: Yielded's runtime with history, models, tools and sandboxes supplied. */
export interface Harness<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<AnyTool>,
> {
  /**
   * Run an agent on a Thread and wait for its validated output
   * (`AgentRuntime.run`). The input is appended to the Thread's history.
   */
  readonly run: <A extends ExecutableAgent>(
    agent: A,
    input: NoInfer<Agent.EncodedInput<A>>,
    options: RunOptions<Models>,
  ) => Effect.Effect<
    Effect.Success<RunOf<A>>,
    Effect.Error<RunOf<A>> | YieldedAgentError,
    Remaining<A, Tools>
  >;
  /** Run an agent on a Thread and follow its events as they happen (`AgentRuntime.stream`). */
  readonly stream: <A extends ExecutableAgent>(
    agent: A,
    input: NoInfer<Agent.EncodedInput<A>>,
    options: RunOptions<Models>,
  ) => Stream.Stream<RunEvent, Effect.Error<RunOf<A>> | YieldedAgentError, Remaining<A, Tools>>;
  /**
   * Accept a run and return: it runs in the background and survives the
   * instance. If the instance is evicted or redeployed before the run
   * ends, the next one starts it again from the beginning, so its tools
   * may be called more than once. The agent must be one the harness lists
   * in `agents`.
   */
  readonly submit: <A extends ExecutableAgent>(
    agent: A,
    input: NoInfer<Agent.EncodedInput<A>>,
    options: SubmitOptions<Models>,
  ) => Effect.Effect<void, YieldedAgentError, RuntimeContext>;
  /** Where a submitted run stands, or `undefined` when nothing was submitted under that id. */
  readonly submitted: <A extends ExecutableAgent>(
    agent: A,
    requestId: string,
  ) => Effect.Effect<SubmittedRun<A> | undefined, YieldedAgentError, RuntimeContext>;
  /** What a Thread holds: the messages the next run's model would be given. Empty before its first run. */
  readonly history: (
    thread: string,
  ) => Effect.Effect<Prompt.Prompt, YieldedAgentError, RuntimeContext>;
  /**
   * The key of a Thread's sandbox: what the `AI.Sandboxes` Layer names or
   * labels the sandbox by.
   */
  readonly sandboxKey: (thread: string) => string;
  /**
   * Stop a Thread's sandbox and keep its files, where the platform can
   * (`AI.Sandboxes`'s `suspend`). Its next tool call resumes it. Does
   * nothing on a harness without sandboxes.
   */
  readonly suspendSandbox: (
    thread: string,
  ) => Effect.Effect<void, YieldedAgentError, RuntimeContext>;
  /** Delete a Thread's sandbox (`AI.Sandboxes`'s `remove`). Its next tool call starts an empty one. */
  readonly removeSandbox: (
    thread: string,
  ) => Effect.Effect<void, YieldedAgentError, RuntimeContext>;
}

const slug = (text: string, length: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-length);

/** FNV-1a, so two Thread names with the same slug still get two sandboxes. */
const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
};

/**
 * The key of a Thread's sandbox: one per Thread of one harness instance.
 *
 * @internal
 */
export const sandboxKey = (instanceId: string, thread: string): string =>
  ["ya", slug(instanceId, 16), hash(thread), slug(thread, 16)].filter(Boolean).join("-");

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

/**
 * A Yielded Agent harness. Yield it where the runtime's dependencies are
 * resolved (a Durable Object's outer Effect): the models, tools and
 * history it needs are Layers provided there, and the bindings its tools
 * declare are known at plan time. Agents are Yielded's own
 * (`Agent.make`); the harness supplies what running one needs.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * export default class Threads extends Cloudflare.DurableObject<Threads>()(
 *   "Threads",
 *   Effect.gen(function* () {
 *     const harness = yield* YieldedAgent.Harness({ models: [Fast], tools: [Add] });
 *     return Effect.gen(function* () {
 *       return {
 *         ask: Effect.fn(function* (thread: string, text: string) {
 *           const result = yield* harness.run(Calculator, text, { thread });
 *           return result.output;
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
  Harness<Models, Tools>,
  never,
  History | ModelServices<Models> | ToolRequirements<Tools[number]>
> =>
  Effect.gen(function* () {
    const instance = yield* (yield* History).instance;
    const sandboxes = Option.getOrUndefined(yield* Effect.serviceOption(Sandboxes));

    // Resolve every model and tool implementation here, where their Layers
    // (and the bindings those declare) are provided.
    const models = yield* Effect.forEach(options.models, (model) =>
      Effect.map(Effect.service(model as Context.Key<unknown, ModelService>), (service) => ({
        model,
        service,
      })),
    );
    const tools = yield* Effect.forEach(flattenTools(options.tools ?? []), (tool: ToolRef) => {
      if (toolKind(tool) === "inline") {
        return Effect.succeed({
          tool,
          handler: (tool as { handler: ToolHandler<ToolSpec> }).handler,
        });
      }
      const cls = tool as unknown as {
        impl?: Effect.Effect<ToolHandler<ToolSpec>>;
      } & Context.Key<unknown, ToolHandler<ToolSpec>>;
      return Effect.map(cls.impl ?? Effect.service(cls), (handler) => ({ tool, handler }));
    });
    const toolkit = Toolkit.make(...tools.map(({ tool }) => toEffectTool(tool)));

    // What lives as long as the instance: its history and its models.
    const scope = yield* Scope.make();
    const building = yield* Semaphore.make(1);
    const built = new Map<unknown, Context.Context<never>>();
    /** Build a Layer once per instance. A failed build is tried again by the next run. */
    const once = <A, E>(key: unknown, layer: Layer.Layer<A, E, RuntimeContext>) =>
      Semaphore.withPermit(
        building,
        Effect.suspend(() => {
          const existing = built.get(key);
          return existing === undefined
            ? Effect.tap(Layer.buildWithScope(layer, scope), (context) =>
                Effect.sync(() => void built.set(key, context as Context.Context<never>)),
              )
            : Effect.succeed(existing as Context.Context<A>);
        }),
      ).pipe(
        Effect.mapError((cause) => new YieldedAgentError({ message: messageOf(cause), cause })),
      );
    const history = once("history", instance.layer);

    const modelFor = (wanted: AnyModel | undefined) => {
      const found = wanted === undefined ? models[0] : models.find(({ model }) => model === wanted);
      if (found === undefined) {
        return Effect.fail(
          new YieldedAgentError({
            message:
              wanted === undefined
                ? "This harness lists no models."
                : `The model "${wanted.modelName}" is not one this harness lists.`,
          }),
        );
      }
      return once(
        found.model,
        Layer.mergeAll(
          found.service.languageModel,
          Layer.succeed(Model.ProviderName, "alchemy"),
          Layer.succeed(Model.ModelName, found.model.modelName),
        ),
      );
    };

    const withoutSandboxes = (operation: string) =>
      Effect.die(
        new YieldedAgentError({
          message: `This harness was given no AI.Sandboxes: a tool cannot use AI.Sandbox (${operation}).`,
        }),
      );

    /** The Thread's sandbox, opened by the first tool call that uses it. */
    const sandboxFor = Effect.fn(function* (thread: string) {
      if (sandboxes === undefined) {
        return Sandbox.of({
          exec: () => withoutSandboxes("exec"),
          readFile: () => withoutSandboxes("readFile"),
          readTextFile: () => withoutSandboxes("readTextFile"),
          writeFile: () => withoutSandboxes("writeFile"),
        });
      }
      const context = yield* Effect.context<RuntimeContext>();
      const open = yield* Effect.cached(
        sandboxes.open(sandboxKey(instance.id, thread)).pipe(
          Effect.map(sandboxOf),
          Effect.mapError(
            (cause) =>
              new SandboxError({ operation: "open", code: "unknown", message: messageOf(cause) }),
          ),
          Effect.provideContext(context),
        ),
      );
      return Sandbox.of({
        exec: (command, options) =>
          Effect.flatMap(open, (sandbox) => sandbox.exec(command, options)),
        readFile: (path) => Effect.flatMap(open, (sandbox) => sandbox.readFile(path)),
        readTextFile: (path) => Effect.flatMap(open, (sandbox) => sandbox.readTextFile(path)),
        writeFile: (path, content) =>
          Effect.flatMap(open, (sandbox) => sandbox.writeFile(path, content)),
      });
    });

    let calls = 0;
    /** Everything a run needs from the harness, for one Thread. */
    const servicesFor = Effect.fn(function* (options: RunOptions<Models>) {
      const context = yield* Effect.context<RuntimeContext>();
      const sandbox = yield* sandboxFor(options.thread);
      const handlers = yield* toolkit.toHandlers(
        Object.fromEntries(
          tools.map(({ tool, handler }) => [
            tool.toolName,
            (parameters: unknown) =>
              handler(parameters).pipe(
                Effect.provideService(ToolCall, {
                  conversationId: options.thread,
                  callId: `${options.thread}:${++calls}`,
                }),
                Effect.provideService(Sandbox, sandbox),
                Effect.provideContext(context),
              ),
          ]),
        ) as never,
      );
      return Context.mergeAll(
        yield* history,
        yield* modelFor(options.model),
        handlers as Context.Context<never>,
      );
    });

    const threadId = (thread: string) =>
      Schema.decodeEffect(ThreadId)(thread).pipe(
        Effect.mapError(
          (cause) => new YieldedAgentError({ message: "A Thread's name cannot be empty.", cause }),
        ),
      );

    const onSandbox =
      (
        use: (
          sandboxes: Sandboxes["Service"],
          key: string,
        ) => Effect.Effect<unknown, unknown, RuntimeContext>,
      ) =>
      (thread: string) =>
        sandboxes === undefined
          ? Effect.void
          : use(sandboxes, sandboxKey(instance.id, thread)).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new YieldedAgentError({ message: messageOf(cause), cause }),
              ),
            );

    const agentId = (agent: ExecutableAgent): string =>
      String("definition" in agent ? agent.definition.id : agent.id);
    const outputOf = (agent: ExecutableAgent): Schema.Codec<unknown, unknown> =>
      ("definition" in agent ? agent.definition.output : agent.output) as never;
    const agents = new Map((options.agents ?? []).map((agent) => [agentId(agent), agent]));

    /** Submitted runs: recorded before they start, and started again by the instance's callback. */
    const runs = yield* makeRuns<
      {
        readonly agent: string;
        readonly input: unknown;
        readonly thread: string;
        readonly model?: string;
      },
      unknown
    >({
      name: "yielded-agent",
      store: instance.runs,
      ...(instance.callbacks === undefined ? {} : { callbacks: instance.callbacks }),
      execute: (payload) =>
        Effect.gen(function* () {
          const agent = agents.get(payload.agent);
          if (agent === undefined) {
            return yield* new YieldedAgentError({
              message: `The agent "${payload.agent}" is not one this harness lists in agents.`,
            });
          }
          const model = models.find(({ model }) => model.modelName === payload.model)?.model;
          const services = yield* servicesFor({
            thread: payload.thread,
            ...(model === undefined ? {} : { model }),
          });
          const result = (yield* AgentRuntime.run(agent, payload.input as never, {
            threadId: yield* threadId(payload.thread),
          }).pipe(Effect.provideContext(services as never))) as { readonly output: unknown };
          return yield* Schema.encodeUnknownEffect(outputOf(agent))(result.output);
        }).pipe(Effect.mapError((cause) => ({ message: messageOf(cause) }))) as Effect.Effect<
          unknown,
          { readonly message: string },
          RuntimeContext
        >,
    });

    const harness: Harness<Models, Tools> = {
      submit: (agent, input, submit) =>
        agents.has(agentId(agent))
          ? runs
              .submit(submit.requestId, {
                agent: agentId(agent),
                input,
                thread: submit.thread,
                ...(submit.model === undefined ? {} : { model: submit.model.modelName }),
              })
              .pipe(Effect.mapError((cause) => new YieldedAgentError({ message: cause.message })))
          : Effect.fail(
              new YieldedAgentError({
                message: `Submitting needs the agent "${agentId(agent)}" listed in the harness's agents.`,
              }),
            ),
      submitted: (agent, requestId) =>
        runs.status(requestId).pipe(
          Effect.flatMap((status): Effect.Effect<unknown, Schema.SchemaError> =>
            status === undefined || status.status !== "done"
              ? Effect.succeed(status)
              : Effect.map(Schema.decodeUnknownEffect(outputOf(agent))(status.value), (output) => ({
                  status: "done" as const,
                  output,
                })),
          ),
          Effect.mapError((cause) => new YieldedAgentError({ message: messageOf(cause) })),
        ) as never,
      run: (agent, input, options) =>
        Effect.gen(function* () {
          const services = yield* servicesFor(options);
          return yield* AgentRuntime.run(agent, input, {
            threadId: yield* threadId(options.thread),
          }).pipe(Effect.provideContext(services));
        }) as never,
      stream: (agent, input, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const services = yield* servicesFor(options);
            return AgentRuntime.stream(agent, input, {
              threadId: yield* threadId(options.thread),
            }).pipe(Stream.provideContext(services));
          }),
        ) as never,
      history: (thread) =>
        Effect.gen(function* () {
          const services = yield* history;
          const id = yield* threadId(thread);
          return yield* Context.get(services, ThreadHistory)
            .load(id)
            .pipe(
              // A Thread nothing has run on yet holds nothing.
              Effect.catchIf(
                (cause) => cause.reason === "not-found",
                () => Effect.succeed(Prompt.empty),
              ),
              Effect.mapError((cause) => new YieldedAgentError({ message: cause.message, cause })),
            );
        }),
      sandboxKey: (thread) => sandboxKey(instance.id, thread),
      suspendSandbox: onSandbox((sandboxes, key) => sandboxes.suspend(key)),
      removeSandbox: onSandbox((sandboxes, key) => sandboxes.remove(key)),
    };
    return harness;
  }) as never;
