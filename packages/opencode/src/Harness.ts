import {
  CodeModeConvention,
  isCodeMode,
  renderEvaluation,
  type CodeModeGroup,
  type Convention,
  type Evaluator,
} from "@alchemy.run/ai/CodeMode";
import type { DeclaredNamespace, DeclaredTool, JsonSchema } from "@alchemy.run/ai/Declarations";
import { isMcpServer, type AnyMcpServer, type McpServerService } from "@alchemy.run/ai/McpServer";
import type { AnyModel, ModelService } from "@alchemy.run/ai/Model";
import { Sandbox, SandboxError, Sandboxes, sandboxOf } from "@alchemy.run/ai/Sandbox";
import type { AnySkill } from "@alchemy.run/ai/Skill";
import {
  callTool,
  parametersJsonSchema,
  isToolTag,
  ToolCall,
  type AnyTool as AiTool,
  type ToolHandler,
  type ToolSpec,
  type ToolTagService,
} from "@alchemy.run/ai/Tool";
import type { Plugin } from "@opencode/plugin";
import * as Alchemy from "alchemy";
import type { Callback } from "alchemy/Callback";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import { LanguageModel, McpClient, Tool as AiToolSchema } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { NotOnHarness, OpenCodeError } from "./Errors.ts";
import { chatResponse, complete, type ChatRequest } from "./internal/chat.ts";
import { Storage, type Host } from "./Storage.ts";
import {
  ENGINE,
  flattenTools,
  isBuiltin,
  type AnyTool,
  type Enabled,
  type Listed,
  type ToolRef,
  type ToolRequirements,
} from "./Tool.ts";

/** Options of {@link Harness}. */
export interface HarnessOptions<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<Listed>,
  Skills extends ReadonlyArray<AnySkill> = readonly [],
> {
  /**
   * What OpenCode calls this harness: the provider its models belong to,
   * and the prefix of its tools' names (`alchemy_<tool>`).
   * @default "alchemy"
   */
  readonly name?: string;
  /** Every model a session may run on. The first is the default. */
  readonly models: Models;
  /**
   * Every tool a session may be given: your own (`AI.Tool`), tool tags
   * (`AI.Bash`, `AI.CodingTools`), the tools only OpenCode has
   * (`OpenCode.WebFetch`), and MCP servers. OpenCode
   * names a tool it did not ship after its server: yours are
   * `<name>_<tool>`, an MCP server's are `<server>_<tool>`.
   *
   * Tools inside `AI.CodeMode(...)` are reached from programs the model
   * writes; the others are direct calls.
   */
  readonly tools?: Tools;
  /** Skills every session can load when a task calls for one. */
  readonly skills?: Skills;
  /**
   * The directory sessions work in: where a tool's `AI.Sandbox` runs
   * commands and resolves relative paths, and the directory OpenCode files
   * its sessions under.
   * @default the sandbox's own working directory
   */
  readonly cwd?: string;
  /** OpenCode's own configuration (`opencode.json`), merged under what the harness sets. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** What a prompt runs with. Unset fields keep the session's, then the harness's. */
export interface PromptOptions {
  readonly model?: AnyModel;
  /**
   * The tools the model may use for this prompt: exactly these. An MCP
   * server stands for all of its tools. Those inside `AI.CodeMode(...)` are
   * reached from programs; a list without a group has no code mode.
   */
  readonly tools?: ReadonlyArray<Enabled>;
  /** Added to OpenCode's system prompt. */
  readonly instructions?: string;
  /** One of OpenCode's agents (`build`, `plan`, or one from `config`). */
  readonly agent?: string;
  /**
   * Makes the prompt exactly-once while this instance runs: a retry with
   * the same id waits for the original and gets its answer.
   */
  readonly requestId?: string;
}

/**
 * One entry of a session's transcript as OpenCode stores it, told apart by
 * `type`: `user` (a prompt), `assistant` (one step of an answer), `idle`
 * (the end of a run, with its `outcome`), `skill`, `agent-switched`, …
 */
export interface Message {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** One piece of an assistant step: `text`, `reasoning`, or a `tool` call. */
export interface Content {
  readonly type: string;
  readonly text?: string;
  /** A `tool` call's tool, as OpenCode names it (`alchemy_add`, `webfetch`, `execute`). */
  readonly name?: string;
  readonly state?: {
    readonly status: "streaming" | "running" | "completed" | "error";
    readonly input?: unknown;
    /** What the tool returned. */
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly error?: { readonly type: string; readonly message: string };
    /** A code mode program's tool calls are in `toolCalls`. */
    readonly metadata?: { readonly [key: string]: unknown };
  };
  readonly [key: string]: unknown;
}

/** One step of an answer: what the model said and the tools it called. */
export interface AssistantMessage extends Message {
  readonly type: "assistant";
  readonly content: ReadonlyArray<Content>;
}

/** The answer to one prompt. */
export interface Reply {
  /** The text of every step of the answer. */
  readonly text: string;
  /** What the prompt added to the transcript, from the prompt itself to its `idle` entry. */
  readonly messages: ReadonlyArray<Message>;
}

/** One session of OpenCode. */
export interface Session {
  readonly name: string;
  /**
   * The key the harness opens this session's sandbox with: what an
   * `AI.Sandboxes` Layer names or labels the sandbox by.
   */
  readonly sandboxKey: string;
  /** OpenCode's id for the session. */
  readonly id: Effect.Effect<string, OpenCodeError, RuntimeContext>;
  /** Send a prompt and wait for the answer, through every tool call it takes. */
  readonly prompt: (
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<Reply, OpenCodeError | NotOnHarness, RuntimeContext>;
  /**
   * Give the session a prompt and return once it is stored, without
   * waiting for the answer. The prompt runs on, and resumes if the instance
   * is evicted; `wait` returns when the session has nothing left to run.
   */
  readonly submit: (
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<void, OpenCodeError | NotOnHarness, RuntimeContext>;
  /** Return once the session has nothing left to run. */
  readonly wait: Effect.Effect<void, OpenCodeError, RuntimeContext>;
  /** Stop the prompt that is running. */
  readonly abort: Effect.Effect<void, OpenCodeError, RuntimeContext>;
  /** The session's transcript, oldest first. */
  readonly messages: Effect.Effect<ReadonlyArray<Message>, OpenCodeError, RuntimeContext>;
  /**
   * Stop the session's sandbox and keep its files, where its platform can
   * (`AI.Sandboxes`'s `suspend`). Its next tool call resumes it. Does
   * nothing on a harness without sandboxes.
   */
  readonly suspendSandbox: Effect.Effect<void, OpenCodeError, RuntimeContext>;
  /**
   * Delete the session's sandbox (`AI.Sandboxes`'s `remove`). Its next
   * tool call starts one again, empty. The session keeps its transcript.
   */
  readonly removeSandbox: Effect.Effect<void, OpenCodeError, RuntimeContext>;
}

/** A harness: sessions, and the models, tools and skills they may use. */
export interface Harness {
  /**
   * The session with this name. Nothing runs until it is used. `defaults`
   * are what its prompts run with unless they say otherwise.
   */
  readonly session: (name: string, defaults?: PromptOptions) => Session;
  /**
   * Call OpenCode's own client, for what this view doesn't cover. Starts
   * OpenCode in this instance when it is not running.
   */
  readonly use: <A>(
    call: (client: Host) => Promise<A>,
  ) => Effect.Effect<A, OpenCodeError, RuntimeContext>;
}

type ModelServices<Models extends ReadonlyArray<AnyModel>> = Models[number] extends infer M
  ? M extends Context.Key<infer I, any>
    ? I
    : never
  : never;

/**
 * The key of a session's sandbox: one per session of one harness instance.
 *
 * @internal
 */
export const sandboxKey = (instanceId: string, session: string): string => {
  const slug = (text: string, length: number) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-length)
      .replace(/^-+/, "");
  // Two names that shorten to the same slug still get sandboxes of their own.
  let hash = 0x811c9dc5;
  for (let i = 0; i < session.length; i++) {
    hash = Math.imul(hash ^ session.charCodeAt(i), 0x01000193);
  }
  return ["oc", slug(instanceId, 20), slug(session, 12), (hash >>> 0).toString(16).padStart(8, "0")]
    .filter((part) => part.length > 0)
    .join("-");
};

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const fail = (message: string, cause?: unknown) =>
  new OpenCodeError({ message, ...(cause !== undefined ? { cause } : {}) });

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  /** Types what a code mode program gets back. MCP allows only an object. */
  readonly outputSchema?: object;
}

/** A tool's `success` schema as an MCP `outputSchema`, when it describes an object. */
const outputSchemaOf = (spec: ToolSpec): object | undefined => {
  if (spec.success.ast._tag === "Void") return undefined;
  const schema = AiToolSchema.getJsonSchemaFromSchema(spec.success) as {
    readonly type?: unknown;
    readonly $ref?: unknown;
    readonly $defs?: Readonly<Record<string, { readonly type?: unknown }>>;
  };
  const target =
    typeof schema.$ref === "string" ? schema.$defs?.[schema.$ref.split("/").at(-1)!] : schema;
  return target?.type === "object" ? schema : undefined;
};

/** What one instance builds once: its models, and the tools each server gives. */
interface Built {
  readonly models: ReadonlyMap<string, LanguageModel.LanguageModel>;
  readonly servers: Readonly<Record<string, ReadonlyArray<ListedTool>>>;
  readonly call: (
    server: string,
    tool: string,
    args: unknown,
    services: Context.Context<Sandbox | ToolCall>,
  ) => Effect.Effect<
    { readonly text: string; readonly structured?: unknown; readonly isError: boolean },
    never,
    RuntimeContext
  >;
  /** Every tool a program may call, by the name it has where scripts run. */
  readonly programmed: ReadonlyMap<string, Programmed>;
  /** How programs are written, when the harness runs them itself. */
  readonly convention?: Convention;
}

/** How long OpenCode stays open after its last call with nothing running. */
const IDLE_CLOSE = Duration.seconds(30);
/**
 * How long one alarm waits on a running prompt before the next takes over.
 * An instance evicted during the wait starts again at the next alarm, so
 * this is also about how long a cut-off prompt takes to resume.
 */
const WAKE_SLICE = Duration.seconds(30);

/** The harness's own tool that runs a program, under a shared convention. */
const CODEMODE_TOOL = "codemode";

/** A tool a program may call: where its call goes, and how it is declared. */
interface Programmed {
  readonly server: string;
  /** An MCP server's name: its tools are declared under it. */
  readonly namespace?: string;
  readonly tool: DeclaredTool;
}

/** The declarations of `tools`: the harness's own tools first, then each server's. */
const namespaceOf = (programmed: ReadonlyArray<Programmed>): Omit<DeclaredNamespace, "name"> => {
  const namespaces = new Map<string, DeclaredTool[]>();
  for (const { tool, namespace } of programmed) {
    if (namespace === undefined) continue;
    namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), tool]);
  }
  return {
    tools: programmed.flatMap(({ tool, namespace }) => (namespace === undefined ? [tool] : [])),
    namespaces: [...namespaces].map(([name, tools]) => ({ name, tools })),
  };
};

/**
 * Run one program where the evaluator runs it, with every tool a program
 * may call. A call's declared failure rejects with its fields as JSON,
 * which the convention's wrapper turns into the failure's class.
 */
const runProgram = (
  program: { readonly convention: Convention; readonly evaluator: Evaluator },
  programmed: ReadonlyMap<string, Programmed>,
  call: Built["call"],
  code: string,
  services: Context.Context<Sandbox | ToolCall>,
): Effect.Effect<{ readonly text: string; readonly isError: boolean }, never, RuntimeContext> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<RuntimeContext>();
    const tools = Object.fromEntries(
      [...programmed].map(([callAs, { server, tool }]) => [
        callAs,
        async (args: unknown) => {
          const result = await Effect.runPromiseWith(context)(
            call(server, tool.name, args ?? {}, services),
          );
          // A rejection is how the script's call fails.
          if (result.isError) throw new Error(result.text);
          return result.structured ?? result.text;
        },
      ]),
    );
    const { wrap } = program.convention.program(namespaceOf([...programmed.values()]));
    return renderEvaluation(yield* program.evaluator.run(wrap(code), tools));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ text: messageOf(cause.pipe(Cause.squash)), isError: true }),
    ),
  );

/** A tool of ours, with the handler its Layer or declaration gave. */
interface Resolved {
  readonly tool: { readonly toolName: string; readonly spec: ToolSpec };
  readonly handler: ToolHandler<ToolSpec>;
}

/**
 * An OpenCode harness. OpenCode runs where you yield it, on the instance's
 * own storage (`OpenCode.Storage`): in a Durable Object, on its SQLite.
 * Its model requests are answered by your `AI.Model` Layers and its tool
 * calls run your `AI.Tool` handlers, all in the same isolate.
 *
 * Nothing of OpenCode runs in a sandbox. A tool that needs files or a
 * shell uses `AI.Sandbox`, which the harness opens for the session from
 * `AI.Sandboxes`; a harness whose tools need neither takes no sandbox.
 *
 * Yield it where the runtime's dependencies are resolved (a Durable
 * Object's outer Effect): the models, tools and storage it needs are
 * Layers provided there.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * export default class Coder extends Cloudflare.DurableObject<Coder>()(
 *   "Coder",
 *   Effect.gen(function* () {
 *     const harness = yield* OpenCode.Harness({
 *       models: [Smart],
 *       tools: [AI.CodingTools, Deploy],
 *     });
 *     return Effect.gen(function* () {
 *       return {
 *         prompt: Effect.fn(function* (name: string, text: string) {
 *           const reply = yield* harness.session(name).prompt(text);
 *           return reply.text;
 *         }),
 *       };
 *     });
 *   }).pipe(Effect.provide(HarnessLive)),
 * ) {}
 * ```
 */
export const Harness = <
  const Models extends ReadonlyArray<AnyModel>,
  const Tools extends ReadonlyArray<Listed> = readonly [],
  const Skills extends ReadonlyArray<AnySkill> = readonly [],
>(
  options: HarnessOptions<Models, Tools, Skills>,
): Effect.Effect<
  Harness,
  never,
  Storage | ModelServices<Models> | ToolRequirements<Tools[number]>
> =>
  Effect.gen(function* () {
    const name = options.name ?? "alchemy";
    const storage = yield* (yield* Storage).instance;
    const instanceId = storage.id;
    // Where tools find files and a shell. A harness without sandboxes runs
    // only tools that need neither.
    const sandboxes = Option.getOrUndefined(yield* Effect.serviceOption(Sandboxes));

    // Resolve every model and tool implementation here, where their Layers
    // (and the bindings those declare) are provided.
    const models = yield* Effect.forEach(options.models, (model) =>
      Effect.map(Effect.service(model as Context.Key<unknown, ModelService>), (service) => ({
        model,
        service,
      })),
    );
    // A tool is reached directly or from a program, by where it is listed.
    const every: ReadonlyArray<Listed> = options.tools ?? [];
    /** A list's direct tools, and the ones inside its code mode groups. */
    const routed = (list: ReadonlyArray<Listed | Enabled>) => {
      const flat = (tools: ReadonlyArray<AnyTool | AnyMcpServer>) =>
        tools.flatMap((tool): ReadonlyArray<ToolRef | AnyMcpServer> =>
          isMcpServer(tool) ? [tool] : flattenTools([tool]),
        );
      return {
        direct: flat(list.filter((tool): tool is AnyTool | AnyMcpServer => !isCodeMode(tool))),
        programs: flat(
          list
            .filter((tool): tool is CodeModeGroup<ReadonlyArray<AnyTool | AnyMcpServer>> =>
              isCodeMode(tool),
            )
            .flatMap((group) => group.tools),
        ),
        grouped: list.some(isCodeMode),
      };
    };
    const harnessTools = routed(every);
    const codemode = harnessTools.grouped ? yield* CodeModeConvention : undefined;
    const unique = <T>(list: ReadonlyArray<T>, key: (item: T) => string) => [
      ...new Map(list.map((item) => [key(item), item] as const)).values(),
    ];
    const listed: ReadonlyArray<ToolRef | AnyMcpServer> = [
      ...harnessTools.direct,
      ...harnessTools.programs,
    ];
    const refs = unique(
      listed.filter((tool): tool is ToolRef => !isMcpServer(tool)),
      (tool) => ("key" in tool ? String(tool.key) : tool.toolName),
    );
    // A tool tag is whatever its Layer provided: one of OpenCode's own
    // tools, or a tool of yours.
    const tags = yield* Effect.forEach(refs.filter(isToolTag), (tool) =>
      Effect.flatMap(
        Effect.service(tool as unknown as Context.Key<unknown, ToolTagService>),
        (impl): Effect.Effect<{ key: string; native?: string; own?: Resolved }> => {
          if (impl.kind === "tool") {
            return Effect.succeed({
              key: tool.key,
              own: { tool: { toolName: tool.toolName, spec: impl.spec }, handler: impl.handler },
            });
          }
          return impl.engine === ENGINE
            ? Effect.succeed({ key: tool.key, native: impl.tool as string })
            : Effect.die(
                new OpenCodeError({
                  message: `AI.Tool/${tool.toolName} was given ${impl.engine}'s tool, which only runs on that harness. Provide an OpenCode Layer for it (OpenCode.CodingTools) or your own.`,
                }),
              );
        },
      ),
    );
    const nativeOf = new Map(tags.flatMap((tag) => (tag.native ? [[tag.key, tag.native]] : [])));
    const declared: ReadonlyArray<Resolved> = yield* Effect.forEach(
      refs.filter((tool): tool is AiTool => !isBuiltin(tool) && !isToolTag(tool)),
      (tool): Effect.Effect<Resolved> => {
        if ("handler" in tool) return Effect.succeed({ tool, handler: tool.handler });
        const cls = tool as unknown as {
          impl?: Effect.Effect<ToolHandler<ToolSpec>>;
        } & Context.Key<unknown, ToolHandler<ToolSpec>>;
        return Effect.map(cls.impl ?? Effect.service(cls), (handler) => ({
          tool,
          handler,
        })) as unknown as Effect.Effect<Resolved>;
      },
    );
    const tools = [...declared, ...tags.flatMap((tag) => (tag.own ? [tag.own] : []))];
    const servers = yield* Effect.forEach(
      unique(
        listed.filter((tool): tool is AnyMcpServer => isMcpServer(tool)),
        (server) => server.serverName,
      ),
      (server) =>
        Effect.map(
          Effect.service(server as Context.Key<unknown, McpServerService>),
          ({ client }) => ({ server, client }),
        ),
    );
    const skills = options.skills ?? [];
    const captured = yield* Effect.context<never>();

    /** What the model may call a tool of ours. */
    const nameOf = (server: string, tool: string) =>
      `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    let built: Promise<Built> | undefined;
    let base: Context.Context<RuntimeContext> | undefined;
    const build = Effect.gen(function* () {
      if (built === undefined) {
        // Run tools and models with what the harness was yielded with, plus
        // this instance's runtime context (never a call's Scope).
        const call = yield* Effect.context<RuntimeContext>();
        const context = Context.merge(captured, call).pipe(
          Context.omit(Scope.Scope),
        ) as Context.Context<RuntimeContext>;
        base = context;
        // Layers are built once per instance. Their scope is never closed:
        // workerd has no instance teardown, and a client holds nothing to release.
        const make = Effect.gen(function* () {
          const scope = yield* Scope.make();
          const languageModels = new Map<string, LanguageModel.LanguageModel>();
          for (const { model, service } of models) {
            const layer = yield* Layer.buildWithScope(service.languageModel, scope).pipe(
              Effect.mapError((cause) =>
                fail(`Model ${model.modelName}: ${messageOf(cause)}`, cause),
              ),
            );
            languageModels.set(model.modelName, Context.get(layer, LanguageModel.LanguageModel));
          }
          const clients = new Map<
            string,
            {
              readonly client: McpClient.McpClient;
              readonly tools: Effect.Success<ReturnType<McpClient.McpClient["listTools"]>>;
            }
          >();
          for (const { server, client } of servers) {
            const made = yield* Layer.buildWithScope(client, scope).pipe(
              Effect.map((layer) => Context.get(layer, McpClient.McpClient)),
              Effect.flatMap((client) =>
                Effect.map(client.listTools(), (tools) => ({ client, tools })),
              ),
              Effect.mapError((cause) =>
                fail(`MCP server ${server.serverName}: ${messageOf(cause)}`, cause),
              ),
            );
            clients.set(server.serverName, made);
          }
          // A shared convention runs programs here, behind a tool of the harness's own.
          const program =
            codemode?.kind === "shared"
              ? yield* codemode.convention.pipe(
                  Effect.map((convention) => ({ convention, evaluator: codemode.evaluator })),
                  Effect.mapError((cause) => fail(`Code mode: ${cause.message}`, cause)),
                )
              : undefined;
          const ownTools: ReadonlyArray<ListedTool> = [
            ...tools.map(({ tool }) => {
              const outputSchema = outputSchemaOf(tool.spec);
              return {
                name: tool.toolName,
                description: tool.spec.description,
                inputSchema: parametersJsonSchema(tool.spec),
                ...(outputSchema !== undefined ? { outputSchema } : {}),
              };
            }),
            ...(program === undefined
              ? []
              : [
                  {
                    name: CODEMODE_TOOL,
                    description: program.convention.intro,
                    inputSchema: {
                      type: "object",
                      properties: {
                        code: { type: "string", description: "The program's source." },
                      },
                      required: ["code"],
                    },
                  },
                ]),
          ];
          const toolServers: Record<string, ReadonlyArray<ListedTool>> = {
            ...(ownTools.length > 0 ? { [name]: ownTools } : {}),
            ...Object.fromEntries(
              [...clients].map(([server, { tools }]) => [
                server,
                tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description ?? tool.title ?? tool.name,
                  inputSchema: tool.inputSchema as object,
                  ...(tool.outputSchema !== undefined
                    ? { outputSchema: tool.outputSchema as object }
                    : {}),
                })),
              ]),
            ),
          };
          // Every tool a program may call, by the name it has where scripts run.
          const programmed = new Map<string, Programmed>([
            ...tools.map(
              ({ tool }) =>
                [
                  nameOf(name, tool.toolName),
                  {
                    server: name,
                    tool: {
                      name: tool.toolName,
                      callAs: nameOf(name, tool.toolName),
                      description: tool.spec.description,
                      parameters: tool.spec.parameters,
                      success: tool.spec.success,
                      ...(tool.spec.failure === undefined ? {} : { failure: tool.spec.failure }),
                    },
                  },
                ] as const,
            ),
            ...[...clients].flatMap(([server, { tools }]) =>
              tools.map(
                (tool) =>
                  [
                    nameOf(server, tool.name),
                    {
                      server,
                      namespace: server,
                      tool: {
                        name: tool.name,
                        callAs: nameOf(server, tool.name),
                        description: tool.description ?? tool.title ?? tool.name,
                        parameters: tool.inputSchema as JsonSchema,
                        ...(tool.outputSchema === undefined
                          ? {}
                          : { success: tool.outputSchema as JsonSchema }),
                      },
                    },
                  ] as const,
              ),
            ),
          ]);
          const handlers = new Map(
            tools.map(({ tool, handler }) => [tool.toolName, { tool, handler }]),
          );
          const call: Built["call"] = (server, toolName, args, services) => {
            if (server === name && toolName === CODEMODE_TOOL && program !== undefined) {
              return runProgram(
                program,
                programmed,
                call,
                typeof (args as { code?: unknown }).code === "string"
                  ? (args as { code: string }).code
                  : "",
                services,
              );
            }
            if (server === name) {
              const found = handlers.get(toolName);
              if (found === undefined) {
                return Effect.succeed({ text: `No tool ${toolName}`, isError: true });
              }
              return callTool(found.tool.spec, found.handler, args).pipe(
                Effect.provideContext(services),
                Effect.scoped,
                // A defect or bad arguments: the model reads what went wrong.
                Effect.catchCause((cause) =>
                  Effect.succeed({ text: messageOf(cause.pipe(Cause.squash)), isError: true }),
                ),
              );
            }
            const mcp = clients.get(server);
            const tool = mcp?.tools.find((tool) => tool.name === toolName);
            if (mcp === undefined || tool === undefined) {
              return Effect.succeed({ text: `No tool ${toolName} on ${server}`, isError: true });
            }
            return mcp.client.callTool({ tool, arguments: args as Record<string, unknown> }).pipe(
              Effect.map((result) => ({
                text: result.content
                  .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
                  .join("\n"),
                ...(result.isError !== true && result.structuredContent !== undefined
                  ? { structured: result.structuredContent }
                  : {}),
                isError: result.isError === true,
              })),
              Effect.catchCause((cause) =>
                Effect.succeed({
                  text: `MCP server ${server}: ${messageOf(cause.pipe(Cause.squash))}`,
                  isError: true,
                }),
              ),
            );
          };
          return {
            models: languageModels,
            servers: toolServers,
            call,
            programmed,
            ...(program === undefined ? {} : { convention: program.convention }),
          } satisfies Built;
        });
        built = Effect.runPromiseWith(context)(make);
      }
      return yield* Effect.tryPromise({
        try: () => built!,
        catch: (cause) => fail(messageOf(cause), cause),
      }).pipe(Effect.tapError(() => Effect.sync(() => (built = undefined))));
    });

    /** The host OpenCode asks for model answers, which never leaves this isolate. */
    const MODEL_HOST = "alchemy-harness.invalid";
    const directory = options.cwd ?? "/workspace";
    const sessionTitle = (session: string) => `alchemy:${session}`;

    /** Each session's sandbox as `AI.Sandbox`, opened on a tool's first use. */
    const opened = new Map<string, Promise<Sandbox["Service"]>>();
    const sandboxFor = (session: string): Sandbox["Service"] | undefined => {
      if (sandboxes === undefined) return undefined;
      const open = Effect.suspend(() => {
        let opening = opened.get(session);
        if (opening === undefined) {
          opening = Effect.runPromiseWith(base!)(
            Effect.map(sandboxes.open(sandboxKey(instanceId, session)), sandboxOf),
          );
          opened.set(session, opening);
          opening.catch(() => {
            if (opened.get(session) === opening) opened.delete(session);
          });
        }
        return Effect.tryPromise({
          try: () => opening!,
          catch: (cause) =>
            new SandboxError({ operation: "open", code: "unknown", message: messageOf(cause) }),
        });
      });
      // Commands run in the harness's `cwd`, and relative paths start there.
      const cwd = options.cwd;
      const at = (path: string) =>
        cwd === undefined || path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
      return {
        exec: (command, execOptions) =>
          Effect.flatMap(open, (sandbox) =>
            sandbox.exec(command, {
              ...(cwd === undefined ? {} : { cwd }),
              ...execOptions,
            }),
          ),
        readFile: (path) => Effect.flatMap(open, (sandbox) => sandbox.readFile(at(path))),
        readTextFile: (path) => Effect.flatMap(open, (sandbox) => sandbox.readTextFile(at(path))),
        writeFile: (path, content) =>
          Effect.flatMap(open, (sandbox) => sandbox.writeFile(at(path), content)),
      };
    };

    /** OpenCode's id for each session, and the session each id is. */
    const sessionIds = new Map<string, Promise<string>>();
    const namesById = new Map<string, string>();

    /** Our tools, skills and models, as the plugin OpenCode loads them from. */
    const pluginOf = (state: Built, client: () => Promise<Host>): Plugin.Plugin => ({
      id: `alchemy.${name}`,
      setup: async (ctx) => {
        const run = Effect.runPromiseWith(base!);
        // Under OpenCode's own code mode, its `execute` tool reaches the
        // tools listed for programs; every other tool is a direct call.
        const programs =
          codemode?.kind === "native"
            ? new Set(
                harnessTools.programs.flatMap((tool) =>
                  isMcpServer(tool)
                    ? (state.servers[tool.serverName] ?? []).map((entry) =>
                        nameOf(tool.serverName, entry.name),
                      )
                    : [nameOf(name, tool.toolName)],
                ),
              )
            : new Set<string>();
        /** The session a call belongs to: an instance that restarted asks OpenCode. */
        const sessionOf = async (sessionID: string) => {
          const known = namesById.get(sessionID);
          if (known !== undefined) return known;
          const prefix = sessionTitle("");
          const title = (await (await client()).session.get({ sessionID })).title ?? "";
          const session = title.startsWith(prefix) ? title.slice(prefix.length) : sessionID;
          namesById.set(sessionID, session);
          return session;
        };
        const tools = await ctx.tool.transform((editor) => {
          for (const [server, listed] of Object.entries(state.servers)) {
            for (const tool of listed) {
              const toolName = nameOf(server, tool.name);
              editor.add({
                name: toolName,
                description: tool.description,
                input: tool.inputSchema as never,
                ...(tool.outputSchema !== undefined ? { output: tool.outputSchema as never } : {}),
                options: { codemode: programs.has(toolName), permission: toolName },
                execute: async (input, context) => {
                  const session = await sessionOf(context.sessionID);
                  const sandbox = sandboxFor(session);
                  const call = Context.make(ToolCall, {
                    conversationId: session,
                    callId: context.id,
                  });
                  const result = await run(
                    state.call(
                      server,
                      tool.name,
                      input ?? {},
                      // A harness without sandboxes lists no tool that uses one.
                      (sandbox === undefined
                        ? call
                        : Context.add(call, Sandbox, sandbox)) as Context.Context<
                        Sandbox | ToolCall
                      >,
                    ),
                  );
                  // A thrown error is how OpenCode reports a failed call to the model.
                  if (result.isError) throw new Error(result.text);
                  return {
                    content: result.text,
                    ...(result.structured !== undefined ? { output: result.structured } : {}),
                  } as never;
                },
              });
            }
          }
        });
        const loaded = await ctx.skill.transform((editor) => {
          for (const skill of skills) {
            editor.add({
              id: skill.skillName,
              name: skill.skillName,
              description: skill.skill.description,
              path: `${directory}/.alchemy/skills/${skill.skillName}/SKILL.md`,
              content: skill.skill.instructions,
            } as never);
          }
        });
        return async () => {
          await loaded.dispose();
          await tools.dispose();
        };
      },
    });

    /** Answer OpenCode's model requests here; every other request goes out as it is. */
    const fetchOf =
      (state: Built) =>
      async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname !== MODEL_HOST) return fetch(request);
        const body = (await request.json()) as ChatRequest & { readonly stream?: boolean };
        const model = state.models.get(body.model);
        if (model === undefined) {
          return Response.json(
            { error: { message: `No model ${body.model} on this harness`, type: "not_found" } },
            { status: 404 },
          );
        }
        const reply = await Effect.runPromiseWith(base!)(
          complete(model, body).pipe(
            Effect.map((reply) => ({ reply })),
            Effect.catchCause((cause) =>
              Effect.succeed({ error: messageOf(cause.pipe(Cause.squash)) }),
            ),
          ),
        );
        return "error" in reply
          ? Response.json(
              { error: { message: reply.error, type: "server_error" } },
              { status: 500 },
            )
          : chatResponse(body, reply.reply);
      };

    // OpenCode starts once per instance, and again after it was closed for
    // being idle. Starting it resumes a prompt an eviction cut off.
    const host = { client: undefined as Promise<Host> | undefined, inFlight: 0 };
    const open = Effect.gen(function* () {
      const state = yield* build;
      if (host.client === undefined) {
        const starting: Promise<Host> = Effect.runPromiseWith(base!)(
          storage.open({
            config: {
              ...options.config,
              autoupdate: false,
              share: "disabled",
              permission: "allow",
              model: `${name}/${models[0]!.model.modelName}`,
              small_model: `${name}/${models[0]!.model.modelName}`,
              provider: {
                ...(options.config?.provider as object | undefined),
                [name]: {
                  npm: "@ai-sdk/openai-compatible",
                  name,
                  options: { baseURL: `https://${MODEL_HOST}/v1`, apiKey: name },
                  models: Object.fromEntries(
                    models.map(({ model }) => [
                      model.modelName,
                      {
                        name: model.modelName,
                        tool_call: true,
                        attachment: model.options.images === true,
                        limit: {
                          context: model.options.contextWindow ?? 128_000,
                          output: model.options.maxTokens ?? 8192,
                        },
                      },
                    ]),
                  ),
                },
              },
            } as never,
            // The models are the harness's own: nothing to look up.
            models: { fetch: false },
            fetch: fetchOf(state),
            plugins: [pluginOf(state, () => starting)],
          }),
        );
        host.client = starting;
        starting.catch(() => {
          if (host.client === starting) host.client = undefined;
        });
      }
      return yield* Effect.tryPromise({
        try: () => host.client!,
        catch: (cause) => fail(`OpenCode did not start: ${messageOf(cause)}`, cause),
      });
    });

    /** What OpenCode said went wrong, with the reason its client keeps beside the status. */
    const failureOf = (what: string | undefined, cause: unknown) => {
      const detail = (cause as { readonly cause?: unknown } | undefined)?.cause;
      return fail(
        [
          what === undefined ? undefined : `OpenCode ${what}`,
          messageOf(cause),
          detail && messageOf(detail),
        ]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join(": "),
        cause,
      );
    };

    const use = <A>(call: (client: Host) => Promise<A>, what?: string) =>
      Effect.acquireUseRelease(
        Effect.andThen(
          Effect.sync(() => host.inFlight++),
          open,
        ),
        (client) =>
          Effect.tryPromise({
            try: () => call(client),
            catch: (cause) => failureOf(what, cause),
          }),
        () => Effect.sync(() => host.inFlight--),
      );

    /** The sessions OpenCode is working on now. */
    const active = Effect.map(
      use((client) => client.session.active()),
      (sessions) => new Set(Object.keys(sessions)),
    );

    // An open OpenCode keeps timers running, which keep a Durable Object in
    // memory. It is closed once idle and started again by the next call.
    let close: Callback<null> | undefined;
    // An evicted Durable Object is only started again by an alarm, so a
    // running prompt keeps one armed: it waits with the prompt, and a
    // prompt cut off by an eviction resumes when the alarm starts OpenCode.
    let wake: Callback<string> | undefined;
    const closeSoon = Effect.suspend(() =>
      close === undefined
        ? Effect.void
        : close.schedule("idle", { payload: null, after: IDLE_CLOSE }).pipe(Effect.ignore),
    );
    const armWake = (sessionID: string) =>
      Effect.suspend(() =>
        wake === undefined
          ? Effect.void
          : wake.schedule(sessionID, { payload: sessionID, after: 0 }).pipe(Effect.ignore),
      );
    const callbacks = storage.callbacks;
    if (storage.evictable && callbacks !== undefined) {
      const setup = yield* Effect.serviceOption(InstanceSetup);
      if (Option.isSome(setup)) {
        setup.value.add(
          Effect.gen(function* () {
            const closeIdle = Effect.gen(function* () {
              if (host.inFlight > 0 || (yield* active).size > 0) return;
              const closing = host.client;
              host.client = undefined;
              if (closing !== undefined) {
                yield* Effect.promise(() =>
                  closing.then(
                    (client) => client.close(),
                    () => undefined,
                  ),
                );
              }
            }).pipe(Effect.ignore);
            close = yield* Alchemy.makeCallback(`opencode:${name}:close`, (_: null) => closeIdle);
            wake = yield* Alchemy.makeCallback(
              `opencode:${name}:wake`,
              Effect.fn(function* (sessionID: string) {
                // The next alarm is armed before waiting: an eviction during
                // the wait leaves it to start this instance again.
                yield* wake!.schedule(sessionID, {
                  payload: sessionID,
                  after: Duration.sum(WAKE_SLICE, Duration.seconds(10)),
                });
                if ((yield* active).has(sessionID)) {
                  yield* use((client) => client.experimental.session.wait({ sessionID })).pipe(
                    Effect.timeoutOption(WAKE_SLICE),
                  );
                }
                if ((yield* active).has(sessionID)) {
                  return yield* wake!.schedule(sessionID, { payload: sessionID, after: 0 });
                }
                yield* wake!.cancel(sessionID);
                yield* closeSoon;
                // A failed wake is a defect, which the callbacks redeliver.
              }, Effect.orDie),
            );
          }).pipe(Effect.provide(callbacks)),
        );
      }
    }

    const sessionIdOf = (session: string) =>
      use((client) => {
        let id = sessionIds.get(session);
        if (id === undefined) {
          const finding = (async () => {
            // The session is the one titled after its name. OpenCode's own
            // search reads a name as a query, so the titles are compared here.
            const title = sessionTitle(session);
            let found: { readonly id: string } | undefined;
            let cursor: string | undefined;
            for (;;) {
              const page = await client.session.list(
                cursor === undefined ? { limit: 100 } : { cursor },
              );
              found = page.data.find((candidate) => candidate.title === title);
              const next = page.cursor?.next;
              if (found !== undefined || typeof next !== "string" || next.length === 0) break;
              cursor = next;
            }
            const sessionID =
              found?.id ?? (await client.session.create({ title, location: { directory } })).id;
            namesById.set(sessionID, session);
            return sessionID;
          })();
          id = finding;
          sessionIds.set(session, finding);
          finding.catch(() => {
            if (sessionIds.get(session) === finding) sessionIds.delete(session);
          });
        }
        return id;
      }, "session");

    const transcript = (sessionID: string) =>
      use(async (client) => {
        const messages: Array<Message> = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await client.message.list({
            sessionID,
            ...(cursor === undefined ? { order: "asc" as const, limit: 200 } : { cursor }),
          });
          messages.push(...(page.data as unknown as ReadonlyArray<Message>));
          const next = page.cursor?.next;
          if (typeof next !== "string" || next.length === 0) return messages;
          cursor = next;
        }
      }, "messages");

    /**
     * The session's permissions: every tool denied, then the chosen ones
     * allowed. OpenCode has tools of its own; a prompt only gets what its
     * harness lists.
     *
     * Tools in a code mode group are reached from programs. Under a shared
     * convention the harness's `codemode` tool runs them and those tools
     * are not offered directly. Under OpenCode's own code mode, its
     * `execute` tool reaches every allowed tool of ours.
     */
    const permissions = (selected: ReadonlyArray<Enabled> | undefined) =>
      Effect.gen(function* () {
        const state = yield* build;
        const ours = Object.entries(state.servers).flatMap(([server, tools]) =>
          tools.map((tool) => ({ server, tool: tool.name, name: nameOf(server, tool.name) })),
        );
        const chosen = selected === undefined ? harnessTools : routed(selected);
        /** The names OpenCode knows a listed tool by. */
        const namesOf = (tool: ToolRef | AnyMcpServer) =>
          Effect.gen(function* () {
            if (isMcpServer(tool)) {
              if (!(tool.serverName in state.servers)) {
                return yield* new NotOnHarness({ kind: "tool", missing: tool.serverName });
              }
              return {
                own: true,
                names: ours
                  .filter((entry) => entry.server === tool.serverName)
                  .map((entry) => entry.name),
              };
            }
            if (isBuiltin(tool)) return { own: false, names: [tool.toolName] };
            if (isToolTag(tool) && nativeOf.has(tool.key)) {
              return { own: false, names: [nativeOf.get(tool.key)!] };
            }
            if (!ours.some((entry) => entry.server === name && entry.tool === tool.toolName)) {
              return yield* new NotOnHarness({ kind: "tool", missing: tool.toolName });
            }
            return { own: true, names: [nameOf(name, tool.toolName)] };
          });
        const direct = yield* Effect.forEach(chosen.direct, namesOf);
        const programs = yield* Effect.forEach(chosen.programs, namesOf);
        if (chosen.grouped && codemode === undefined) {
          return yield* new NotOnHarness({ kind: "tool", missing: "AI.CodeMode" });
        }
        if (programs.some((entry) => !entry.own)) {
          return yield* fail(
            "OpenCode's own tools (webfetch, websearch, subagent) run inside OpenCode and cannot be called from a program: list them outside AI.CodeMode(...).",
          );
        }
        const on = new Set<string>(direct.flatMap((entry) => entry.names));
        let programmed: ReadonlyArray<string> = [];
        if (chosen.grouped && codemode?.kind === "native") {
          if (direct.some((entry) => entry.own)) {
            return yield* fail(
              "OpenCode's own code mode reaches every tool of yours from programs. List them all inside AI.CodeMode(...), or provide AI.CodeModeAsync or AI.CodeModeEffect to offer some directly.",
            );
          }
          for (const entry of programs) for (const tool of entry.names) on.add(tool);
          on.add("execute");
        } else if (chosen.grouped) {
          programmed = [...new Set(programs.flatMap((entry) => entry.names))];
          on.add(nameOf(name, CODEMODE_TOOL));
        }
        if (skills.length > 0) on.add("skill");
        // What the model is told about programs: the tools one may call.
        const section =
          programmed.length === 0 || state.convention === undefined
            ? undefined
            : [
                "# Code mode",
                `The tools declared below are called only from programs, which the \`${nameOf(name, CODEMODE_TOOL)}\` tool runs.`,
                state.convention.heading,
                `\`\`\`ts\n${
                  state.convention.program(
                    namespaceOf(programmed.flatMap((tool) => state.programmed.get(tool) ?? [])),
                  ).declarations
                }\n\`\`\``,
              ].join("\n\n");
        return {
          // The wildcard comes first: a later rule wins.
          rules: [
            { action: "*", resource: "*", effect: "deny" },
            ...[...on].map((tool) => ({ action: tool, resource: "*", effect: "allow" })),
          ],
          section,
        };
      });

    /** The session settings last applied, as JSON, so an unchanged one is not sent again. */
    const applied = new Map<string, string>();
    const apply = (
      sessionID: string,
      key: string,
      value: unknown,
      send: (client: Host) => Promise<unknown>,
    ) =>
      Effect.suspend(() => {
        const json = JSON.stringify(value) ?? "null";
        if (applied.get(`${sessionID}:${key}`) === json) return Effect.void;
        return use(send, `set ${key}`).pipe(
          Effect.tap(() => Effect.sync(() => applied.set(`${sessionID}:${key}`, json))),
          Effect.asVoid,
        );
      });

    /** The text of the answer's steps. */
    const textOf = (messages: ReadonlyArray<Message>) =>
      messages
        .flatMap((message) =>
          message.type === "assistant"
            ? (message as AssistantMessage).content.flatMap((content) =>
                content.type === "text" && content.text !== undefined ? [content.text] : [],
              )
            : [],
        )
        .join("");

    /** One prompt at a time per session: a second waits for the first. */
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (session: string) => {
      let lock = locks.get(session);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(session, lock);
      }
      return lock;
    };
    /** Prompts given a `requestId`, by that id. */
    const prompts = new Map<string, Promise<Exit.Exit<Reply, OpenCodeError | NotOnHarness>>>();

    const onSandbox = (
      session: string,
      call: (
        sandboxes: Sandboxes["Service"],
        key: string,
      ) => Effect.Effect<unknown, unknown, RuntimeContext>,
    ) =>
      sandboxes === undefined
        ? Effect.void
        : Effect.suspend(() => {
            opened.delete(session);
            return call(sandboxes, sandboxKey(instanceId, session));
          }).pipe(
            Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)),
            Effect.asVoid,
          );

    const session = (sessionName: string, defaults: PromptOptions = {}): Session => {
      /** Give the session a prompt; `waits` says whether to stay for its answer. */
      const run = (text: string, chosen: PromptOptions, waits: boolean) =>
        Effect.gen(function* () {
          if (
            chosen.model !== undefined &&
            !models.some(({ model }) => model.modelName === chosen.model!.modelName)
          ) {
            return yield* new NotOnHarness({ kind: "model", missing: chosen.model.modelName });
          }
          const { rules, section } = yield* permissions(chosen.tools);
          const sessionID = yield* sessionIdOf(sessionName);
          // A prompt runs with what the session has: set what this one asks for.
          const model = { id: (chosen.model ?? models[0]!.model).modelName, providerID: name };
          yield* apply(sessionID, "model", model, (client) =>
            client.session.switchModel({ sessionID, model }),
          );
          const agent = chosen.agent ?? "build";
          yield* apply(sessionID, "agent", agent, (client) =>
            client.session.switchAgent({ sessionID, agent }),
          );
          yield* apply(sessionID, "permissions", rules, (client) =>
            client.session.update({ sessionID, permissions: rules as never }),
          );
          const entries = (client: Host) => client.experimental.session.instructions.entry;
          yield* apply(sessionID, "instructions", chosen.instructions ?? null, (client) =>
            chosen.instructions === undefined
              ? entries(client).remove({ sessionID, key: "alchemy" })
              : entries(client).put({ sessionID, key: "alchemy", value: chosen.instructions }),
          );
          yield* apply(sessionID, "codemode", section ?? null, (client) =>
            section === undefined
              ? entries(client).remove({ sessionID, key: "alchemy-codemode" })
              : entries(client).put({ sessionID, key: "alchemy-codemode", value: section }),
          );
          const before = (yield* transcript(sessionID)).length;
          yield* use((client) => client.session.prompt({ sessionID, text }), "prompt");
          yield* armWake(sessionID);
          if (!waits) return { text: "", messages: [] } satisfies Reply;
          yield* use((client) => client.experimental.session.wait({ sessionID }), "wait");
          const messages = (yield* transcript(sessionID)).slice(before);
          const idle = messages.findLast((message) => message.type === "idle") as
            | (Message & {
                readonly outcome: "succeeded" | "failed" | "interrupted";
                readonly error?: { readonly message?: string };
              })
            | undefined;
          if (idle !== undefined && idle.outcome !== "succeeded") {
            return yield* fail(idle.error?.message ?? `The prompt was ${idle.outcome}`, idle.error);
          }
          return { text: textOf(messages), messages } satisfies Reply;
        }).pipe(lockOf(sessionName).withPermits(1), Effect.ensuring(closeSoon));
      return {
        name: sessionName,
        sandboxKey: sandboxKey(instanceId, sessionName),
        id: sessionIdOf(sessionName),
        prompt: (text, promptOptions = {}) =>
          Effect.gen(function* () {
            const chosen = { ...defaults, ...promptOptions };
            if (chosen.requestId === undefined) return yield* run(text, chosen, true);
            // The first call runs the prompt; a retry waits for that run.
            yield* build;
            let running = prompts.get(chosen.requestId);
            if (running === undefined) {
              running = Effect.runPromiseExitWith(base!)(run(text, chosen, true));
              prompts.set(chosen.requestId, running);
            }
            return yield* yield* Effect.promise(() => running!);
          }),
        submit: (text, promptOptions = {}) =>
          Effect.asVoid(run(text, { ...defaults, ...promptOptions }, false)),
        wait: Effect.flatMap(sessionIdOf(sessionName), (sessionID) =>
          use((client) => client.experimental.session.wait({ sessionID }), "wait"),
        ).pipe(Effect.ensuring(closeSoon)),
        abort: Effect.flatMap(sessionIdOf(sessionName), (sessionID) =>
          Effect.asVoid(use((client) => client.session.interrupt({ sessionID }))),
        ),
        messages: Effect.flatMap(sessionIdOf(sessionName), transcript).pipe(
          Effect.ensuring(closeSoon),
        ),
        suspendSandbox: onSandbox(sessionName, (sandboxes, key) => sandboxes.suspend(key)),
        removeSandbox: onSandbox(sessionName, (sandboxes, key) => sandboxes.remove(key)),
      };
    };

    return { session, use } satisfies Harness;
    // Models, tools and servers are read by tag, so their requirements are stated by the signature.
  }) as unknown as Effect.Effect<
    Harness,
    never,
    Storage | ModelServices<Models> | ToolRequirements<Tools[number]>
  >;
