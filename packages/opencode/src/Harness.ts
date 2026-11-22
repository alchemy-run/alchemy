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
import { Sandbox, Sandboxes, sandboxOf, type SandboxHandle } from "@alchemy.run/ai/Sandbox";
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
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel, McpClient, Tool as AiToolSchema } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { NotOnHarness, OpenCodeError } from "./Errors.ts";
import { Instance } from "./Instance.ts";
import { complete, type ChatRequest } from "./internal/chat.ts";
import { BRIDGE, CALL, CLIENT, INSTALL, LAUNCH, OPENCODE, PORTS } from "./internal/scripts.ts";
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
   * The directory sessions work in.
   * @default the sandbox user's home
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
   * Makes the prompt exactly-once while its sandbox runs: a retry with the
   * same id waits for the original.
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
  /** A `tool` call's tool, as OpenCode names it (`shell`, `alchemy_add`, `execute`). */
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

/** One session: an OpenCode session in a sandbox of its own. */
export interface Session {
  readonly name: string;
  /**
   * The key the harness opens this session's sandbox with: what an
   * `AI.Sandboxes` Layer names or labels the sandbox by.
   */
  readonly sandboxKey: string;
  /** OpenCode's id for the session. Opens the sandbox. */
  readonly id: Effect.Effect<string, OpenCodeError, RuntimeContext>;
  /** Send a prompt and wait for the answer, through every tool call it takes. */
  readonly prompt: (
    text: string,
    options?: PromptOptions,
  ) => Effect.Effect<Reply, OpenCodeError | NotOnHarness, RuntimeContext>;
  /** Stop the prompt that is running. */
  readonly abort: Effect.Effect<void, OpenCodeError, RuntimeContext>;
  /** The session's transcript, oldest first. */
  readonly messages: Effect.Effect<ReadonlyArray<Message>, OpenCodeError, RuntimeContext>;
  /**
   * Stop the session's sandbox and keep its files, where its platform can
   * (`AI.Sandboxes`'s `suspend`). Its next call resumes it.
   */
  readonly suspendSandbox: Effect.Effect<void, OpenCodeError, RuntimeContext>;
  /**
   * Delete the session's sandbox (`AI.Sandboxes`'s `remove`), and the
   * session with it. Its next call starts both again, empty.
   */
  readonly removeSandbox: Effect.Effect<void, OpenCodeError, RuntimeContext>;
  /** Call OpenCode's own HTTP API in the session's sandbox, for what this view doesn't cover. */
  readonly request: (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, OpenCodeError, RuntimeContext>;
}

/** A harness: sessions, and the models, tools and skills they may use. */
export interface Harness {
  /**
   * The session with this name. Nothing runs until it is used: its first
   * call opens its sandbox and starts OpenCode there. `defaults` are what
   * its prompts run with unless they say otherwise.
   */
  readonly session: (name: string, defaults?: PromptOptions) => Session;
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

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));

/** The largest request body passed as a command argument; a larger one goes through a file. */
const ARGUMENT_BYTES = 48 * 1024;

interface BridgeTool {
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
  readonly servers: Readonly<Record<string, ReadonlyArray<BridgeTool>>>;
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
  readonly files: ReadonlyArray<readonly [path: string, content: string]>;
  readonly epoch: string;
}

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

interface Finished {
  readonly status: number;
  readonly body: string;
}

/** A session's sandbox, with OpenCode running in it and its requests followed. */
interface Connection {
  readonly handle: SandboxHandle;
  readonly sessionId: string;
  readonly call: (
    target: "opencode" | "bridge",
    method: string,
    path: string,
    body?: unknown,
  ) => Effect.Effect<Finished, OpenCodeError, RuntimeContext>;
  /** Prompts waiting for OpenCode to finish, by request id. */
  readonly waiting: Map<string, Deferred.Deferred<Finished, OpenCodeError>>;
  /** The session settings last applied, as JSON, so an unchanged one is not sent again. */
  readonly applied: Map<string, string>;
  readonly close: Effect.Effect<void>;
}

/**
 * An OpenCode harness. OpenCode is a program, so each session runs it in a
 * sandbox of its own (`AI.Sandboxes`); the harness, where you yield it,
 * answers its model requests with your `AI.Model` Layers and runs your
 * `AI.Tool` handlers. No API key and no inbound address is put in the
 * sandbox: OpenCode's requests are relayed over the sandbox's own exec.
 *
 * Yield it where the runtime's dependencies are resolved (a Durable
 * Object's outer Effect): the models, tools and sandboxes it needs are
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
  Instance | Sandboxes | ModelServices<Models> | ToolRequirements<Tools[number]>
> =>
  Effect.gen(function* () {
    const name = options.name ?? "alchemy";
    const instanceId = yield* (yield* Instance).id;
    const sandboxes = yield* Sandboxes;

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
    // A tool tag is whatever its Layer provided: OpenCode's own tool of
    // that name, or a tool of yours that the bridge serves.
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
          const ownTools: ReadonlyArray<BridgeTool> = [
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
          const bridgeServers: Record<string, ReadonlyArray<BridgeTool>> = {
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
          const config = {
            ...options.config,
            autoupdate: false,
            share: "disabled",
            permission: "allow",
            model: `${name}/${models[0]!.model.modelName}`,
            small_model: `${name}/${models[0]!.model.modelName}`,
            skills: { paths: ["~/.alchemy/opencode/skills"] },
            provider: {
              ...(options.config?.provider as object | undefined),
              [name]: {
                npm: "@ai-sdk/openai-compatible",
                name,
                options: { baseURL: `http://127.0.0.1:${PORTS.bridge}/v1`, apiKey: name },
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
            mcp: {
              ...(options.config?.mcp as object | undefined),
              ...Object.fromEntries(
                Object.keys(bridgeServers).map((server) => [
                  server,
                  {
                    type: "remote",
                    url: `http://127.0.0.1:${PORTS.bridge}/mcp/${server}`,
                    oauth: false,
                  },
                ]),
              ),
            },
          };
          const files: Array<readonly [string, string]> = [
            ["bridge.js", BRIDGE],
            ["call.js", CLIENT],
            ["opencode.json", JSON.stringify(config)],
            ...skills.flatMap((skill) => [
              [
                `skills/${skill.skillName}/SKILL.md`,
                `---\nname: ${skill.skillName}\ndescription: ${JSON.stringify(skill.skill.description)}\n---\n\n${skill.skill.instructions}\n`,
              ] as const,
              ...Object.entries(skill.skill.files ?? {}).map(
                ([path, content]) => [`skills/${skill.skillName}/${path}`, content] as const,
              ),
            ]),
          ];
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([OPENCODE.version, options.cwd, bridgeServers, files]),
              ),
            ),
          );
          const epoch = [...new Uint8Array(digest).subarray(0, 8)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          files.push([
            "bridge.json",
            JSON.stringify({
              epoch,
              port: PORTS.bridge,
              opencodePort: PORTS.opencode,
              servers: bridgeServers,
              ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            }),
          ]);
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
            servers: bridgeServers,
            call,
            programmed,
            ...(program === undefined ? {} : { convention: program.convention }),
            files,
            epoch,
          } satisfies Built;
        });
        built = Effect.runPromiseWith(context)(make);
      }
      return yield* Effect.tryPromise({
        try: () => built!,
        catch: (cause) => fail(messageOf(cause), cause),
      }).pipe(Effect.tapError(() => Effect.sync(() => (built = undefined))));
    });

    const connections = new Map<string, Promise<Connection>>();

    const connect = (session: string) =>
      Effect.gen(function* () {
        const state = yield* build;
        const run = Effect.runForkWith(base!);
        const handle = yield* sandboxes
          .open(sandboxKey(instanceId, session))
          .pipe(Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)));
        const exec = (command: readonly [string, ...string[]], timeout: string) =>
          handle.exec(command, { timeout }).pipe(
            Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)),
            Effect.map((result) => ({
              exitCode: result.exitCode ?? 0,
              stdout: result.stdout ?? result.result ?? "",
              stderr: result.stderr ?? "",
            })),
          );

        // Install OpenCode, and learn where the harness keeps its files and
        // which configuration the sandbox last ran with.
        const installed = yield* exec(
          [
            "sh",
            "-c",
            `${INSTALL}\nprintf 'oc-dir:%s\\n' "$dir"\nprintf 'oc-epoch:%s\\n' "$(cat "$dir/epoch" 2>/dev/null)"`,
          ],
          "5 minutes",
        );
        const dir = /^oc-dir:(.+)$/m.exec(installed.stdout)?.[1]?.trim();
        if (installed.exitCode !== 0 || dir === undefined) {
          return yield* fail(
            `OpenCode install exited ${installed.exitCode}: ${installed.stderr.trim() || installed.stdout.trim()}`,
          );
        }
        const files = sandboxOf(handle);
        if (/^oc-epoch:(.*)$/m.exec(installed.stdout)?.[1]?.trim() !== state.epoch) {
          yield* Effect.forEach(
            [...state.files, ["epoch", state.epoch] as const],
            ([path, content]) => files.writeFile(`${dir}/${path}`, content),
            { discard: true },
          ).pipe(Effect.mapError((cause) => fail(`Sandbox: ${cause.message}`, cause)));
        }

        const call: Connection["call"] = (target, method, path, body) =>
          Effect.gen(function* () {
            const text = body === undefined ? undefined : JSON.stringify(body);
            let argument: ReadonlyArray<string> = [];
            if (text !== undefined && text.length > ARGUMENT_BYTES) {
              // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect -- only a unique file name
              const file = `${dir}/body-${crypto.randomUUID()}`;
              yield* files
                .writeFile(file, text)
                .pipe(Effect.mapError((cause) => fail(`Sandbox: ${cause.message}`, cause)));
              argument = [`@${file}`];
            } else if (text !== undefined) {
              argument = [toBase64(text)];
            }
            const result = yield* exec(
              ["sh", "-c", CALL, "call", target, method, path, ...argument],
              "2 minutes",
            );
            const line = /^oc:([A-Za-z0-9+/=]+)\r?$/m.exec(result.stdout)?.[1];
            if (line === undefined) {
              return yield* fail(
                `OpenCode ${method} ${path}: no answer (${result.stderr.trim() || `exit ${result.exitCode}`})`,
              );
            }
            const answer = JSON.parse(fromBase64(line)) as Finished;
            if (answer.status === 0) {
              return yield* fail(`OpenCode ${method} ${path}: ${answer.body}`);
            }
            return answer;
          });

        // Start the bridge, and OpenCode under it, unless this configuration is already running.
        const healthy = yield* call("bridge", "GET", "/_health").pipe(
          Effect.map(
            (answer) => (JSON.parse(answer.body) as { epoch?: string }).epoch === state.epoch,
          ),
          Effect.orElseSucceed(() => false),
        );
        const scope = yield* Scope.make();
        if (!healthy) {
          yield* handle.start(["sh", "-c", LAUNCH]).pipe(
            Scope.provide(scope),
            Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)),
          );
          const ready = yield* exec(["sh", "-c", CALL, "call", "wait", state.epoch], "90 seconds");
          if (
            !/^oc:/m.test(ready.stdout) ||
            !ready.stdout.includes(toBase64('{"status":200').slice(0, 12))
          ) {
            const log = yield* exec(
              ["sh", "-c", `tail -c 2000 "${dir}/bridge.log"`],
              "30 seconds",
            ).pipe(
              Effect.map((result) => result.stdout),
              Effect.orElseSucceed(() => ""),
            );
            return yield* fail(`OpenCode did not start: ${log.trim() || ready.stderr.trim()}`);
          }
        }

        // The session is the one titled after its name; a new sandbox has none yet.
        const title = `alchemy:${session}`;
        const existing = yield* call(
          "opencode",
          "GET",
          `/api/session?search=${encodeURIComponent(title)}&limit=100`,
        ).pipe(Effect.flatMap((answer) => ok(answer, "list sessions")));
        const found = (
          existing as { readonly data: ReadonlyArray<{ id: string; title?: string }> }
        ).data.find((candidate) => candidate.title === title);
        const sessionId =
          found?.id ??
          (
            (yield* call("opencode", "POST", "/api/session", { title }).pipe(
              Effect.flatMap((answer) => ok(answer, "create session")),
            )) as { readonly data: { readonly id: string } }
          ).data.id;

        const waiting: Connection["waiting"] = new Map();
        const answer = (request: {
          readonly id: string;
          readonly kind: "model" | "tool" | "done";
          readonly [key: string]: unknown;
        }) =>
          Effect.gen(function* () {
            switch (request.kind) {
              case "model": {
                const body = request.body as ChatRequest;
                const model = state.models.get(body.model);
                if (model === undefined) return { error: `No model ${body.model} on this harness` };
                return yield* complete(model, body).pipe(
                  Effect.catchCause((cause) =>
                    Effect.succeed({ error: messageOf(cause.pipe(Cause.squash)) }),
                  ),
                );
              }
              case "tool":
                return yield* state.call(
                  request.server as string,
                  request.name as string,
                  request.arguments,
                  Context.make(ToolCall, { conversationId: session, callId: request.id }).pipe(
                    Context.add(Sandbox, files),
                  ),
                );
              case "done": {
                const waiter = waiting.get(request.requestId as string);
                if (waiter !== undefined) {
                  waiting.delete(request.requestId as string);
                  yield* Deferred.succeed(waiter, {
                    status: request.status as number,
                    body: request.body as string,
                  });
                }
                return {};
              }
            }
          }).pipe(
            Effect.flatMap((reply) => call("bridge", "POST", `/_reply/${request.id}`, reply)),
            Effect.ignore,
          );

        // Follow the bridge's requests for as long as the sandbox runs.
        const inFlight = new Set<string>();
        let frames: Array<string> = [];
        let text = "";
        const decoder = new TextDecoder();
        const receive = (data: Uint8Array) => {
          text += decoder.decode(data, { stream: true });
          const lines = text.split("\n");
          text = lines.pop() ?? "";
          for (const raw of lines) {
            const line = raw.replace(/\r$/, "");
            if (line === "oc.") {
              const request = JSON.parse(fromBase64(frames.join(""))) as Parameters<
                typeof answer
              >[0];
              frames = [];
              if (inFlight.has(request.id)) continue;
              inFlight.add(request.id);
              run(answer(request));
            } else if (line.startsWith("oc:")) {
              frames.push(line.slice(3));
            }
          }
        };
        const follower = yield* handle.start(["sh", "-c", CALL, "call", "follow"]).pipe(
          Scope.provide(scope),
          Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)),
        );
        const close = Effect.suspend(() => {
          connections.delete(session);
          const lost = [...waiting.values()];
          waiting.clear();
          return Effect.forEach(
            lost,
            (waiter) => Deferred.fail(waiter, fail("The session's sandbox stopped answering")),
            { discard: true },
          ).pipe(Effect.andThen(Scope.close(scope, Exit.void)));
        });
        run(
          follower.output.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                if (chunk.fd === "stdout") receive(chunk.data);
              }),
            ),
            Effect.ignore,
            Effect.andThen(close),
          ),
        );
        return { handle, sessionId, call, waiting, applied: new Map(), close } satisfies Connection;
      });

    const connection = (session: string) =>
      Effect.gen(function* () {
        let opening = connections.get(session);
        if (opening === undefined) {
          const context = yield* Effect.context<RuntimeContext>();
          opening = Effect.runPromiseWith(Context.omit(Scope.Scope)(context) as typeof context)(
            connect(session),
          );
          connections.set(session, opening);
          opening.catch(() => {
            if (connections.get(session) === opening) connections.delete(session);
          });
        }
        return yield* Effect.tryPromise({
          try: () => opening!,
          catch: (cause) => fail(messageOf(cause), cause),
        });
      });

    const disconnect = (session: string) =>
      Effect.suspend(() => {
        const opening = connections.get(session);
        if (opening === undefined) return Effect.void;
        return Effect.promise(() =>
          opening.then(
            (open) => open,
            () => undefined,
          ),
        ).pipe(Effect.flatMap((open) => (open === undefined ? Effect.void : open.close)));
      });

    const ok = (answer: Finished, what: string) =>
      answer.status >= 200 && answer.status < 300
        ? Effect.succeed(answer.body.length > 0 ? (JSON.parse(answer.body) as unknown) : undefined)
        : Effect.fail(fail(`OpenCode ${what}: ${answer.status} ${answer.body.slice(0, 500)}`));

    /**
     * The session's permissions: every tool denied, then the chosen ones
     * allowed. A sandbox image can bring OpenCode tools of its own; a prompt
     * only gets what its harness lists.
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
        /** The names OpenCode knows a listed tool by; ours go through the bridge. */
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
            "OpenCode's own tools (shell, read, edit, …) run inside OpenCode and cannot be called from a program: list them outside AI.CodeMode(...).",
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

    /** Apply one session setting, unless it is what the session already has. */
    const apply = (
      open: Connection,
      key: string,
      value: unknown,
      send: Effect.Effect<Finished, OpenCodeError, RuntimeContext>,
    ) =>
      Effect.suspend(() => {
        const json = JSON.stringify(value) ?? "null";
        if (open.applied.get(key) === json) return Effect.void;
        return send.pipe(
          Effect.flatMap((answer) => ok(answer, `set ${key}`)),
          Effect.tap(() => Effect.sync(() => open.applied.set(key, json))),
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

    const session = (sessionName: string, defaults: PromptOptions = {}): Session => ({
      name: sessionName,
      sandboxKey: sandboxKey(instanceId, sessionName),
      id: Effect.map(connection(sessionName), (open) => open.sessionId),
      prompt: (text, promptOptions = {}) =>
        Effect.gen(function* () {
          const chosen = { ...defaults, ...promptOptions };
          if (
            chosen.model !== undefined &&
            !models.some(({ model }) => model.modelName === chosen.model!.modelName)
          ) {
            return yield* new NotOnHarness({ kind: "model", missing: chosen.model.modelName });
          }
          const { rules, section } = yield* permissions(chosen.tools);
          const open = yield* connection(sessionName);
          const path = `/api/session/${open.sessionId}`;
          // A prompt runs with what the session has: set what this one asks for.
          const model = { id: (chosen.model ?? models[0]!.model).modelName, providerID: name };
          yield* apply(
            open,
            "model",
            model,
            open.call("opencode", "POST", `${path}/model`, { model }),
          );
          const agent = chosen.agent ?? "build";
          yield* apply(
            open,
            "agent",
            agent,
            open.call("opencode", "POST", `${path}/agent`, { agent }),
          );
          yield* apply(
            open,
            "permissions",
            rules,
            open.call("opencode", "PATCH", path, { permissions: rules }),
          );
          const entry = `/api/experimental/session/${open.sessionId}/instructions/entries/alchemy`;
          yield* apply(
            open,
            "instructions",
            chosen.instructions ?? null,
            chosen.instructions === undefined
              ? open.call("opencode", "DELETE", entry)
              : open.call("opencode", "PUT", entry, { value: chosen.instructions }),
          );
          const catalog = `/api/experimental/session/${open.sessionId}/instructions/entries/alchemy-codemode`;
          yield* apply(
            open,
            "codemode",
            section ?? null,
            section === undefined
              ? open.call("opencode", "DELETE", catalog)
              : open.call("opencode", "PUT", catalog, { value: section }),
          );
          // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect -- only a unique id for a prompt that gave none
          const requestId = chosen.requestId ?? crypto.randomUUID();
          let waiter = open.waiting.get(requestId);
          if (waiter === undefined) {
            waiter = yield* Deferred.make<Finished, OpenCodeError>();
            open.waiting.set(requestId, waiter);
          }
          const admitted = (yield* open
            .call("bridge", "POST", "/_prompt", {
              requestId,
              sessionId: open.sessionId,
              body: { text },
            })
            .pipe(Effect.flatMap((answer) => ok(answer, "prompt")))) as {
            readonly finished?: Finished;
          };
          // A retry of a prompt that already finished is given its answer again.
          if (admitted.finished !== undefined) open.waiting.delete(requestId);
          const finished = admitted.finished ?? (yield* Deferred.await(waiter));
          const { messages } = (yield* ok(finished, "prompt")) as {
            readonly messages: ReadonlyArray<Message>;
          };
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
        }),
      abort: Effect.flatMap(connection(sessionName), (open) =>
        Effect.asVoid(
          Effect.flatMap(
            open.call("opencode", "POST", `/api/session/${open.sessionId}/interrupt`),
            (answer) => ok(answer, "interrupt"),
          ),
        ),
      ),
      messages: Effect.flatMap(connection(sessionName), (open) =>
        Effect.gen(function* () {
          const messages: Array<Message> = [];
          let query = "order=asc&limit=200";
          for (;;) {
            const page = (yield* open
              .call("opencode", "GET", `/api/session/${open.sessionId}/message?${query}`)
              .pipe(Effect.flatMap((answer) => ok(answer, "messages")))) as {
              readonly data: ReadonlyArray<Message>;
              readonly cursor?: { readonly next?: string | null };
            };
            messages.push(...page.data);
            if (!page.cursor?.next) return messages as ReadonlyArray<Message>;
            query = `cursor=${encodeURIComponent(page.cursor.next)}`;
          }
        }),
      ),
      suspendSandbox: disconnect(sessionName).pipe(
        Effect.andThen(sandboxes.suspend(sandboxKey(instanceId, sessionName))),
        Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)),
        Effect.asVoid,
      ),
      removeSandbox: disconnect(sessionName).pipe(
        Effect.andThen(sandboxes.remove(sandboxKey(instanceId, sessionName))),
        Effect.mapError((cause) => fail(`Sandbox: ${messageOf(cause)}`, cause)),
        Effect.asVoid,
      ),
      request: (method, path, body) =>
        Effect.flatMap(connection(sessionName), (open) =>
          Effect.flatMap(open.call("opencode", method, path, body), (answer) =>
            ok(answer, `${method} ${path}`),
          ),
        ),
    });

    return { session } satisfies Harness;
    // Models, tools and servers are read by tag, so their requirements are stated by the signature.
  }) as unknown as Effect.Effect<
    Harness,
    never,
    Instance | Sandboxes | ModelServices<Models> | ToolRequirements<Tools[number]>
  >;
