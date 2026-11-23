import { CodeModeConvention, isCodeMode, type CodeModeGroup } from "@alchemy.run/ai/CodeMode";
import type { JsonSchema } from "@alchemy.run/ai/Declarations";
import {
  isMcpServer,
  type AnyMcpServer,
  type McpServerClass,
  type McpServerService,
} from "@alchemy.run/ai/McpServer";
import type { AnyModel, ModelService } from "@alchemy.run/ai/Model";
import { Sandboxes } from "@alchemy.run/ai/Sandbox";
import type { ToolSpec, ToolTagService } from "@alchemy.run/ai/Tool";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  GenerationTask,
  hook,
  section,
  ToolTask,
  type Extension as PiExtension,
  type HookRegistration,
  type PromptSection,
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
import { LanguageModel, McpClient } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CODEMODE_TOOL, makeExtension as makeCodeMode, type Programmed } from "./CodeMode.ts";
import { ConversationNotFound, NotOnHarness, PiError } from "./Errors.ts";
import type { AnyExtension, ExtensionImpl, ExtensionRequirements } from "./Extension.ts";
import { mcpExtensionName, mcpRegistrations, mcpToolName } from "./internal/mcp.ts";
import { fromPi, messageOf } from "./internal/promise.ts";
import { makeProvider } from "./internal/provider.ts";
import { makeEnvFor, sandboxKey } from "./Sandbox.ts";
import { Storage } from "./Storage.ts";
import {
  ENGINE,
  flattenTools,
  kindOf,
  toRegistration,
  type AnyTool,
  type NativeTool,
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

/** What a harness lists as a tool: a tool, an MCP server, or a code mode group of them. */
export type Listed = AnyTool | AnyMcpServer | CodeModeGroup<ReadonlyArray<AnyTool | AnyMcpServer>>;

/** Options of {@link Harness}. */
export interface HarnessOptions<
  Models extends ReadonlyArray<AnyModel>,
  Tools extends ReadonlyArray<Listed>,
  Extensions extends ReadonlyArray<AnyExtension> = readonly [],
> {
  /**
   * Distinguishes several harnesses in one Durable Object: each keeps its
   * tables under its own prefix.
   * @default "pi"
   */
  readonly name?: string;
  /** Every model a conversation may run on. The first is the default. */
  readonly models: Models;
  /**
   * Every tool a conversation may be given. An MCP server gives every tool
   * it lists when an instance opens, named `mcp__<server>__<tool>`.
   *
   * Tools inside `AI.CodeMode(...)` are reached from programs the model
   * writes; the others are direct calls. A tool listed both ways is offered
   * both ways.
   */
  readonly tools?: Tools;
  /**
   * Every extension a conversation may select. Each is selected by default.
   */
  readonly extensions?: Extensions;
  /** Pi's run policy: retries, compaction, tool execution, queue modes. */
  readonly settings?: Omit<HarnessSettings, "extensions">;
}

/** What a conversation enables: a tool, an MCP server, or a code mode group of them. */
export type Enabled = ToolRef | AnyMcpServer | CodeModeGroup<ReadonlyArray<AnyTool | AnyMcpServer>>;

/** What a conversation runs with. Unset fields keep their current value; `null` restores the harness default. */
export interface AgentOptions {
  readonly model?: AnyModel | null;
  readonly thinkingLevel?: ModelThinkingLevel | null;
  /**
   * The tools the conversation may use: exactly these, or `add`/`remove`
   * relative to what it has now. An MCP server stands for all of its tools.
   * An `AI.CodeMode(...)` group stands for its tools and the tool that
   * runs programs: an exact list without one turns code mode off.
   */
  readonly tools?:
    | ReadonlyArray<Enabled>
    | {
        readonly add?: ReadonlyArray<Enabled>;
        readonly remove?: ReadonlyArray<Enabled>;
      }
    | null;
  /**
   * The extensions the conversation selects: exactly these, or
   * `add`/`remove` relative to the harness default. Adding one enables the
   * tools it brings.
   */
  readonly extensions?:
    | ReadonlyArray<AnyExtension>
    | {
        readonly add?: ReadonlyArray<AnyExtension>;
        readonly remove?: ReadonlyArray<AnyExtension>;
      }
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
  /**
   * The key the harness opens this conversation's sandbox with: what an
   * `AI.Sandboxes` Layer names or labels the sandbox by.
   */
  readonly sandboxKey: string;
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
  /**
   * Stop the conversation's sandbox and keep its files, where its platform
   * can (`AI.Sandboxes`'s `suspend`). Its next tool call resumes it. Does
   * nothing on a harness without a sandbox.
   */
  readonly suspendSandbox: Effect.Effect<void, PiError, RuntimeContext>;
  /**
   * Delete the conversation's sandbox (`AI.Sandboxes`'s `remove`). Its next
   * tool call opens a new one. Does nothing on a harness without a sandbox.
   */
  readonly removeSandbox: Effect.Effect<void, PiError, RuntimeContext>;
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
  /**
   * Submit to the conversation with this name: `conversationByName`, then
   * `submit`.
   */
  readonly submit: (
    name: string,
    draft: SubmissionDraft,
  ) => Effect.Effect<Submission, PiError | ConversationNotFound, RuntimeContext>;
  /** Change what the named conversation runs with, from its next model request. */
  readonly configure: (
    name: string,
    options: AgentOptions,
  ) => Effect.Effect<void, PiError | ConversationNotFound | NotOnHarness, RuntimeContext>;
  /** Stop the named conversation: withdraw queued inputs, abort running work, wait until idle. */
  readonly abort: (
    name: string,
    options?: { readonly background?: boolean },
  ) => Effect.Effect<void, PiError | ConversationNotFound, RuntimeContext>;
  /**
   * Stop the named conversation's sandbox and keep its files, where its
   * platform can. Its next tool call resumes it.
   */
  readonly suspendSandbox: (
    name: string,
  ) => Effect.Effect<void, PiError | ConversationNotFound, RuntimeContext>;
  /** Delete the named conversation's sandbox. Its next tool call opens a new one. */
  readonly removeSandbox: (
    name: string,
  ) => Effect.Effect<void, PiError | ConversationNotFound, RuntimeContext>;
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

/** What listing `T` in a harness's `tools` requires to be provided. */
type ListedRequirements<T> =
  T extends CodeModeGroup<infer Inner>
    ? CodeModeConvention | ListedRequirements<Inner[number]>
    : T extends McpServerClass<infer Self, any>
      ? Self
      : ToolRequirements<T>;

/** The extension the harness's own tools are installed in; always selected. */
const BASE_EXTENSION = "alchemy";

/** How long one alarm keeps working before it hands off to the next. */
const ALARM_SLICE = "10 minutes";

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
 *     const harness = yield* Pi.Harness({ models: [Smart], tools: [AI.CodingTools, RunTests] });
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
  const Tools extends ReadonlyArray<Listed> = readonly [],
  const Extensions extends ReadonlyArray<AnyExtension> = readonly [],
>(
  options: HarnessOptions<Models, Tools, Extensions>,
): Effect.Effect<
  Harness,
  never,
  | Storage
  | ModelServices<Models>
  | ListedRequirements<Tools[number]>
  | ExtensionRequirements<Extensions[number]>
> =>
  Effect.gen(function* () {
    const prefix = `${options.name ?? "pi"}_`;
    const storage = yield* (yield* Storage).instance;
    // Where tools find files and a shell: the harness's own `AI.Sandboxes`,
    // or the one a coding tool's Layer was given. A harness without either
    // runs only tools that need neither.
    let sandbox = Option.getOrUndefined(yield* Effect.serviceOption(Sandboxes));

    // Resolve every model and tool implementation here, where their Layers
    // (and the bindings those declare) are provided.
    const models = yield* Effect.forEach(options.models, (model) =>
      Effect.map(Effect.service(model as Context.Key<unknown, ModelService>), (languageModel) => ({
        model,
        languageModel,
      })),
    );
    const resolveTools = (list: ReadonlyArray<AnyTool>) =>
      Effect.forEach(flattenTools(list), (tool) => {
        switch (kindOf(tool)) {
          case "tag":
            return Effect.flatMap(
              Effect.service(tool as unknown as Context.Key<unknown, ToolTagService>),
              (impl) => {
                if (impl.kind === "tool") {
                  return Effect.succeed({
                    tool: { toolName: tool.toolName, spec: impl.spec } as unknown as ToolRef,
                    handler: impl.handler as any,
                  });
                }
                if (impl.engine !== ENGINE) {
                  return Effect.die(
                    new PiError({
                      message: `AI.Tool/${tool.toolName} was given ${impl.engine}'s tool, which only runs on that harness. Provide a Pi Layer for it (Pi.CodingTools) or your own.`,
                    }),
                  );
                }
                const own = impl.tool as NativeTool;
                sandbox ??= own.sandboxes;
                return Effect.succeed({
                  tool: {
                    toolName: tool.toolName,
                    registration: own.registration,
                  } as unknown as ToolRef,
                  handler: undefined as any,
                });
              },
            );
          case "inline":
            return Effect.succeed({ tool, handler: (tool as { handler: any }).handler });
          default: {
            const cls = tool as unknown as { impl?: Effect.Effect<any> } & Context.Key<
              unknown,
              any
            >;
            return Effect.map(cls.impl ?? Effect.service(cls), (handler) => ({ tool, handler }));
          }
        }
      });
    // A tool is reached directly, from a program, or both, by where it is listed.
    const every: ReadonlyArray<Listed> = options.tools ?? [];
    const groups = every.filter(
      (tool): tool is CodeModeGroup<ReadonlyArray<AnyTool | AnyMcpServer>> => isCodeMode(tool),
    );
    const directly = every.filter((tool): tool is AnyTool | AnyMcpServer => !isCodeMode(tool));
    const inPrograms = groups.flatMap((group) => group.tools) as ReadonlyArray<
      AnyTool | AnyMcpServer
    >;
    const namesIn = (list: ReadonlyArray<AnyTool | AnyMcpServer>) => ({
      tools: new Set(
        flattenTools(list.filter((tool): tool is AnyTool => !isMcpServer(tool))).map(
          (tool) => tool.toolName,
        ),
      ),
      servers: new Set(list.filter(isMcpServer).map((server) => server.serverName)),
    });
    const direct = namesIn(directly);
    const programs = namesIn(inPrograms);
    /** Who may call a tool: Pi offers it to both unless told otherwise. */
    const callersOf = (
      where: "tools" | "servers",
      name: string,
    ): { readonly callers?: ReadonlyArray<"model" | "tools"> } =>
      groups.length === 0 || (direct[where].has(name) && programs[where].has(name))
        ? {}
        : { callers: programs[where].has(name) ? ["tools"] : ["model"] };
    const codemode = groups.length === 0 ? undefined : yield* CodeModeConvention;
    if (codemode?.kind === "native") {
      return yield* Effect.die(
        new PiError({
          message: `Pi was given ${codemode.engine}'s code mode, which only runs on that harness. Provide AI.CodeModeAsync or AI.CodeModeEffect over an AI.Eval.`,
        }),
      );
    }
    const unique = <T>(list: ReadonlyArray<T>, key: (item: T) => string) => [
      ...new Map(list.map((item) => [key(item), item] as const)).values(),
    ];
    const listed: ReadonlyArray<AnyTool | AnyMcpServer> = [...directly, ...inPrograms];
    const tools = unique(
      yield* resolveTools(listed.filter((tool): tool is AnyTool => !isMcpServer(tool))),
      ({ tool }) => tool.toolName,
    );
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
    /** Each server's tools, by name: known once an instance has opened and asked it. */
    const serverTools = new Map<string, ReadonlyArray<string>>();
    const extensions = yield* Effect.forEach(options.extensions ?? [], (extension) =>
      Effect.gen(function* () {
        const impl: ExtensionImpl | undefined = extension.impl
          ? yield* extension.impl
          : Option.getOrUndefined(
              yield* Effect.serviceOption(
                extension as unknown as Context.Key<unknown, ExtensionImpl>,
              ),
            );
        return {
          extension,
          impl,
          tools: yield* resolveTools(extension.spec.tools ?? []),
        };
      }),
    );
    const sandboxes = sandbox;
    const envFor = sandboxes === undefined ? undefined : makeEnvFor(sandboxes);
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

    const toolByName = new Map<string, ToolRef>([
      ...[...tools, ...extensions.flatMap((extension) => extension.tools)].map(
        ({ tool }) => [tool.toolName, tool] as const,
      ),
      ...(codemode !== undefined
        ? [[CODEMODE_TOOL, { toolName: CODEMODE_TOOL } as ToolRef] as const]
        : []),
    ]);

    /** The tools selecting these extensions enables: their own, and the one that drives them. */
    const broughtBy = (selected: ReadonlyArray<AnyExtension>): ReadonlyArray<ToolRef> =>
      selected.flatMap((extension) => flattenTools(extension.spec.tools ?? []));
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
          Effect.runPromiseExitWith(base)(effect, signal ? { signal } : undefined);
        const runTool: RunTool = (effect, services, signal) =>
          Effect.runPromiseExitWith(Context.merge(base, services) as Context.Context<any>)(
            Effect.scoped(effect),
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
        const compile = ({ tool, handler }: { tool: ToolRef; handler: any }): ToolRegistration =>
          handler === undefined
            ? (tool as unknown as { registration: ToolRegistration }).registration
            : toRegistration(tool.toolName, (tool as { spec: any }).spec, handler, runTool);
        const runHook = <A>(effect: Effect.Effect<A, never, any>) =>
          Effect.runPromiseWith(base as Context.Context<any>)(effect);

        const baseExtension: PiExtension = {
          name: BASE_EXTENSION,
          tools: tools.map((entry) => ({
            ...compile(entry),
            ...callersOf("tools", entry.tool.toolName),
          })),
        };
        const piExtensions: PiExtension[] = extensions.map(({ extension, impl, tools }) => {
          const sections: PromptSection[] = [
            ...Object.entries(extension.spec.sections ?? {}).map(([key, text]) =>
              section(key, () => text),
            ),
            ...Object.entries(impl?.sections ?? {}).map(([key, render]) =>
              section(key, (input) => runHook(render({ conversationId: input.conversationId }))),
            ),
          ];
          const hooks: HookRegistration[] = [];
          const toolHooks = impl?.hooks;
          if (toolHooks?.beforeTool || toolHooks?.afterTool) {
            hooks.push(
              hook(ToolTask, {
                ...(toolHooks.beforeTool
                  ? { beforeTool: (call) => runHook(toolHooks.beforeTool!(call)) }
                  : {}),
                ...(toolHooks.afterTool
                  ? { afterTool: (call, result) => runHook(toolHooks.afterTool!(call, result)) }
                  : {}),
              }),
            );
          }
          if (toolHooks?.beforeRequest || toolHooks?.afterResponse || toolHooks?.onYield) {
            hooks.push(
              hook(GenerationTask, {
                ...(toolHooks.beforeRequest
                  ? {
                      beforeRequest: (request) =>
                        runHook(toolHooks.beforeRequest!(request)) as never,
                    }
                  : {}),
                ...(toolHooks.afterResponse
                  ? { afterResponse: (message) => runHook(toolHooks.afterResponse!(message)) }
                  : {}),
                ...(toolHooks.onYield
                  ? { onYield: (answer) => runHook(toolHooks.onYield!(answer)) }
                  : {}),
              }),
            );
          }
          return { name: extension.extensionName, tools: tools.map(compile), sections, hooks };
        });
        // Each server is asked for its tools once per instance. Like a
        // model's, its client's scope is never closed.
        const buildServers = Effect.gen(function* () {
          const scope = yield* Scope.make();
          return yield* Effect.forEach(servers, ({ server, client }) =>
            Effect.gen(function* () {
              const built = yield* Layer.buildWithScope(client, scope);
              const registrations = yield* mcpRegistrations(
                server.serverName,
                Context.get(built, McpClient.McpClient),
                runModel,
              );
              return {
                name: mcpExtensionName(server.serverName),
                tools: registrations.map((registration) => ({
                  ...registration,
                  ...callersOf("servers", server.serverName),
                })) as ToolRegistration[],
              } satisfies PiExtension;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PiError({
                    message: `MCP server ${server.serverName}: ${messageOf(cause)}`,
                    cause,
                  }),
              ),
            ),
          );
        }).pipe(Effect.provideContext(base));
        const registry = createRegistry();
        registry.install(baseExtension);
        for (const extension of piExtensions) registry.install(extension);
        /** Code mode over the tools programs reach, once each server has listed its own. */
        const buildCodemode = (mcp: ReadonlyArray<PiExtension>) =>
          codemode === undefined
            ? Effect.succeed([])
            : Effect.gen(function* () {
                const programmed = new Map<string, Programmed>();
                for (const entry of tools) {
                  const name = entry.tool.toolName;
                  if (!programs.tools.has(name)) continue;
                  const spec = (entry.tool as { spec?: ToolSpec }).spec;
                  const registration = compile(entry);
                  programmed.set(name, {
                    tool:
                      entry.handler === undefined || spec === undefined
                        ? {
                            name,
                            description: registration.description,
                            parameters: registration.parameters as JsonSchema,
                            ...(registration.structuredOutputSchema === undefined
                              ? {}
                              : { success: registration.structuredOutputSchema as JsonSchema }),
                          }
                        : {
                            name,
                            description: spec.description,
                            parameters: spec.parameters,
                            success: spec.success,
                            ...(spec.failure === undefined ? {} : { failure: spec.failure }),
                          },
                  });
                }
                for (const [index, extension] of mcp.entries()) {
                  const server = servers[index]!.server.serverName;
                  if (!programs.servers.has(server)) continue;
                  for (const registration of extension.tools ?? []) {
                    programmed.set(registration.name, {
                      namespace: server,
                      tool: {
                        name: registration.name.slice(mcpToolName(server, "").length),
                        callAs: registration.name,
                        description: registration.description,
                        parameters: registration.parameters as JsonSchema,
                        ...(registration.structuredOutputSchema === undefined
                          ? {}
                          : { success: registration.structuredOutputSchema as JsonSchema }),
                      },
                    });
                  }
                }
                const convention = yield* codemode.convention.pipe(
                  Effect.mapError(
                    (cause) => new PiError({ message: `Code mode: ${cause.message}`, cause }),
                  ),
                );
                return [
                  yield* makeCodeMode(
                    codemode.evaluator,
                    convention,
                    programmed,
                    base as Context.Context<RuntimeContext>,
                  ),
                ];
              }).pipe(Effect.provideContext(base));
        // Selected by default: the base and every extension.
        const defaultExtensions = [baseExtension, ...piExtensions];

        opened = Effect.runPromiseWith(base)(
          Effect.all([buildModels, storage.open(prefix), buildServers]).pipe(
            Effect.flatMap(([piModels, piStorage, mcp]) =>
              Effect.map(buildCodemode(mcp), (built) => [piModels, piStorage, built, mcp] as const),
            ),
            Effect.tap(([, , built, mcp]) =>
              Effect.sync(() => {
                for (const extension of built) registry.install(extension);
                for (const [index, extension] of mcp.entries()) {
                  registry.install(extension);
                  const names = extension.tools.map((tool) => tool.name);
                  serverTools.set(servers[index]!.server.serverName, names);
                  for (const toolName of names) {
                    toolByName.set(toolName, { toolName } as ToolRef);
                  }
                }
              }),
            ),
            Effect.flatMap(([piModels, piStorage, built, mcp]) =>
              fromPi((context) =>
                PiHarness.open(
                  piStorage,
                  {
                    models: piModels,
                    registry,
                    settings: {
                      ...options.settings,
                      extensions: [...defaultExtensions, ...built, ...mcp],
                    },
                    ...(envFor === undefined
                      ? {}
                      : {
                          env: (target) =>
                            Effect.runPromiseWith(base)(
                              envFor({ ...target, instanceId: storage.id }).pipe(
                                Effect.catch((error) => Effect.die(new Error(error.message))),
                              ),
                            ),
                        }),
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
            const now = yield* Clock.currentTimeMillis;
            if (next.active) {
              yield* wake!.schedule("wake", { after: 0, payload: {}, progress: now });
            } else if (next.at !== undefined) {
              yield* wake!.schedule("wake", { at: next.at, payload: {}, progress: now });
            }
          }).pipe(Effect.ignore);

    const callbacks = storage.callbacks;
    if (storage.evictable && callbacks !== undefined) {
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
                // A failed wake is a defect, which the callbacks redeliver.
              }, Effect.orDie),
            ).pipe(Effect.provide(callbacks));
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
            ? Effect.fail(new NotOnHarness({ kind: "tool", missing: ref.toolName }))
            : Effect.succeed({ name: ref.toolName } as ToolRegistration);
        };
        /** The tool names a list stands for: an MCP server is every tool it listed. */
        const namesOf = (
          refs: ReadonlyArray<Enabled>,
        ): Effect.Effect<ReadonlyArray<string>, NotOnHarness> =>
          Effect.forEach(refs, (ref) => {
            if (isCodeMode(ref)) {
              return Effect.map(
                namesOf(
                  ref.tools.flatMap((tool): ReadonlyArray<Enabled> =>
                    isMcpServer(tool) ? [tool] : flattenTools([tool]),
                  ),
                ),
                (names) => [...names, CODEMODE_TOOL],
              );
            }
            if (!isMcpServer(ref)) return Effect.succeed([ref.toolName]);
            const names = serverTools.get(ref.serverName);
            return names === undefined
              ? Effect.fail(new NotOnHarness({ kind: "tool", missing: ref.serverName }))
              : Effect.succeed(names);
          }).pipe(Effect.map((names) => names.flat()));
        // Selecting an extension enables the tools it brings.
        const brought = broughtBy(
          agent.extensions == null
            ? []
            : Array.isArray(agent.extensions)
              ? agent.extensions
              : ((agent.extensions as { add?: ReadonlyArray<AnyExtension> }).add ?? []),
        );
        const exactly = (names: ReadonlyArray<string>) =>
          Effect.forEach(
            [...new Set(names)].map((toolName) => ({ toolName }) as ToolRef),
            registration,
          );
        let tools: AgentChange["tools"];
        if (agent.tools === null) tools = null;
        else if (agent.tools === undefined) {
          // Nothing asked of the tools: an exact list only when the
          // conversation has one that the new extensions must join.
          tools =
            current !== undefined && brought.length > 0
              ? yield* exactly([...current, ...brought.map((tool) => tool.toolName)])
              : undefined;
        } else if (Array.isArray(agent.tools)) {
          tools = yield* exactly([
            ...(yield* namesOf(agent.tools)),
            ...brought.map((tool) => tool.toolName),
          ]);
        } else {
          const edit = agent.tools as {
            add?: ReadonlyArray<Enabled>;
            remove?: ReadonlyArray<Enabled>;
          };
          const remove = new Set(yield* namesOf(edit.remove ?? []));
          const add = [
            ...(yield* namesOf(edit.add ?? [])),
            ...brought.map((tool) => tool.toolName),
          ];
          // Pi stores only a removal list or an exact list; adding means
          // writing out the exact list.
          const enabled = current ?? [...toolByName.keys()];
          tools = yield* exactly([...enabled, ...add].filter((name) => !remove.has(name)));
        }
        const named = (extension: AnyExtension) =>
          ({ name: extension.extensionName }) as PiExtension;
        let selected: AgentChange["extensions"];
        if (agent.extensions === null) selected = null;
        else if (agent.extensions === undefined) selected = undefined;
        else if (Array.isArray(agent.extensions))
          selected = [{ name: BASE_EXTENSION } as PiExtension, ...agent.extensions.map(named)];
        else {
          const edit = agent.extensions as {
            add?: ReadonlyArray<AnyExtension>;
            remove?: ReadonlyArray<AnyExtension>;
          };
          selected = {
            ...(edit.add ? { add: edit.add.map(named) } : {}),
            ...(edit.remove ? { remove: edit.remove.map(named) } : {}),
          };
        }
        if (agent.model != null && !models.some(({ model }) => model === agent.model)) {
          return yield* new NotOnHarness({ kind: "model", missing: agent.model.modelName });
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
          ...(selected !== undefined ? { extensions: selected } : {}),
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
      const onSandbox = (
        call: (
          sandbox: Sandboxes["Service"],
          key: string,
        ) => Effect.Effect<unknown, unknown, RuntimeContext>,
      ): Effect.Effect<void, PiError, RuntimeContext> =>
        sandboxes === undefined
          ? Effect.void
          : Effect.suspend(() => call(sandboxes, sandboxKey(storage.id, id))).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new PiError({ message: `Sandbox: ${messageOf(cause)}`, cause }),
              ),
            );
      return {
        id,
        sandboxKey: sandboxKey(storage.id, id),
        raw: Effect.map(raw, ({ conversation }) => conversation),
        suspendSandbox: onSandbox((sandbox, key) => sandbox.suspend(key)),
        removeSandbox: onSandbox((sandbox, key) => sandbox.remove(key)),
        agent: on((conversation) => fromPi((context) => conversation.agent(context))),
        configure: (requested) =>
          on((conversation) =>
            Effect.gen(function* () {
              // An edit (to the tools, or extensions bringing tools) is
              // applied to what the conversation has enabled now.
              const current =
                Array.isArray(requested.tools) || requested.tools === null
                  ? undefined
                  : yield* enabledTools(conversation);
              const change = yield* changeOf(requested, current);
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

    const conversationByName = (name: string) =>
      Effect.flatMap(open, (harness) =>
        Effect.flatMap(namedId(harness, name), (id) =>
          id === undefined
            ? Effect.fail(new ConversationNotFound({ conversationName: name }))
            : Effect.succeed(conversationOf(id)),
        ),
      );

    return {
      raw: open,
      conversationByName,
      submit: (name, draft) =>
        Effect.flatMap(conversationByName(name), (conversation) => conversation.submit(draft)),
      configure: (name, agent) =>
        Effect.flatMap(conversationByName(name), (conversation) => conversation.configure(agent)),
      abort: (name, abortOptions) =>
        Effect.flatMap(conversationByName(name), (conversation) =>
          conversation.abort(abortOptions),
        ),
      suspendSandbox: (name) =>
        Effect.flatMap(conversationByName(name), (conversation) => conversation.suspendSandbox),
      removeSandbox: (name) =>
        Effect.flatMap(conversationByName(name), (conversation) => conversation.removeSandbox),
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
                  new PiError({ message: `${error.kind} ${error.missing} is not on this harness` }),
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
                  new PiError({ message: `${error.kind} ${error.missing} is not on this harness` }),
              ),
            );
            const root = yield* fromPi((context) => harness.root(context, { agent: change }));
            return conversationOf(root.id);
          }),
        ),
      listConversations: Effect.flatMap(open, (harness) =>
        fromPi((context) => harness.snapshot(ConversationNames, context)).pipe(
          Effect.map((doc) => ({ ...doc?.names }) as Record<string, ConversationId>),
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
    | Storage
    | ModelServices<Models>
    | ListedRequirements<Tools[number]>
    | ExtensionRequirements<Extensions[number]>
  >;
