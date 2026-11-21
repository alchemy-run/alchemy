import type { AnyModel, ModelService } from "@alchemy.run/ai/Model";
import { complete, toEventStream, type ChatRequest } from "@alchemy.run/ai/OpenAiChat";
import { makeRuns } from "@alchemy.run/ai/Runs";
import { Sandbox, Sandboxes, sandboxOf } from "@alchemy.run/ai/Sandbox";
import {
  callTool,
  parametersJsonSchema,
  ToolCall,
  toolKind,
  type ToolHandler,
  type ToolSpec,
} from "@alchemy.run/ai/Tool";
import {
  flattenTools,
  type AnyTool,
  type ToolRef,
  type ToolRequirements,
} from "@alchemy.run/ai/Toolkit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { AgentRuntime, Contracts } from "nanocode-ts";
import { NanocodeError } from "./Errors.ts";
import { Host } from "./Host.ts";

type ModelServices<Models extends ReadonlyArray<AnyModel>> = {
  [K in keyof Models]: Models[K] extends Context.Key<infer Self, any> ? Self : never;
}[number];

export interface HarnessOptions<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<AnyTool>,
> {
  /** The models a session may run on. A session uses the first unless it names another. */
  readonly models: Models;
  /** `AI.Tool`s the agent can call, next to nanocode's own. Their handlers run in the harness. */
  readonly tools?: Tools;
  /** Instructions every session starts with. */
  readonly instructions?: string;
  /**
   * The directory in the sandbox nanocode's own tools work in, on a
   * harness that has sandboxes.
   * @default "/home/user"
   */
  readonly directory?: string;
}

export interface SessionOptions<Models extends ReadonlyArray<AnyModel>> {
  /** The model the session runs on: one the harness lists. @default the first listed */
  readonly model?: Models[number];
}

export interface PromptOptions {
  /**
   * Identifies the prompt, so a retry is the same turn and nothing runs
   * twice.
   */
  readonly requestId?: string;
}

/** Where a submitted prompt stands. */
export type SubmittedPrompt =
  | { readonly status: "running" }
  | { readonly status: "done"; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

/** A named nanocode session: its journal, and its sandbox. */
export interface Session {
  readonly name: string;
  /**
   * The key of the session's sandbox: what the `AI.Sandboxes` Layer names
   * or labels the sandbox by.
   */
  readonly sandboxKey: string;
  /**
   * Send a prompt and wait for the turn to finish. Returns the agent's
   * final message. A turn an evicted instance left unfinished is finished
   * first.
   */
  readonly prompt: (
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<string, NanocodeError, RuntimeContext>;
  /**
   * Accept a prompt and return: it runs in the background and survives the
   * instance. If the instance is evicted or redeployed before the turn
   * ends, the next one continues it from nanocode's journal: model calls
   * and tool calls that finished are not made again. `requestId`
   * identifies the prompt: submitting it again is the same turn.
   */
  readonly submit: (
    text: string,
    options: { readonly requestId: string },
  ) => Effect.Effect<void, NanocodeError, RuntimeContext>;
  /** Where a submitted prompt stands, or `undefined` when nothing was submitted under that id. */
  readonly submitted: (
    requestId: string,
  ) => Effect.Effect<SubmittedPrompt | undefined, NanocodeError, RuntimeContext>;
  /** The session's log, as nanocode records it: every event of every turn, oldest first. */
  readonly events: Effect.Effect<
    ReadonlyArray<Contracts.LoggedEvent>,
    NanocodeError,
    RuntimeContext
  >;
  /**
   * Stop the session's sandbox and keep its files, where the platform can
   * (`AI.Sandboxes`'s `suspend`). Its next tool call resumes it. Does
   * nothing on a harness without sandboxes.
   */
  readonly suspendSandbox: Effect.Effect<void, NanocodeError, RuntimeContext>;
  /** Delete the session's sandbox (`AI.Sandboxes`'s `remove`). Its next tool call starts an empty one. */
  readonly removeSandbox: Effect.Effect<void, NanocodeError, RuntimeContext>;
}

/** A nanocode harness: nanocode's runtime with models, tools and sandboxes supplied. */
export interface Harness<Models extends ReadonlyArray<AnyModel>> {
  /** A session, by a name of your choosing. It exists once it has been prompted. */
  readonly session: (name: string, options?: SessionOptions<Models>) => Session;
}

const slug = (text: string, length: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-length);

/** FNV-1a over a seed, for ids derived from a name. */
const hash = (text: string, seed = 0x811c9dc5) => {
  let value = seed;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
};

const sandboxKey = (instanceId: string, name: string): string =>
  ["nc", slug(instanceId, 16), hash(name), slug(name, 16)].filter(Boolean).join("-");

/** A session's id in nanocode's journal: the same for the same name, shaped as the UUID nanocode expects. */
const sessionId = (name: string): string => {
  const hex = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
    .map((seed) => hash(name, seed))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const failed = (cause: unknown) => new NanocodeError({ message: messageOf(cause), cause });

/** The model id nanocode is told: its Workers AI transport speaks chat completions. */
const modelId = (model: AnyModel) => `@cf/alchemy/${model.modelName}`;

const SCOPE = "session";

/**
 * A nanocode harness. Yield it where the runtime's dependencies are
 * resolved (a Durable Object's outer Effect): the models, tools and host
 * it needs are Layers provided there. nanocode's runtime, one WebAssembly
 * module, runs in the harness: it asks the harness for each model
 * response, tool result and shell command, and journals every one.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * export default class Sessions extends Cloudflare.DurableObject<Sessions>()(
 *   "Sessions",
 *   Effect.gen(function* () {
 *     const harness = yield* Nanocode.Harness({ models: [Fast], tools: [LookupCode] });
 *     return Effect.gen(function* () {
 *       return {
 *         prompt: (name: string, text: string) => harness.session(name).prompt(text),
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
  Host | ModelServices<Models> | ToolRequirements<Tools[number]>
> =>
  Effect.gen(function* () {
    const host = yield* (yield* Host).instance;
    const sandboxes = Option.getOrUndefined(yield* Effect.serviceOption(Sandboxes));
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

    // The language models live as long as the instance.
    const scope = yield* Scope.make();
    const building = yield* Semaphore.make(1);
    const built = new Map<string, Context.Service.Shape<typeof LanguageModel.LanguageModel>>();
    const languageModel = (id: string) =>
      building.withPermit(
        Effect.suspend(() => {
          const existing = built.get(id);
          if (existing !== undefined) return Effect.succeed(existing);
          const found = models.find(({ model }) => modelId(model) === id);
          if (found === undefined) {
            return Effect.fail(new NanocodeError({ message: `No model ${id} on this harness.` }));
          }
          return Layer.buildWithScope(found.service.languageModel, scope).pipe(
            Effect.map((context) => Context.get(context, LanguageModel.LanguageModel)),
            Effect.tap((model) => Effect.sync(() => void built.set(id, model))),
            Effect.mapError(failed),
          );
        }),
      );

    // One turn at a time per instance: a session's runtime is not shared.
    const turns = yield* Semaphore.make(1);
    let requests = 0;

    /** Submitted prompts: recorded before they start, and continued by the instance's callback. */
    const submitted = yield* makeRuns<
      {
        readonly session: string;
        readonly text: string;
        readonly requestId: string;
        readonly model?: string;
      },
      string
    >({
      name: "nanocode",
      store: host.runs,
      ...(host.callbacks === undefined ? {} : { callbacks: host.callbacks }),
      execute: (payload) => {
        const model = models.find(({ model }) => model.modelName === payload.model)?.model;
        return session(payload.session, model === undefined ? {} : { model }).prompt(payload.text, {
          requestId: payload.requestId,
        });
      },
    });

    const session = (name: string, opened: SessionOptions<Models> = {}): Session => {
      const key = sandboxKey(host.id, name);
      const id = sessionId(name);

      /** Open the session's runtime for one use, and dispose of it after. */
      const withRuntime = <A>(
        use: (
          runtime: AgentRuntime.AgentRuntime,
        ) => Effect.Effect<A, NanocodeError, RuntimeContext>,
      ): Effect.Effect<A, NanocodeError, RuntimeContext> =>
        turns.withPermit(
          Effect.gen(function* () {
            const model = opened.model ?? models[0]?.model;
            if (model === undefined) {
              return yield* new NanocodeError({ message: "This harness lists no models." });
            }
            const context = yield* Effect.context<RuntimeContext>();
            const run = Effect.runPromiseWith(context);
            const nanocode = yield* Effect.tryPromise({
              try: () => import("nanocode-ts"),
              catch: failed,
            });
            const module = yield* host.module;
            const sql = yield* host.sql;

            // The session's sandbox, opened by the first call that needs it.
            const files =
              sandboxes === undefined
                ? undefined
                : yield* Effect.cached(
                    sandboxes.open(key).pipe(Effect.map(sandboxOf), Effect.provideContext(context)),
                  );
            const sandbox = (operation: string) =>
              files === undefined
                ? Effect.die(
                    new NanocodeError({
                      message: `This harness was given no AI.Sandboxes: a tool cannot use AI.Sandbox (${operation}).`,
                    }),
                  )
                : files;
            const lazySandbox = Sandbox.of({
              exec: (command, exec) =>
                Effect.flatMap(Effect.orDie(sandbox("exec")), (files) => files.exec(command, exec)),
              readFile: (path) =>
                Effect.flatMap(Effect.orDie(sandbox("readFile")), (files) => files.readFile(path)),
              readTextFile: (path) =>
                Effect.flatMap(Effect.orDie(sandbox("readTextFile")), (files) =>
                  files.readTextFile(path),
                ),
              writeFile: (path, content) =>
                Effect.flatMap(Effect.orDie(sandbox("writeFile")), (files) =>
                  files.writeFile(path, content),
                ),
            });

            const runtime = yield* Effect.tryPromise({
              try: () => nanocode.AgentRuntime.instantiate(module, sql, { published: () => {} }),
              catch: failed,
            });
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => runtime.dispose().catch(() => {})),
            );
            yield* Effect.tryPromise({
              try: () =>
                runtime.open(
                  {
                    scope: SCOPE,
                    session_id: id,
                    provider: "codex",
                    model: modelId(model),
                    subscription: false,
                    // Never fetched: every model request is answered by `dispatch` below.
                    endpoint: "https://alchemy.invalid/v1",
                    gateway: "workers_ai",
                    cloudflare_account_id: "alchemy",
                    codex_orchestration: "direct",
                    code_mode: false,
                    web_search: false,
                    subagents: false,
                    ...(options.instructions === undefined
                      ? {}
                      : { instructions: options.instructions }),
                    tools: tools.map(({ tool }) => ({
                      name: tool.toolName,
                      description: tool.spec.description,
                      parameters: parametersJsonSchema(tool.spec) as Record<string, unknown>,
                    })),
                    ...(files === undefined
                      ? { workspace_tools: "none" as const }
                      : {
                          workspace_tools: "all" as const,
                          workspace: directory,
                          environment: { cwd: directory, shell: "sh" },
                        }),
                  },
                  {
                    dispatch: (request) =>
                      run(
                        Effect.gen(function* () {
                          const body = JSON.parse(
                            new TextDecoder().decode(request.body),
                          ) as ChatRequest;
                          const reply = yield* complete(yield* languageModel(body.model), body);
                          return new Response(
                            toEventStream(reply, body.model, `chatcmpl-${++requests}`),
                            { headers: { "content-type": "text/event-stream" } },
                          );
                        }).pipe(
                          Effect.catchCause((cause) =>
                            Effect.succeed(
                              Response.json(
                                {
                                  error: {
                                    message: cause.pipe(Cause.squash, messageOf),
                                    type: "api_error",
                                  },
                                },
                                { status: 500 },
                              ),
                            ),
                          ),
                        ),
                      ),
                    tools: {
                      call: (toolName, input, _signal, call) => {
                        const found = tools.find(({ tool }) => tool.toolName === toolName);
                        if (found === undefined) {
                          return Promise.reject(new Error(`No tool ${toolName} on this harness.`));
                        }
                        return run(
                          callTool(found.tool.spec, found.handler, input).pipe(
                            Effect.provideService(ToolCall, {
                              conversationId: name,
                              callId: call.call_id,
                            }),
                            Effect.provideService(Sandbox, lazySandbox),
                            Effect.map((result) => result.structured ?? result.text),
                          ),
                        );
                      },
                    },
                    ...(files === undefined
                      ? {}
                      : {
                          workspace: {
                            read: (path) =>
                              run(
                                Effect.flatMap(files, (files) => files.readTextFile(path)).pipe(
                                  Effect.orElseSucceed(() => null),
                                ),
                              ),
                            write: (path, contents) =>
                              run(
                                Effect.flatMap(files, (files) => files.writeFile(path, contents)),
                              ),
                            remove: (path) =>
                              run(
                                Effect.flatMap(files, (files) =>
                                  files.exec(["rm", "-f", "--", path]),
                                ).pipe(Effect.asVoid),
                              ),
                            run: (request) =>
                              run(
                                Effect.flatMap(files, (files) =>
                                  files.exec(request.command, {
                                    cwd: request.cwd,
                                    ...(request.timeout_ms === null
                                      ? {}
                                      : { timeout: request.timeout_ms }),
                                  }),
                                ).pipe(
                                  Effect.map((result) => ({
                                    stdout: result.stdout,
                                    stderr: result.stderr,
                                    exit_code: result.exitCode,
                                    truncated: false,
                                  })),
                                ),
                              ),
                          } satisfies Contracts.WorkspaceHost,
                        }),
                  },
                ),
              catch: failed,
            });
            return yield* use(runtime);
          }).pipe(Effect.scoped),
        );

      /** Drive every unfinished turn of the session to its end. */
      const drive = (runtime: AgentRuntime.AgentRuntime) =>
        Effect.gen(function* () {
          while (true) {
            const [next] = yield* Effect.tryPromise({
              try: () => runtime.pending(SCOPE),
              catch: failed,
            });
            if (next === undefined) return;
            const driven = yield* Effect.tryPromise({
              try: () => runtime.drive(next.report.request_id),
              catch: failed,
            });
            if (driven.waiting) yield* Effect.sleep("10 millis");
          }
        });

      const onSandbox = (
        use: (sandboxes: Sandboxes["Service"]) => Effect.Effect<unknown, unknown, RuntimeContext>,
      ): Effect.Effect<void, NanocodeError, RuntimeContext> =>
        sandboxes === undefined
          ? Effect.void
          : Effect.suspend(() => use(sandboxes)).pipe(Effect.asVoid, Effect.mapError(failed));

      return {
        name,
        sandboxKey: key,
        prompt: (text, prompt = {}) =>
          withRuntime((runtime) =>
            Effect.gen(function* () {
              const requestId =
                prompt.requestId ??
                `turn-${(yield* Clock.currentTimeMillis).toString(36)}-${++requests}`;
              const submitted = yield* Effect.tryPromise({
                try: () =>
                  runtime.submit(SCOPE, { request_id: requestId, prompt: text, metadata: {} }),
                catch: failed,
              });
              if (submitted.submitted === "too_large" || submitted.submitted === "conflict") {
                return yield* new NanocodeError({
                  message: `nanocode did not accept the prompt (${submitted.submitted}).`,
                });
              }
              yield* drive(runtime);
              const turn = yield* Effect.tryPromise({
                try: () => runtime.turn(SCOPE, requestId),
                catch: failed,
              });
              const report = turn?.report as
                | (Contracts.TurnReport & { ok?: { message?: string }; error?: unknown })
                | undefined;
              if (report?.status !== "completed") {
                return yield* new NanocodeError({
                  message: `The turn ended ${report?.status ?? "without a report"}: ${JSON.stringify(report ?? null).slice(0, 2000)}`,
                });
              }
              return String(report.ok?.message ?? "");
            }),
          ),
        submit: (text, submit) =>
          submitted
            .submit(`${name}:${submit.requestId}`, {
              session: name,
              text,
              requestId: submit.requestId,
              ...(opened.model === undefined ? {} : { model: opened.model.modelName }),
            })
            .pipe(Effect.mapError(failed)),
        submitted: (requestId) =>
          submitted.status(`${name}:${requestId}`).pipe(
            Effect.map((status) =>
              status === undefined || status.status !== "done"
                ? status
                : { status: "done" as const, message: status.value },
            ),
            Effect.mapError(failed),
          ),
        events: withRuntime((runtime) =>
          Effect.gen(function* () {
            const events: Array<Contracts.LoggedEvent> = [];
            let cursor = 0;
            while (true) {
              const page = yield* Effect.tryPromise({
                try: () => runtime.page(SCOPE, cursor, 500),
                catch: failed,
              });
              events.push(...page.events);
              if (!page.has_more) return events;
              cursor = page.next_cursor;
            }
          }),
        ),
        suspendSandbox: onSandbox((sandboxes) => sandboxes.suspend(key)),
        removeSandbox: onSandbox((sandboxes) => sandboxes.remove(key)),
      };
    };

    return { session } satisfies Harness<Models>;
  }) as never;
