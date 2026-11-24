import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { isCodeMode, type CodeModeConvention, type CodeModeGroup } from "./CodeMode.ts";
import {
  Harness,
  HarnessError,
  type Engine,
  type HistoryOptions,
  type Reply,
  type SendOptions,
  type SessionEvent,
  type SessionPage,
} from "./Harness.ts";
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

const ProcessTypeId = "~alchemy/AI/Process" as const;
const SelfTypeId = "~alchemy/AI/Self" as const;
/** The key under which a term of another package says what mentioning it gives. */
export const MentionTypeId = "~alchemy/AI/Mention" as const;

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
 *   Answer the question you are given. If it is too broad, start a ${AI.Self} for each part.
 * ` {}
 * ```
 */
export const Self: Self = { [SelfTypeId]: true };

/**
 * What a term of another package gives a process that mentions it: the name
 * the model reads, and the tools the process may call.
 */
export interface Mentionable<R = never, As = never> {
  readonly [MentionTypeId]: {
    readonly name: string;
    readonly tools: Effect.Effect<ReadonlyArray<AnyTool>, never, R>;
    /**
     * Where the term's tools act as someone: what a session's `as` is, in
     * a form that can be stored. A tool reads it back as `AI.Acting`.
     */
    readonly as?: (context: Context.Context<never>) => Effect.Effect<Stored>;
  };
  /** Phantom: what a session of a process that mentions the term must be started as. */
  readonly "~as"?: As;
}

/** What a session acts as, as it is stored. */
export type Stored = Readonly<Record<string, unknown>>;

/**
 * What the session a tool call belongs to acts as, as it was stored when
 * the session started. A term that needs it reads it here; the model
 * never sees it.
 */
export class Acting extends Context.Service<Acting, { readonly as: Stored }>()("AI.Acting") {}

const isMentionable = (u: unknown): u is Mentionable<unknown> =>
  (typeof u === "object" || typeof u === "function") && u !== null && MentionTypeId in u;

/** A session that acts as someone was sent a message before it was started. */
export class NotStarted extends Data.TaggedError("NotStarted")<{
  readonly process: string;
  readonly key: string;
}> {}

/** One running instance of a process. */
export interface Session {
  /**
   * Give the session a message and return once it is stored, without
   * waiting for the answer. A session that is working reads it when its turn
   * ends. The session works on, and resumes if its host is evicted.
   */
  readonly send: (
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<void, NotStarted | HarnessError, RuntimeContext>;
  /**
   * Give a working session a message to read at its next step, without
   * ending its turn. A session with nothing running starts a turn, as `send`
   * does. A harness that cannot steer queues the message.
   */
  readonly steer: (
    text: string,
    options?: Pick<SendOptions, "requestId">,
  ) => Effect.Effect<void, NotStarted | HarnessError, RuntimeContext>;
  /** Take back a queued message, by the `id` a `status` event lists it with. */
  readonly withdraw: (id: string) => Effect.Effect<void, HarnessError, RuntimeContext>;
  /** Stop the turn that is running. The session keeps its transcript and its queue. */
  readonly interrupt: Effect.Effect<void, HarnessError, RuntimeContext>;
  /**
   * What the session is doing, live. The first event is its `status`:
   * whether it is working, and what is queued. Then every stored item after
   * `after`, then each new item and each change of status as it happens.
   */
  readonly events: (options?: {
    readonly after?: number;
  }) => Stream.Stream<SessionEvent, HarnessError, RuntimeContext>;
  /** A page of the transcript: the items the session has stored. */
  readonly history: (
    options?: HistoryOptions,
  ) => Effect.Effect<SessionPage, HarnessError, RuntimeContext>;
  /** `send`, then wait for the answer, through every tool call it takes. */
  readonly prompt: (
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<Reply, NotStarted | HarnessError, RuntimeContext>;
}

/** What starting a session takes. */
export type StartOptions<As = never> = {
  /** The model the session runs on. It must be one the process mentions. @default the `AI.DefaultModel` */
  readonly model?: AnyModel;
} & ([As] extends [never]
  ? {}
  : {
      /**
       * Who the session acts as, for everything it ever does: the request
       * context of the commands and views its process mentions. It is kept
       * with the session and never shown to the model.
       */
      readonly as: Context.Context<As>;
    });

type StartArgs<As> = [As] extends [never] ? [options?: StartOptions] : [options: StartOptions<As>];

/** What yielding a process gives: a way to start sessions and reach them. */
export interface ProcessClient<As = never> {
  /**
   * Make the session with this key: on the model, and acting as who, it is
   * started with. Starting a key that already started does nothing. A
   * session that acts as nobody need not be started.
   */
  readonly start: (
    key: string,
    ...args: StartArgs<As>
  ) => Effect.Effect<void, HarnessError, RuntimeContext>;
  /** The session with this key. Nothing runs until it is used. */
  readonly get: (key: string) => Session;
}

/** What a process is made of. */
interface Definition {
  readonly name: string;
  readonly description: string;
  readonly strings: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<unknown>;
}

/** What a process's tag holds: its client and, where the prose is local, the prose. */
export type ProcessService<As = never> = ProcessClient<As> & {
  /** @internal */
  readonly "~definition"?: Definition;
  /** @internal Whether the harness has the session with this key. */
  readonly "~exists"?: (key: string) => Effect.Effect<boolean, HarnessError, RuntimeContext>;
};

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
export type Requires<M> = M extends Self | string | number
  ? never
  : M extends { readonly [ProcessTypeId]: "tag"; readonly "~process": infer Service }
    ? Service
    : M extends { readonly [ProcessTypeId]: "inline"; readonly "~requires": infer R }
      ? R
      : M extends ModelClass<infer Service, any>
        ? Service
        : M extends {
              readonly [MentionTypeId]: { readonly tools: Effect.Effect<any, any, infer R> };
            }
          ? R
          : ToolRequires<M>;

/** What a session of a process that mentions `M` must be started as. */
export type Acts<M> = M extends { readonly "~acts": infer As }
  ? As
  : M extends { readonly [MentionTypeId]: unknown; readonly "~as"?: infer As }
    ? Exclude<As, undefined>
    : never;

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
export interface InlineProcess<Name extends string, R, As = never> extends Effect.Effect<
  ProcessClient<As>,
  never,
  R
> {
  readonly [ProcessTypeId]: "inline";
  readonly processName: Name;
  /** @internal */
  readonly definition: Definition;
  /** Phantom: what yielding the process requires. */
  readonly "~requires": R;
  /** Phantom: what a session of the process must be started as. */
  readonly "~acts": As;
}

/** A process declared by name. A Layer gives it its prose. */
export interface ProcessTag<Service, Name extends string, As = never> extends Context.ServiceClass<
  Service,
  `AI.Process/${Name}`,
  ProcessService<As>
> {
  readonly [ProcessTypeId]: "tag";
  readonly processName: Name;
  readonly description: string | undefined;
  /** Phantom: the service a process that mentions this one requires. */
  readonly "~process": Service;
  /** Phantom: what a session of the process must be started as. */
  readonly "~acts": As;
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
    ...refs: Refs
  ) => Layer.Layer<Service, never, Requires<Refs[number]> | Harness | DefaultModel>;
}

/** Any process, structurally. */
export type AnyProcess =
  | InlineProcess<string, any, any>
  | {
      readonly [ProcessTypeId]: "tag";
      readonly key: string;
      readonly processName: string;
      readonly description: string | undefined;
    };

export const isProcess = (u: unknown): u is AnyProcess =>
  (typeof u === "object" || typeof u === "function") && u !== null && ProcessTypeId in u;

/** The prose of a process, written on its class. */
export type Prose<Name extends string> = <const Refs extends ReadonlyArray<unknown>>(
  strings: TemplateStringsArray,
  ...refs: Refs
) => InlineProcess<Name, Requires<Refs[number]> | Harness | DefaultModel, Acts<Refs[number]>> &
  (new () => object);

/**
 * The declaration forms of a process. Extended as it is, the declaration
 * is a tag a Layer gives prose to; with a description, it also takes the
 * prose itself.
 */
export interface ProcessConstructor {
  <Service>(): <
    const Name extends string,
    const Description extends string | undefined = undefined,
    As extends Context.Key<any, any> = never,
  >(
    name: Name,
    options: {
      /**
       * When to follow or start this process: what another process's model
       * reads to choose it. Required to write the prose on the class;
       * otherwise it may be given with the prose, on `toLayer`.
       */
      readonly description?: Description;
      /**
       * What a session must be started as: the request context of the
       * commands and views its prose may mention. Prose on the class works
       * this out from what it mentions.
       */
      readonly as?: ReadonlyArray<As>;
    },
  ) => ProcessTag<
    Service,
    Name,
    [As] extends [never] ? never : As extends Context.Key<infer Id, any> ? Id : never
  > &
    ([Description] extends [string] ? Prose<Name> : unknown);
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

/** Under which a session started by another session is handed what that one acts as. */
const STORED = "~as" as const;

/** What `start` takes: its options, or what the starting session acts as, already stored. */
type StartWith = {
  readonly model?: AnyModel;
  readonly as?: Context.Context<never>;
  readonly [STORED]?: Stored;
};

/** What the session of the tool call being answered acts as. */
const actingIn = (harness: Harness["Service"]) =>
  Effect.gen(function* () {
    const call = yield* ToolCall;
    const engine = yield* harness.open;
    const stored = yield* engine.values.get(`as:${call.conversationId}`);
    return (stored === undefined ? {} : JSON.parse(stored)) as Stored;
  }).pipe(Effect.orDie);

/** Another process a session may follow or start. */
interface Child {
  readonly name: string;
  readonly description: string;
  readonly client: () => ProcessService<any>;
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

/** The tools a session gets for one process it may follow or start. */
const childTools = (
  child: Child,
  known: Known,
  harness: Harness["Service"],
): ReadonlyArray<AnyTool> => {
  const cached = known.tools.get(child.name);
  if (cached !== undefined) return cached;
  const id = snake(child.name);
  const start = Tool(
    `start_${id}`,
    {
      description: `Start a session of the ${child.name} process: ${child.description} It runs on its own, apart from this conversation. Returns the session's name.`,
      parameters: Schema.Struct({
        text: Schema.String.annotate({
          description: "The session's first message: what it is to do.",
        }),
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
      readonly text: string;
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
      // A session started by another acts as whoever that one does.
      const client = child.client();
      const start = client.start as (
        key: string,
        options: StartWith,
      ) => Effect.Effect<void, HarnessError, RuntimeContext>;
      const on = model === undefined ? {} : { model };
      yield* start(session, { ...on, [STORED]: yield* actingIn(harness) }).pipe(Effect.orDie);
      // The same id on every replay, so a session is given its first message once.
      yield* client
        .get(session)
        .send(parameters.text, { requestId: "start", ...on })
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
      const client = child.client();
      // A name nobody started is a mistake, not a new session.
      const exists = client["~exists"];
      if (exists !== undefined && !(yield* Effect.orDie(exists(session)))) return { sent: false };
      return yield* client
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

    const tools: Array<unknown> = [];
    const models: Array<AnyModel> = [defaultModel];
    const children = new Map<string, Child>();
    /** What a mention of another package's term is called, by the term. */
    const names = new Map<unknown, string>();
    const seen = new Set<Definition>();
    let service: ProcessService<any> | undefined;
    /** How each term that acts as someone stores who that is. */
    const encoders: Array<(context: Context.Context<never>) => Effect.Effect<Stored>> = [];
    /** A tool of such a term, given what its session acts as. */
    const acting = (tool: AnyTool): AnyTool => {
      const inline = tool as InlineTool<string, any, any>;
      return {
        ...inline,
        handler: (parameters: never) =>
          Effect.flatMap(actingIn(harness), (as) =>
            Effect.provideService(inline.handler(parameters), Acting, { as }),
          ),
      } as AnyTool;
    };

    /** Gather one piece of prose: this process's, and that of every process it may follow. */
    const gather = (prose: Definition): Effect.Effect<void, never, any> =>
      Effect.gen(function* () {
        if (seen.has(prose)) return;
        seen.add(prose);
        for (const ref of prose.refs) {
          if (typeof ref === "string" || typeof ref === "number") continue;
          if (ref === Self) {
            children.set(prose.name, {
              name: prose.name,
              description: prose.description,
              client: () => (prose === definition ? service! : state.services.get(prose)!),
              definition: undefined,
            });
          } else if (isProcess(ref)) {
            const inline = definitionOf(ref);
            if (inline !== undefined) {
              const client = yield* compile(inline);
              children.set(inline.name, {
                name: inline.name,
                description: inline.description,
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
                client: () => client,
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
            const granted = yield* mention.tools as Effect.Effect<ReadonlyArray<AnyTool>>;
            if (mention.as === undefined) {
              tools.push(...granted);
            } else {
              encoders.push(mention.as);
              tools.push(...granted.map(acting));
            }
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
              const engine = yield* harness.open.pipe(Effect.orDie);
              const child = followable.find((each) => each.name === process)!;
              return { instructions: render(engine, child.definition!) };
            }),
          );
    const generated: ReadonlyArray<AnyTool> = [
      ...(follow === undefined ? [] : [follow]),
      ...[...children.values()].flatMap((child) => childTools(child, state, harness)),
    ];
    const every = [...new Set([...tools, ...generated])];
    yield* harness.add({ models, tools: every, context });

    let instructions: string | undefined;
    const instructionsOn = (engine: Engine): string => {
      if (instructions === undefined) {
        const sections = [render(engine, definition)];
        if (children.size > 0) {
          const how = [
            ...(follow === undefined
              ? []
              : [
                  `To follow a process, call \`${engine.toolName(follow)}\` with its name: its instructions are added to this conversation and you carry them out.`,
                ]),
            "To start a process, call its `start_` tool with what it is to do: it runs as a session of its own, apart from this conversation.",
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
      Effect.map(harness.open, (engine) =>
        engine.session(`${definition.name}/${key}`, {
          instructions: instructionsOn(engine),
          tools: every,
          model: defaultModel,
        }),
      );
    /** Whether a session has to be started before it is sent anything: it acts as someone. */
    const needsStart = () => encoders.length > 0;
    const started = (key: string) =>
      Effect.flatMap(sessionOf(key), (session) =>
        !needsStart()
          ? Effect.succeed(session)
          : Effect.flatMap(session.exists, (exists) =>
              exists
                ? Effect.succeed(session)
                : Effect.fail(new NotStarted({ process: definition.name, key })),
            ),
      );

    service = {
      "~definition": definition,
      "~exists": (key: string) => Effect.flatMap(sessionOf(key), (session) => session.exists),
      start: (key: string, options?: StartWith) =>
        Effect.gen(function* () {
          const engine = yield* harness.open;
          const session = yield* sessionOf(key);
          if (yield* session.exists) return;
          const as =
            encoders.length === 0
              ? undefined
              : (options?.[STORED] ??
                (options?.as === undefined
                  ? undefined
                  : Object.assign(
                      {},
                      ...(yield* Effect.forEach(encoders, (encode) => encode(options.as!))),
                    )));
          if (encoders.length > 0 && as === undefined) {
            return yield* new HarnessError({
              message: `A session of ${definition.name} acts as someone: start it with \`as\`.`,
            });
          }
          const id = yield* session.open(
            options?.model === undefined ? {} : { model: options.model },
          );
          // Stored before the session is given anything, so its first tool call finds it.
          if (as !== undefined) yield* engine.values.put(`as:${id}`, JSON.stringify(as));
        }),
      get: (key: string): Session => ({
        send: (text, options) =>
          Effect.flatMap(started(key), (session) => session.send(text, options)),
        steer: (text, options) =>
          Effect.flatMap(started(key), (session) => session.steer(text, options)),
        withdraw: (id) => Effect.flatMap(sessionOf(key), (session) => session.withdraw(id)),
        interrupt: Effect.flatMap(sessionOf(key), (session) => session.interrupt),
        events: (options) =>
          Stream.unwrap(Effect.map(sessionOf(key), (session) => session.events(options))),
        history: (options) => Effect.flatMap(sessionOf(key), (session) => session.history(options)),
        prompt: (text, options) =>
          Effect.flatMap(started(key), (session) => session.prompt(text, options)),
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
 * - Another process: the session may follow it (read its prose into its
 *   own conversation) or start it (as a session of its own).
 *
 * A process has no inputs and no output. It is told what to do in the
 * messages it is sent, and reports through the tools it is given.
 *
 * **Example:** The prose on the class
 * ```typescript
 * export class Research extends AI.Process<Research>()("Research", {
 *   description: "Answer one question about the code, with file paths.",
 * })`
 *   Answer one question about the repository in your working directory.
 *   Search with ${AI.Grep} and open what looks relevant with ${AI.Read}.
 *   Never edit files.
 * ` {}
 * ```
 *
 * **Example:** A name, with the prose in a Layer
 * ```typescript
 * export class Engineer extends AI.Process<Engineer>()("Engineer", {}) {}
 *
 * export const EngineerLive = Engineer.toLayer({
 *   description: "Implement one task, from reading the code to a passing change.",
 * })`
 *   Implement the task you are given. Start a ${Research} on ${Fast} for
 *   each thing you need to know, then make the change with ${AI.Edit}.
 * `;
 * ```
 *
 * **Example:** Talking to a session
 * ```typescript
 * const engineer = yield* Engineer;
 *
 * yield* engineer.get("task-7").send("Rename the config flag.");
 * const reply = yield* engineer.get("task-7").prompt("Also update the docs.");
 * ```
 */
export const Process = (() =>
  (
    name: string,
    options: {
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
      description: options.description,
      toLayer:
        (layer: { readonly description: string }) =>
        (strings: TemplateStringsArray, ...refs: ReadonlyArray<unknown>) => {
          const definition: Definition = {
            name,
            description: layer.description,
            strings: [...strings],
            refs,
          };
          return Layer.effect(key, compile(definition));
        },
    });
    return Object.setPrototypeOf(Declared, key);
  }) as unknown as ProcessConstructor;
