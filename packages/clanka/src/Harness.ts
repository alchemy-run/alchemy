import type { AnyModel, ModelService } from "@alchemy.run/ai/Model";
import { makeRuns } from "@alchemy.run/ai/Runs";
import { Sandbox, Sandboxes, sandboxOf } from "@alchemy.run/ai/Sandbox";
import { ToolCall, toolKind, type ToolHandler, type ToolSpec } from "@alchemy.run/ai/Tool";
import {
  flattenTools,
  toEffectTool,
  type AnyTool,
  type ToolRef,
  type ToolRequirements,
} from "@alchemy.run/ai/Toolkit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Agent, AgentExecutor, type AgentOutput } from "clanka";
import { Model, Prompt, Toolkit } from "effect/ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ClankaError } from "./Errors.ts";
import { layerSandbox } from "./internal/executor.ts";
import { Store } from "./Store.ts";

type ModelServices<Models extends ReadonlyArray<AnyModel>> = {
  [K in keyof Models]: Models[K] extends Context.Key<infer Self, any> ? Self : never;
}[number];

/** One of clanka's own script functions, by the name clanka gives it. */
export type BuiltinTool = Parameters<typeof AgentExecutor.layerRpcServer>[0] extends {
  readonly excludeTools?: ReadonlyArray<infer Name> | undefined;
}
  ? Name
  : never;

export interface HarnessOptions<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<AnyTool>,
> {
  /** The models a prompt may use. A prompt uses the first unless it names another. */
  readonly models: Models;
  /**
   * `AI.Tool`s the agent's scripts can call, next to clanka's own. Their
   * handlers run in the harness, not in the sandbox, so they can use your
   * bindings.
   */
  readonly tools?: Tools;
  /**
   * The directory in the sandbox the executor works in. It is created when
   * missing.
   * @default "/home/user"
   */
  readonly directory?: string;
  /** clanka's own script functions to leave out (`"fetch"`, `"bash"`, `"subagent"`, …). */
  readonly excludeTools?: ReadonlyArray<BuiltinTool>;
}

export interface PromptOptions<Models extends ReadonlyArray<AnyModel>> {
  /** The model the prompt runs on: one the harness lists. @default the first listed */
  readonly model?: Models[number];
  /** Extra system instructions for this prompt. */
  readonly instructions?: string;
}

/** Where a submitted prompt stands. */
export type SubmittedPrompt =
  | { readonly status: "running" }
  | { readonly status: "done"; readonly summary: string }
  | { readonly status: "failed"; readonly message: string };

/** A named conversation with clanka: its history, and its sandbox. */
export interface Conversation<Models extends ReadonlyArray<AnyModel>> {
  readonly name: string;
  /**
   * The key of the conversation's sandbox: what the `AI.Sandboxes` Layer
   * names or labels the sandbox by.
   */
  readonly sandboxKey: string;
  /**
   * Send a prompt and wait for the agent to finish. Returns the summary
   * the agent ended on (clanka's `taskComplete`). The conversation is
   * saved once the prompt has finished.
   */
  readonly prompt: (
    text: string,
    options?: PromptOptions<Models>,
  ) => Effect.Effect<string, ClankaError, RuntimeContext>;
  /**
   * Send a prompt and follow clanka's output as it happens (`Agent.send`):
   * reasoning, the scripts it writes, what they print. The stream ends
   * when the agent finishes.
   */
  readonly send: (
    text: string,
    options?: PromptOptions<Models>,
  ) => Stream.Stream<AgentOutput.Output, ClankaError, RuntimeContext>;
  /**
   * Accept a prompt and return: it runs in the background and survives the
   * instance. If the instance is evicted or redeployed before the agent
   * finishes, the next one sends the prompt again to the conversation as it
   * was last saved, so the agent's scripts may run more than once.
   * `requestId` identifies the prompt: submitting it again is the same one.
   */
  readonly submit: (
    text: string,
    options: PromptOptions<Models> & { readonly requestId: string },
  ) => Effect.Effect<void, ClankaError, RuntimeContext>;
  /** Where a submitted prompt stands, or `undefined` when nothing was submitted under that id. */
  readonly submitted: (
    requestId: string,
  ) => Effect.Effect<SubmittedPrompt | undefined, ClankaError, RuntimeContext>;
  /** The conversation so far: the messages the next prompt's model is given. */
  readonly history: Effect.Effect<Prompt.Prompt, ClankaError, RuntimeContext>;
  /** Forget the conversation. Its sandbox is left as it is. */
  readonly reset: Effect.Effect<void, ClankaError, RuntimeContext>;
  /**
   * Stop the conversation's sandbox and keep its files, where the platform
   * can (`AI.Sandboxes`'s `suspend`). Its next prompt resumes it.
   */
  readonly suspendSandbox: Effect.Effect<void, ClankaError, RuntimeContext>;
  /** Delete the conversation's sandbox (`AI.Sandboxes`'s `remove`). Its next prompt starts an empty one. */
  readonly removeSandbox: Effect.Effect<void, ClankaError, RuntimeContext>;
}

/** A clanka harness: clanka's agent with models, tools, storage and sandboxes supplied. */
export interface Harness<Models extends ReadonlyArray<AnyModel>> {
  /** A conversation, by a name of your choosing. It exists once it has been prompted. */
  readonly conversation: (name: string) => Conversation<Models>;
}

const slug = (text: string, length: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-length);

/** FNV-1a, so two names with the same slug still get two sandboxes. */
const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
};

const sandboxKey = (instanceId: string, name: string): string =>
  ["ck", slug(instanceId, 16), hash(name), slug(name, 16)].filter(Boolean).join("-");

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const failed = (cause: unknown) => new ClankaError({ message: messageOf(cause), cause });

/** What is saved of a conversation between prompts. */
const Saved = Schema.fromJsonString(
  Schema.Struct({
    history: Prompt.Prompt,
    environment: Schema.optional(AgentExecutor.ExecutionEnvironment),
  }),
);

/**
 * A clanka harness. Yield it where the runtime's dependencies are
 * resolved (a Durable Object's outer Effect): the models, tools, store
 * and sandboxes it needs are Layers provided there. clanka's agent loop
 * runs in the harness on your model; its executor, which runs the scripts
 * the agent writes, runs in the conversation's sandbox.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * export default class Coder extends Cloudflare.DurableObject<Coder>()(
 *   "Coder",
 *   Effect.gen(function* () {
 *     const harness = yield* Clanka.Harness({ models: [Smart] });
 *     return Effect.gen(function* () {
 *       return {
 *         prompt: (name: string, text: string) => harness.conversation(name).prompt(text),
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
  Harness<Models>,
  never,
  Store | Sandboxes | ModelServices<Models> | ToolRequirements<Tools[number]>
> =>
  Effect.gen(function* () {
    const store = yield* (yield* Store).instance;
    const sandboxes = yield* Sandboxes;
    const directory = options.directory ?? "/home/user";

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

    const modelFor = (wanted: AnyModel | undefined) => {
      const found = wanted === undefined ? models[0] : models.find(({ model }) => model === wanted);
      return found === undefined
        ? Effect.fail(
            new ClankaError({
              message:
                wanted === undefined
                  ? "This harness lists no models."
                  : `The model "${wanted.modelName}" is not one this harness lists.`,
            }),
          )
        : Effect.succeed(
            Layer.mergeAll(
              found.service.languageModel,
              Layer.succeed(Model.ProviderName, "alchemy"),
              Layer.succeed(Model.ModelName, found.model.modelName),
            ),
          );
    };

    let runs = 0;
    /** Submitted prompts: recorded before they start, and started again by the instance's callback. */
    const submitted = yield* makeRuns<
      {
        readonly conversation: string;
        readonly text: string;
        readonly model?: string;
        readonly instructions?: string;
      },
      string
    >({
      name: "clanka",
      store: {
        get: (key) => store.get(`submitted:${key}`),
        put: (key, value) => store.put(`submitted:${key}`, value),
        delete: (key) => store.delete(`submitted:${key}`),
      },
      ...(store.callbacks === undefined ? {} : { callbacks: store.callbacks }),
      execute: (payload) => {
        const model = models.find(({ model }) => model.modelName === payload.model)?.model;
        return conversation(payload.conversation).prompt(payload.text, {
          ...(model === undefined ? {} : { model }),
          ...(payload.instructions === undefined ? {} : { instructions: payload.instructions }),
        });
      },
    });
    const conversation = (name: string): Conversation<Models> => {
      const key = sandboxKey(store.id, name);
      const load = store
        .get(name)
        .pipe(
          Effect.flatMap((text) =>
            text === undefined
              ? Effect.succeed(undefined)
              : Schema.decodeEffect(Saved)(text).pipe(Effect.mapError(failed)),
          ),
        );

      const send = (text: string, prompt: PromptOptions<Models> = {}) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const context = yield* Effect.context<RuntimeContext>();
            const started = yield* Clock.currentTimeMillis;
            const model = yield* modelFor(prompt.model);
            const saved = yield* load;
            const handle = yield* sandboxes.open(key).pipe(Effect.mapError(failed));
            const files = sandboxOf(handle);
            let calls = 0;
            const handlers = yield* toolkit.toHandlers(
              Object.fromEntries(
                tools.map(({ tool, handler }) => [
                  tool.toolName,
                  (parameters: unknown) =>
                    handler(parameters).pipe(
                      Effect.provideService(ToolCall, {
                        conversationId: name,
                        callId: `${name}:${++calls}`,
                      }),
                      Effect.provideService(Sandbox, files),
                      Effect.provideContext(context),
                    ),
                ]),
              ) as never,
            );
            const agentLayer = Agent.layerWith({ loopTools: toolkit }).pipe(
              Layer.provide(Layer.succeedContext(handlers as Context.Context<never>)),
              Layer.provide(
                layerSandbox(handle, {
                  directory,
                  excludeTools: options.excludeTools ?? [],
                  id: `${started.toString(36)}${++runs}`,
                }),
              ),
            );
            return Stream.unwrap(
              Effect.gen(function* () {
                const agent = yield* Agent.Agent;
                if (saved !== undefined) {
                  MutableRef.set(agent.history, saved.history);
                  if (saved.environment !== undefined) {
                    MutableRef.set(agent.environment, saved.environment);
                  }
                }
                const save = Effect.suspend(() =>
                  Schema.encodeEffect(Saved)({
                    history: MutableRef.get(agent.history),
                    environment: MutableRef.get(agent.environment),
                  }),
                ).pipe(
                  Effect.mapError(failed),
                  Effect.flatMap((text) => store.put(name, text)),
                  Effect.provideContext(context),
                );
                const output = yield* agent.send({
                  prompt: text,
                  ...(prompt.instructions === undefined ? {} : { system: prompt.instructions }),
                });
                return output.pipe(
                  // clanka ends a finished task as a failure that carries its summary.
                  Stream.catchTag("AgentFinished", (finished) =>
                    Stream.fromEffect(save).pipe(
                      Stream.flatMap(() => Stream.empty),
                      Stream.concat(Stream.succeed(finished)),
                    ),
                  ),
                  Stream.mapError(failed),
                );
              }),
            ).pipe(Stream.provide(Layer.mergeAll(agentLayer, model)), Stream.mapError(failed));
          }),
        );

      const onSandbox = (
        use: (key: string) => Effect.Effect<unknown, unknown, RuntimeContext>,
      ): Effect.Effect<void, ClankaError, RuntimeContext> =>
        Effect.suspend(() => use(key)).pipe(Effect.asVoid, Effect.mapError(failed));

      return {
        name,
        sandboxKey: key,
        send: (text, prompt) =>
          send(text, prompt).pipe(
            Stream.filter((part): part is AgentOutput.Output => part._tag !== "AgentFinished"),
          ),
        prompt: (text, prompt) =>
          send(text, prompt).pipe(
            Stream.runFold(
              () => undefined as string | undefined,
              (summary, part) => (part._tag === "AgentFinished" ? part.summary : summary),
            ),
            Effect.flatMap((summary) =>
              summary === undefined
                ? Effect.fail(
                    new ClankaError({ message: "clanka stopped before the agent finished." }),
                  )
                : Effect.succeed(summary),
            ),
          ),
        submit: (text, prompt) =>
          submitted
            .submit(`${name}:${prompt.requestId}`, {
              conversation: name,
              text,
              ...(prompt.model === undefined ? {} : { model: prompt.model.modelName }),
              ...(prompt.instructions === undefined ? {} : { instructions: prompt.instructions }),
            })
            .pipe(Effect.mapError(failed)),
        submitted: (requestId) =>
          submitted.status(`${name}:${requestId}`).pipe(
            Effect.map((status) =>
              status === undefined || status.status !== "done"
                ? status
                : { status: "done" as const, summary: status.value },
            ),
            Effect.mapError(failed),
          ),
        history: Effect.map(load, (saved) => saved?.history ?? Prompt.empty),
        reset: store.delete(name),
        suspendSandbox: onSandbox((key) => sandboxes.suspend(key)),
        removeSandbox: onSandbox((key) => sandboxes.remove(key)),
      };
    };

    return { conversation } satisfies Harness<Models>;
  }) as never;
