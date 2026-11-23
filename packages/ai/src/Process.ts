import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isCodeMode, type CodeModeConvention, type CodeModeGroup } from "./CodeMode.ts";
import { Harness, HarnessError, type Engine, type Reply, type SendOptions } from "./Harness.ts";
import { isMcpServer, type McpServerClass } from "./McpServer.ts";
import { isModel, type AnyModel, type ModelClass } from "./Model.ts";
import {
  isToolGroup,
  Tool,
  ToolCall,
  type AnyTool,
  type InlineTool,
  type SandboxesFor,
  type ToolClass,
  type ToolGroup,
  type ToolTagClass,
} from "./Tool.ts";

const InputTypeId = "~alchemy/AI/Input" as const;
const ProcessTypeId = "~alchemy/AI/Process" as const;
const SelfTypeId = "~alchemy/AI/Self" as const;
/** The key under which a term of another package says what mentioning it gives. */
export const MentionTypeId = "~alchemy/AI/Mention" as const;

/** A value a process is started with, mentioned by name in its prose. */
export interface Input<Name extends string = string, S extends Schema.Top = Schema.Top> {
  readonly [InputTypeId]: true;
  readonly name: Name;
  readonly schema: S;
}

export type AnyInput = Input<string, Schema.Top>;

export const isInput = (u: unknown): u is AnyInput =>
  typeof u === "object" && u !== null && InputTypeId in u;

/**
 * Declare a value a process is started with. Mentioning it in a process's
 * prose makes it one of the process's inputs: the model reads its name
 * there, and its value in the session's first message.
 *
 * **Example:** An input, mentioned in prose
 * ```typescript
 * export const issue = AI.Input("issue", Schema.Number);
 *
 * export class Triage extends AI.Process<Triage>()("Triage", {
 *   description: "Label one GitHub issue.",
 * })`
 *   Label GitHub issue ${issue} as a bug, a feature or a question.
 * ` {}
 *
 * // `start` takes { issue: number }
 * yield* triage.start("issue-42", { issue: 42 });
 * ```
 */
export const Input = <const Name extends string, S extends Schema.Top>(
  name: Name,
  schema: S,
): Input<Name, S> => ({ [InputTypeId]: true, name, schema });

/** The process a piece of prose belongs to: mention it to let the process start more of itself. */
export interface Self {
  readonly [SelfTypeId]: true;
}

/**
 * The process being described. Mention it to let a session start more
 * sessions of its own process.
 *
 * **Example:** A process that splits its work
 * ```typescript
 * export class Research extends AI.Process<Research>()("Research", {
 *   description: "Answer one question about the code.",
 * })`
 *   Answer ${question}. If it is too broad, start a ${AI.Self} for each part.
 * ` {}
 * ```
 */
export const Self: Self = { [SelfTypeId]: true };

/**
 * What a term of another package gives a process that mentions it: the name
 * the model reads, and the tools the process may call.
 */
export interface Mentionable<R = never> {
  readonly [MentionTypeId]: {
    readonly name: string;
    readonly tools: Effect.Effect<ReadonlyArray<AnyTool>, never, R>;
  };
}

const isMentionable = (u: unknown): u is Mentionable<unknown> =>
  (typeof u === "object" || typeof u === "function") && u !== null && MentionTypeId in u;

/** A session was sent a message before it was started with its inputs. */
export class NotStarted extends Data.TaggedError("NotStarted")<{
  readonly process: string;
  readonly key: string;
}> {}

/** One running instance of a process. */
export interface Session {
  /**
   * Give the session a message and return once it is stored, without
   * waiting for the answer. The session works on, and resumes if its host
   * is evicted.
   */
  readonly send: (
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<void, NotStarted | HarnessError>;
  /** Send a message and wait for the answer, through every tool call it takes. */
  readonly prompt: (
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<Reply, NotStarted | HarnessError>;
  /** Return once the session has nothing left to run. */
  readonly wait: Effect.Effect<void, HarnessError>;
  /** Stop what is running. The session keeps its transcript. */
  readonly abort: Effect.Effect<void, HarnessError>;
  /** The transcript, oldest first, as the harness stores it. */
  readonly messages: Effect.Effect<ReadonlyArray<unknown>, HarnessError>;
}

/** What starting a session takes besides its inputs. */
export interface StartOptions {
  /** The model the session runs on. It must be one the process mentions. @default the `AI.DefaultModel` */
  readonly model?: AnyModel;
}

type StartArgs<I> = [keyof I] extends [never]
  ? [input?: I, options?: StartOptions]
  : [input: I, options?: StartOptions];

/** What yielding a process gives: a way to start sessions and reach them. */
export interface ProcessClient<I = {}> {
  /**
   * Start the session with this key and return once its inputs are stored.
   * Starting a key that already started does nothing.
   */
  readonly start: (key: string, ...args: StartArgs<I>) => Effect.Effect<void, HarnessError>;
  /** The session with this key. Nothing runs until it is used. */
  readonly get: (key: string) => Session;
}

/** What a process is made of. */
interface Definition {
  readonly name: string;
  readonly description: string;
  readonly strings: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<unknown>;
  /** Every value a session is started with. */
  readonly inputs: ReadonlyArray<AnyInput>;
}

/** What a process's tag holds: its client and, where the prose is local, the prose. */
export type ProcessService<I = {}> = ProcessClient<I> & {
  /** @internal */
  readonly "~definition"?: Definition;
  /** @internal Every model the processes of this harness mention, by name. */
  readonly "~models"?: ReadonlyMap<string, AnyModel>;
};

/**
 * Where the sessions of a mentioned process run, when that is not the
 * place that mentions it. A process host provides it, so a session started
 * from another session gets an object of its own.
 *
 * @internal
 */
export class Router extends Context.Service<
  Router,
  {
    readonly route: (
      name: string,
      inputs: ReadonlyArray<AnyInput>,
      local: ProcessClient<any>,
    ) => ProcessClient<any>;
  }
>()("AI.ProcessRouter") {}

/** The object type of a list of inputs: one property per input, by its schema. */
export type InputsOf<M> = Schema.Struct<{
  readonly [I in Extract<M, AnyInput> as I["name"]]: I["schema"];
}>["Type"];

type ToolRequires<T> =
  T extends CodeModeGroup<infer Inner>
    ? CodeModeConvention | ToolRequires<Inner[number]>
    : T extends McpServerClass<infer Service, any>
      ? Service
      : T extends ToolGroup<infer Tools>
        ? ToolRequires<Tools[number]>
        : T extends ToolTagClass<infer Service, any>
          ? Service
          : T extends ToolClass<any, any, any, infer Requires>
            ? Requires
            : T extends InlineTool<any, any, infer Uses>
              ? SandboxesFor<Uses>
              : never;

/** What running a process that mentions `M` requires. */
export type Requires<M> = M extends AnyInput | Self | string | number
  ? never
  : M extends ProcessTag<infer Service, any, any>
    ? Service
    : M extends InlineProcess<any, any, infer R>
      ? R
      : M extends ModelClass<infer Service, any>
        ? Service
        : M extends Mentionable<infer R>
          ? R
          : ToolRequires<M>;

/** The model sessions run on when nobody chose one. */
export interface DefaultModel {
  readonly _: unique symbol;
}

// oxlint-disable-next-line effecttsgo/service-not-as-class -- the tag is also the function that makes its Layer
const DefaultModelKey = Context.Service<DefaultModel, { readonly model: AnyModel }>(
  "AI.DefaultModel",
);

/**
 * The model every session runs on unless its starter, or a later message,
 * names another. Every process requires it.
 *
 * **Example:** Sessions run on `Smart` by default
 * ```typescript
 * export const Live = EngineerLive.pipe(
 *   Layer.provide(Layer.mergeAll(Pi.HarnessLive, AI.DefaultModel(Smart), SmartLive)),
 * );
 * ```
 */
export const DefaultModel: Context.Service<DefaultModel, { readonly model: AnyModel }> &
  (<Service>(model: ModelClass<Service, string>) => Layer.Layer<DefaultModel, never, Service>) =
  Object.setPrototypeOf(function DefaultModel(model: AnyModel) {
    return Layer.effect(
      DefaultModelKey,
      Effect.as(Effect.service(model as Context.Key<unknown, unknown>), { model }),
    );
  }, DefaultModelKey);

/** A process whose prose is on its class. Yielding it requires what the prose mentions. */
export interface InlineProcess<Name extends string, I, R> extends Effect.Effect<
  ProcessClient<I>,
  never,
  R
> {
  readonly [ProcessTypeId]: "inline";
  readonly processName: Name;
  /** @internal */
  readonly definition: Definition;
}

type Declared<Inputs extends ReadonlyArray<AnyInput>> = Inputs[number];

/** Prose for a process tag: only the inputs its tag lists may be mentioned. */
type Mentions<Refs extends ReadonlyArray<unknown>, Inputs extends ReadonlyArray<AnyInput>> = {
  readonly [K in keyof Refs]: Refs[K] extends AnyInput
    ? Refs[K] extends Declared<Inputs>
      ? Refs[K]
      : { readonly "This input is not one the process's tag lists": Refs[K]["name"] }
    : Refs[K];
};

/** A process declared by name and inputs. A Layer gives it its prose. */
export interface ProcessTag<
  Service,
  Name extends string,
  Inputs extends ReadonlyArray<AnyInput>,
> extends Context.ServiceClass<
  Service,
  `AI.Process/${Name}`,
  ProcessService<InputsOf<Inputs[number]>>
> {
  readonly [ProcessTypeId]: "tag";
  readonly processName: Name;
  readonly inputs: Inputs;
  readonly description: string | undefined;
  /**
   * Give the process its prose. Each Layer is one way to carry the process
   * out: its own words, tools, models and other processes. It requires
   * what the prose mentions.
   */
  toLayer(options: {
    /** When to follow or start this process: what another process's model reads to choose it. */
    readonly description: string;
  }): <const Refs extends ReadonlyArray<unknown>>(
    strings: TemplateStringsArray,
    ...refs: Mentions<Refs, Inputs>
  ) => Layer.Layer<Service, never, Requires<Refs[number]> | Harness | DefaultModel>;
}

/** Any process, structurally. */
export type AnyProcess =
  | InlineProcess<string, any, any>
  | {
      readonly [ProcessTypeId]: "tag";
      readonly key: string;
      readonly processName: string;
      readonly inputs: ReadonlyArray<AnyInput>;
      readonly description: string | undefined;
    };

export const isProcess = (u: unknown): u is AnyProcess =>
  (typeof u === "object" || typeof u === "function") && u !== null && ProcessTypeId in u;

/** The declaration forms of a process. */
export interface ProcessConstructor {
  <Service>(): {
    /** A process known by its name and inputs: `toLayer` gives it prose. */
    <const Name extends string, const Inputs extends ReadonlyArray<AnyInput>>(
      name: Name,
      options: {
        /** Every value a session is started with. */
        readonly inputs: Inputs;
        /** What a process that mentions this one reads, where the prose's own description is out of reach. */
        readonly description?: string;
      },
    ): ProcessTag<Service, Name, Inputs>;
    /** A process with its prose on the class. */
    <const Name extends string>(
      name: Name,
      options: {
        /** When to follow or start this process: what another process's model reads to choose it. */
        readonly description: string;
      },
    ): <const Refs extends ReadonlyArray<unknown>>(
      strings: TemplateStringsArray,
      ...refs: Refs
    ) => InlineProcess<
      Name,
      InputsOf<Refs[number]>,
      Requires<Refs[number]> | Harness | DefaultModel
    > &
      (new () => object);
  };
}

/** A template's text with its shared indentation and outer blank lines removed. */
const dedent = (strings: ReadonlyArray<string>): ReadonlyArray<string> => {
  const lines = strings.join("\u0000").split("\n");
  const margin = lines
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .reduce((least, line) => Math.min(least, line.length - line.trimStart().length), Infinity);
  const cut = Number.isFinite(margin) ? margin : 0;
  const text = [
    lines[0]!,
    ...lines
      .slice(1)
      .map((line) => line.slice(Math.min(cut, line.length - line.trimStart().length))),
  ]
    .join("\n")
    .replace(/^[ \t]*\n/, "")
    .replace(/\n[ \t]*$/, "");
  return text.split("\u0000");
};

/** `Engineer` as a tool name: `engineer`; `CodeReview` as `code_review`. */
const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();

const definitionOf = (process: AnyProcess): Definition | undefined =>
  process[ProcessTypeId] === "inline" ? process.definition : undefined;

/** The inputs a piece of prose mentions, once each. */
const inputsIn = (refs: ReadonlyArray<unknown>): ReadonlyArray<AnyInput> => [
  ...new Map(refs.filter(isInput).map((input) => [input.name, input])).values(),
];

/** Another process a session may follow or start. */
interface Child {
  readonly name: string;
  readonly description: string;
  readonly inputs: ReadonlyArray<AnyInput>;
  readonly client: () => ProcessClient<any>;
  /** The prose, where it can be followed here. */
  readonly definition: Definition | undefined;
}

/** What is known of one harness's processes: compiled once each, and every model by name. */
interface Known {
  readonly services: Map<Definition, ProcessService<any>>;
  readonly models: Map<string, AnyModel>;
  readonly tools: Map<string, ReadonlyArray<AnyTool>>;
}

const knownBy = new WeakMap<object, Known>();

/**
 * Run an Effect of the harness where a session is used. A session is only
 * ever used inside a running instance, which has the runtime context, so a
 * client can be called from code that requires nothing (a Domain policy).
 */
const inRuntime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the instance that uses a session provides its runtime context
  effect as Effect.Effect<A, E>;

/**
 * The schema of a list of inputs: one property per input.
 *
 * @internal
 */
export const structOf = (inputs: ReadonlyArray<AnyInput>) =>
  Schema.Struct(Object.fromEntries(inputs.map((input) => [input.name, input.schema])));

/** A session's first message: each input by name. */
const firstMessage = (inputs: ReadonlyArray<AnyInput>, value: unknown) =>
  Schema.encodeUnknownEffect(structOf(inputs) as unknown as Schema.Codec<unknown, unknown>)(
    value ?? {},
  ).pipe(
    Effect.orDie,
    Effect.map((encoded) =>
      Object.entries(encoded as Record<string, unknown>)
        .map(([name, each]) => `${name}: ${typeof each === "string" ? each : JSON.stringify(each)}`)
        .join("\n"),
    ),
  );

/** The tools a session gets for one process it may follow or start. */
const childTools = (child: Child, known: Known): ReadonlyArray<AnyTool> => {
  const cached = known.tools.get(child.name);
  if (cached !== undefined) return cached;
  const id = snake(child.name);
  const start = Tool(
    `start_${id}`,
    {
      description: `Start a session of the ${child.name} process: ${child.description} It runs on its own, apart from this conversation. Returns the session's name.`,
      parameters: Schema.Struct({
        ...(child.inputs.length > 0 ? { input: structOf(child.inputs) } : {}),
        session: Schema.optionalKey(Schema.String).annotate({
          description: "A name for the session. Starting a name twice does nothing.",
        }),
        model: Schema.optionalKey(Schema.String).annotate({
          description: "The name of a model your instructions mention.",
        }),
      }),
      success: Schema.Struct({ session: Schema.String }),
    },
    Effect.fn(function* (parameters: {
      readonly input?: unknown;
      readonly session?: string;
      readonly model?: string;
    }) {
      const call = yield* ToolCall;
      const session = parameters.session ?? call.callId;
      const model = parameters.model === undefined ? undefined : known.models.get(parameters.model);
      if (parameters.model !== undefined && model === undefined) {
        return yield* Effect.die(
          new HarnessError({ message: `There is no model named ${parameters.model}.` }),
        );
      }
      yield* child
        .client()
        .start(session, parameters.input ?? {}, model === undefined ? {} : { model })
        .pipe(Effect.orDie);
      return { session };
    }),
  );
  const send = Tool(
    `send_${id}`,
    {
      description: `Send a message to a session of the ${child.name} process that was started earlier.`,
      parameters: Schema.Struct({ session: Schema.String, text: Schema.String }),
      success: Schema.Struct({ sent: Schema.Boolean }),
    },
    Effect.fn(function* ({ session, text }: { readonly session: string; readonly text: string }) {
      const call = yield* ToolCall;
      return yield* child
        .client()
        .get(session)
        .send(text, { requestId: call.callId })
        .pipe(
          Effect.as({ sent: true }),
          Effect.catchTag("NotStarted", () => Effect.succeed({ sent: false })),
          Effect.orDie,
        );
    }),
  );
  const tools: ReadonlyArray<AnyTool> = [start, send];
  known.tools.set(child.name, tools);
  return tools;
};

/**
 * Turn a process's prose into something a harness runs: gather what it
 * mentions, tell the harness, and return its client. Runs where the
 * process's Layer is built, so every mention's service is at hand.
 */
const compile = (definition: Definition): Effect.Effect<ProcessService<any>, never, any> =>
  Effect.gen(function* () {
    const harness = yield* Harness;
    let known = knownBy.get(harness);
    if (known === undefined) {
      known = { services: new Map(), models: new Map(), tools: new Map() };
      knownBy.set(harness, known);
    }
    const state = known;
    const existing = state.services.get(definition);
    if (existing !== undefined) return existing;

    const { model: defaultModel } = yield* DefaultModel;
    const context = yield* Effect.context<never>();
    const router = Option.getOrUndefined(yield* Effect.serviceOption(Router));
    const routed = (
      name: string,
      inputs: ReadonlyArray<AnyInput>,
      local: () => ProcessClient<any>,
    ): (() => ProcessClient<any>) => {
      let client: ProcessClient<any> | undefined;
      return () =>
        (client ??= router === undefined ? local() : router.route(name, inputs, local()));
    };
    const inputs = definition.inputs;

    const tools: Array<unknown> = [];
    const models: Array<AnyModel> = [defaultModel];
    const children = new Map<string, Child>();
    /** What a mention of another package's term is called, by the term. */
    const names = new Map<unknown, string>();
    const seen = new Set<Definition>();
    let service: ProcessService<any> | undefined;

    /** Gather one piece of prose: this process's, and that of every process it may follow. */
    const gather = (prose: Definition): Effect.Effect<void, never, any> =>
      Effect.gen(function* () {
        if (seen.has(prose)) return;
        seen.add(prose);
        for (const ref of prose.refs) {
          if (isInput(ref) || typeof ref === "string" || typeof ref === "number") continue;
          if (ref === Self) {
            children.set(prose.name, {
              name: prose.name,
              description: prose.description,
              inputs: prose.inputs,
              client: routed(prose.name, prose.inputs, () =>
                prose === definition ? service! : state.services.get(prose)!,
              ),
              definition: undefined,
            });
          } else if (isProcess(ref)) {
            const inline = definitionOf(ref);
            if (inline !== undefined) {
              const client = yield* compile(inline);
              children.set(inline.name, {
                name: inline.name,
                description: inline.description,
                inputs: inline.inputs,
                client: () => client,
                definition: inline,
              });
              yield* gather(inline);
            } else if (ref[ProcessTypeId] === "tag") {
              const client = yield* Effect.service(
                ref as unknown as Context.Key<unknown, ProcessService<any>>,
              );
              const local = client["~definition"];
              children.set(ref.processName, {
                name: ref.processName,
                description: local?.description ?? ref.description ?? ref.processName,
                inputs: ref.inputs,
                client: routed(ref.processName, ref.inputs, () => client),
                definition: local,
              });
              if (local !== undefined) yield* gather(local);
            }
          } else if (isModel(ref)) {
            models.push(ref);
          } else if (isMentionable(ref)) {
            const mention = ref[MentionTypeId];
            names.set(ref, mention.name);
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- what the mention requires is a requirement of the process
            tools.push(...(yield* mention.tools as Effect.Effect<ReadonlyArray<AnyTool>>));
          } else {
            // A group stands for its tools: a harness is given each one.
            const each = (tool: unknown): ReadonlyArray<unknown> =>
              isToolGroup(tool) ? (tool.tools as ReadonlyArray<unknown>).flatMap(each) : [tool];
            tools.push(...each(ref));
          }
        }
      });
    yield* gather(definition);

    for (const model of models) state.models.set(model.modelName, model);
    const followable = [...children.values()].filter((child) => child.definition !== undefined);

    /** What the model reads for a mention. */
    const mentionOf = (engine: Engine, ref: unknown): string => {
      if (typeof ref === "string" || typeof ref === "number") return String(ref);
      if (isInput(ref)) return `\`${ref.name}\``;
      if (ref === Self) return definition.name;
      if (isProcess(ref)) return ref.processName;
      if (isModel(ref)) return `\`${ref.modelName}\``;
      if (isMentionable(ref)) return names.get(ref) ?? ref[MentionTypeId].name;
      const each = (tool: unknown): ReadonlyArray<string> =>
        isCodeMode(tool) || isToolGroup(tool)
          ? (tool.tools as ReadonlyArray<unknown>).flatMap(each)
          : [`\`${isMcpServer(tool) ? tool.serverName : engine.toolName(tool)}\``];
      return each(ref).join(", ");
    };
    const render = (engine: Engine, prose: Definition): string => {
      const strings = dedent(prose.strings);
      return strings
        .map((text, index) =>
          index < prose.refs.length ? text + mentionOf(engine, prose.refs[index]) : text,
        )
        .join("");
    };

    const follow =
      followable.length === 0
        ? undefined
        : Tool(
            `follow_${snake(definition.name)}`,
            {
              description:
                "Read a process's instructions into this conversation, then carry them out yourself.",
              parameters: Schema.Struct({
                process: Schema.Literals(followable.map((child) => child.name)),
              }),
              success: Schema.Struct({ instructions: Schema.String }),
            },
            Effect.fn(function* ({ process }: { readonly process: string }) {
              const engine = yield* inRuntime(harness.open).pipe(Effect.orDie);
              const child = followable.find((each) => each.name === process)!;
              return { instructions: render(engine, child.definition!) };
            }),
          );
    const generated: ReadonlyArray<AnyTool> = [
      ...(follow === undefined ? [] : [follow]),
      ...[...children.values()].flatMap((child) => childTools(child, state)),
    ];
    const every = [...new Set([...tools, ...generated])];
    yield* harness.add({ models, tools: every, context });

    let instructions: string | undefined;
    const instructionsOn = (engine: Engine): string => {
      if (instructions === undefined) {
        const sections = [render(engine, definition)];
        if (inputs.length > 0) {
          sections.push(
            `Your first message gives a value for each input: ${inputs.map((input) => `\`${input.name}\``).join(", ")}.`,
          );
        }
        if (children.size > 0) {
          const how = [
            ...(follow === undefined
              ? []
              : [
                  `To follow a process, call \`${engine.toolName(follow)}\` with its name: its instructions are added to this conversation and you carry them out.`,
                ]),
            "To start a process, call its `start_` tool: it runs as a session of its own, apart from this conversation.",
          ];
          sections.push(
            [
              "Processes:",
              ...[...children.values()].map((child) => `- ${child.name}: ${child.description}`),
              ...how,
            ].join("\n"),
          );
        }
        instructions = sections.join("\n\n");
      }
      return instructions;
    };

    const sessionOf = (key: string) =>
      Effect.map(inRuntime(harness.open), (engine) =>
        engine.session(`${definition.name}/${key}`, {
          instructions: instructionsOn(engine),
          tools: every,
          model: defaultModel,
        }),
      );
    /** A session of a process with inputs has to be started before it is sent anything. */
    const started = (key: string) =>
      Effect.flatMap(sessionOf(key), (session) =>
        inputs.length === 0
          ? Effect.succeed(session)
          : Effect.flatMap(inRuntime(session.exists), (exists) =>
              exists
                ? Effect.succeed(session)
                : Effect.fail(new NotStarted({ process: definition.name, key })),
            ),
      );

    service = {
      "~definition": definition,
      "~models": state.models,
      start: (key: string, input?: unknown, options?: StartOptions) =>
        Effect.gen(function* () {
          if (inputs.length === 0) return;
          const session = yield* sessionOf(key);
          if (yield* inRuntime(session.exists)) return;
          yield* inRuntime(
            session.submit(yield* firstMessage(inputs, input), {
              requestId: "start",
              ...(options?.model === undefined ? {} : { model: options.model }),
            }),
          );
        }),
      get: (key: string): Session => ({
        send: (text, options) =>
          Effect.flatMap(started(key), (session) => inRuntime(session.submit(text, options))),
        prompt: (text, options) =>
          Effect.flatMap(started(key), (session) => inRuntime(session.prompt(text, options))),
        wait: Effect.flatMap(sessionOf(key), (session) => inRuntime(session.wait)),
        abort: Effect.flatMap(sessionOf(key), (session) => inRuntime(session.abort)),
        messages: Effect.flatMap(sessionOf(key), (session) => inRuntime(session.messages)),
      }),
    };
    state.services.set(definition, service);
    return service;
  });

/**
 * Declare a process: prose that says how to carry out a piece of work with
 * the tools, models and other processes it mentions. Mentioning a term
 * grants it, and makes running the process require that term's Layer.
 *
 * - A tool (`AI.Tool`, `AI.Bash`, an MCP server): the session may call it.
 * - A model (`AI.Model`): the session may be run on it, and may start
 *   other sessions on it.
 * - An input (`AI.Input`): a value the session is started with.
 * - Another process: the session may follow it (read its prose into its
 *   own conversation) or start it (as a session of its own).
 *
 * A process has no output. It reports through the tools it is given.
 *
 * **Example:** The prose on the class
 * ```typescript
 * export const question = AI.Input("question", Schema.String);
 *
 * export class Research extends AI.Process<Research>()("Research", {
 *   description: "Answer one question about the code, with file paths.",
 * })`
 *   Answer ${question} about the repository in your working directory.
 *   Search with ${AI.Grep} and open what looks relevant with ${AI.Read}.
 *   Never edit files.
 * ` {}
 * ```
 *
 * **Example:** A name and inputs, with the prose in a Layer
 * ```typescript
 * export const task = AI.Input("task", Schema.String);
 *
 * export class Engineer extends AI.Process<Engineer>()("Engineer", { inputs: [task] }) {}
 *
 * export const EngineerLive = Engineer.toLayer({
 *   description: "Implement one task, from reading the code to a passing change.",
 * })`
 *   You are implementing ${task}. Start a ${Research} on ${Fast} for each
 *   thing you need to know, then make the change with ${AI.Edit}.
 * `;
 * ```
 *
 * **Example:** Starting a session and talking to it
 * ```typescript
 * const engineer = yield* Engineer;
 *
 * yield* engineer.start("task-7", { task: "Rename the config flag" });
 * const reply = yield* engineer.get("task-7").prompt("Also update the docs.");
 * ```
 */
export const Process = (() =>
  (
    name: string,
    options: {
      readonly inputs?: ReadonlyArray<AnyInput>;
      readonly description?: string;
    },
  ) => {
    // oxlint-disable-next-line effecttsgo/service-not-as-class -- one tag per declared process, extended by the user's class
    const key = Context.Service<unknown, ProcessService<any>>(`AI.Process/${name}`);
    /** Called as a template tag, it is the inline form; extended, it is the tag. */
    function Declared(strings: TemplateStringsArray, ...refs: ReadonlyArray<unknown>) {
      const definition: Definition = {
        name,
        description: options.description ?? name,
        strings: [...strings],
        refs,
        inputs: inputsIn(refs),
      };
      function Inline() {}
      Object.assign(Inline, { [ProcessTypeId]: "inline", processName: name, definition });
      // Yielding the class compiles its prose where it is yielded.
      return Object.setPrototypeOf(
        Inline,
        Effect.suspend(() => compile(definition)),
      );
    }
    Object.assign(Declared, {
      [ProcessTypeId]: "tag",
      processName: name,
      inputs: options.inputs ?? [],
      description: options.description,
      toLayer:
        (layer: { readonly description: string }) =>
        (strings: TemplateStringsArray, ...refs: ReadonlyArray<unknown>) => {
          const definition: Definition = {
            name,
            description: layer.description,
            strings: [...strings],
            refs,
            inputs: options.inputs ?? [],
          };
          const listed = new Set(definition.inputs.map((input) => input.name));
          const unlisted = inputsIn(refs).filter((input) => !listed.has(input.name));
          return Layer.effect(
            key,
            unlisted.length > 0
              ? Effect.die(
                  new HarnessError({
                    message: `The prose of ${name} mentions inputs its tag does not list: ${unlisted.map((input) => input.name).join(", ")}.`,
                  }),
                )
              : compile(definition),
          );
        },
    });
    return Object.setPrototypeOf(Declared, key);
  }) as unknown as ProcessConstructor;
