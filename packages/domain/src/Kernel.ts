import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import type { Plan } from "./Backfill.ts";
import * as CatchUp from "./CatchUp.ts";
import * as Command from "./Command.ts";
import type * as Compaction from "./Compaction.ts";
import * as Decision from "./Decision.ts";
import {
  ConsumesItself,
  DefinitionError,
  DuplicateDefinition,
  DuplicateEventTag,
  DuplicateName,
  ImplementedTwice,
  InitialNotJson,
  InvalidInitial,
  InvalidRewrite,
  MissingInitial,
  MissingKeyOf,
  NoEmitter,
  NoJsonForm,
  PagedWithoutSuccess,
  type Reason,
  TwoWriters,
  NewerGeneration,
  UndeclaredDecision,
  UndeclaredEmit,
  UndeclaredEvent,
  UnhandledCommand,
  UnknownAggregate,
  UnknownEvent,
  UnlistedRewrite,
  UnknownRead,
  UnknownSource,
  UnreadRecord,
  UnknownWait,
  UnknownStream,
  UnmatchedRoute,
  WriterKeyMismatch,
} from "./DefinitionError.ts";
import type * as Event from "./Event.ts";
import { decidedAt, judge, pathsWithoutJson, rejectionTag, settle } from "./internal.ts";
import * as Key from "./Key.ts";
import {
  type Accepted,
  type AggregateKit,
  type Change,
  type Reached,
  type DecideResult,
  type DecisionKit,
  type DecisionRead,
  type DecisionReceiptJson,
  type DecisionWrite,
  type Delivery,
  type EmittedRange,
  type EnvelopeJson,
  type HandleResult,
  type Json,
  type PolicyKit,
  type ReceiptJson,
  type Root,
  type StoredEvent,
  type StreamEntry,
  type ViewEntry,
  type ViewKit,
  type ViewInput,
  type ViewSnapshot,
  sameJson,
  viewInputOf,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import type * as Projection from "./Projection.ts";
import type * as Query from "./Query.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as Rewrite from "./Rewrite.ts";
import type * as DomainStream from "./Stream.ts";
import * as Telemetry from "./Telemetry.ts";
import { findPlain, Unsealed } from "./Vault.ts";
import type * as View from "./View.ts";

/**
 * The entities of a Domain.
 */
export interface Definitions {
  readonly aggregates: ReadonlyArray<Aggregate.Any>;
  /** The decisions that implement commands across several aggregates. */
  readonly decisions?: ReadonlyArray<Decision.Any>;
  readonly views: ReadonlyArray<View.Any>;
  readonly policies: ReadonlyArray<Policy.Any>;
  readonly projections: ReadonlyArray<Projection.Any>;
  readonly streams: ReadonlyArray<DomainStream.Any>;
  readonly queries?: ReadonlyArray<Query.Any>;
  /** The rewrites that may be run on the model's aggregates. */
  readonly rewrites?: ReadonlyArray<Rewrite.Any>;
  /** The compactions of the model's aggregates. */
  readonly compactions?: ReadonlyArray<Compaction.Any>;
}

/** What a compaction's Layer gives the kernel. */
export interface CompactionRuntime {
  readonly afterEvents: number | undefined;
  readonly archive: (id: string, events: ReadonlyArray<StoredEvent>) => Effect.Effect<void>;
}

/**
 * What a projection input carries for `Stream.append`, out of sight of the
 * handler's types: who is writing, where in its input log, and the source
 * event being handled. Appends count up per input, so a re-run of the same
 * input makes exactly the same writes.
 *
 * @internal
 */
export const InputMeta = Symbol.for("alchemy/Domain/Projection/InputMeta");

/** @internal */
export interface InputMetaValue {
  readonly projection: string;
  readonly key: string;
  /** The projection's generation: its input log starts over at each one. */
  readonly generation: number;
  readonly position: number;
  readonly source: string;
  readonly sourceSeq: number;
  /** The aggregate event the input derives from, through any views. */
  readonly root: Root;
  readonly at: number;
  readonly commandId: string;
  /** Appends made for this input so far in this run. */
  appends: number;
}

export { DefinitionError };

interface JsonCodec {
  readonly encode: (value: unknown) => Json;
  readonly decode: (json: Json) => any;
}

const jsonCodec = (schema: Schema.Top): JsonCodec => {
  const codec = Schema.toCodecJson(schema as any) as any;
  return {
    // oxlint-disable-next-line effecttsgo/schema-sync -- JsonCodec is sync by contract
    encode: Schema.encodeUnknownSync(codec),
    // oxlint-disable-next-line effecttsgo/schema-sync -- JsonCodec is sync by contract
    decode: Schema.decodeUnknownSync(codec),
  };
};

/** @internal */
export const encodeEnvelope = (
  envelope: Aggregate.Envelope,
  trace?: Telemetry.TraceJson,
): EnvelopeJson => ({
  id: envelope.id,
  stream: envelope.stream,
  seq: envelope.seq,
  at: DateTime.toEpochMillis(envelope.at),
  commandId: envelope.commandId,
  correlationId: envelope.correlationId,
  ...(trace ? { trace } : {}),
});

/** @internal */
export const decodeEnvelope = (json: EnvelopeJson): Aggregate.Envelope => ({
  id: json.id,
  stream: json.stream,
  seq: json.seq,
  at: DateTime.makeUnsafe(json.at),
  commandId: json.commandId,
  correlationId: json.correlationId ?? json.commandId,
});

/** The aggregate event a delivery derives from: its own, unless a view passed it on. @internal */
export const rootOf = (delivery: Delivery): Root =>
  delivery.root ?? { source: delivery.source, seq: delivery.seq };

/** The structural attributes of a delivery a reaction handles. */
const deliveryAttributes = (delivery: Delivery): Record<string, unknown> => ({
  "domain.source": delivery.source,
  "domain.seq": delivery.seq,
  "domain.event": delivery.tag,
  "domain.command_id": delivery.envelope.commandId,
  "domain.correlation_id": delivery.envelope.correlationId ?? delivery.envelope.commandId,
});

/** A reaction to one delivery continues the trace of the commit that caused it. */
const parentOf = (delivery: Delivery) =>
  delivery.envelope.trace ? Telemetry.spanOf(delivery.envelope.trace) : undefined;

/**
 * The pure semantics shared by every platform: decide, evolve, reply,
 * routing and view application, plus every codec.
 */
export interface Kernel {
  readonly aggregateKit: (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => Omit<AggregateKit, "push">;
  readonly decisionKit: (decision: Decision.Any) => DecisionKit;
  readonly viewKit: (
    view: View.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => Omit<ViewKit, "push">;
  readonly policyKit: (
    policy: Policy.Any,
    handler: (trigger: unknown) => Effect.Effect<void>,
  ) => PolicyKit;
  /** Decode a run of a projection key's input log into handler inputs. */
  readonly projectionInputs: (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ) => Effect.Effect<ReadonlyArray<unknown>>;
  /** Decode a run of revisions in a projection key's input log into `rewrite` inputs. */
  readonly projectionRewrites: (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ) => Effect.Effect<ReadonlyArray<unknown>>;
  /** The projections a rewrite can reach: those given an event it changes, through any views. */
  readonly rewriteReach: (rewrite: Rewrite.Any) => ReadonlyArray<string>;
  /** A rewrite's encoded input. */
  readonly encodeRewrite: (rewrite: { readonly _tag: string }) => Effect.Effect<Json>;
  /** What a compaction's Layer says, once it is built: set before the platform starts. */
  readonly setCompaction: (name: string, runtime: CompactionRuntime) => void;
  /** Decode a stored event with its envelope. */
  readonly decodeStored: (
    row: StoredEvent,
  ) => Effect.Effect<{ readonly event: unknown; readonly envelope: Aggregate.Envelope }>;
  /**
   * The keys of a projection an event of a source (an aggregate instance, or
   * a view key with its encoded `state` after the event) is routed to: empty
   * if the projection does not consume it.
   */
  readonly projectionKeys: (
    projection: Projection.Any,
    source: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
    state?: Json,
  ) => ReadonlyArray<string>;
  /** The keys of a view an event of a source (as for `projectionKeys`) reaches. */
  readonly viewKeys: (
    view: View.Any,
    source: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
    state?: Json,
  ) => ReadonlyArray<string>;
  /** Every view and projection in the model, by `CatchUp.targetId`: what catches up. */
  readonly targets: ReadonlyArray<string>;
  /**
   * Whether every key of a consumer (by `CatchUp.targetId`) hears from exactly one
   * source instance, the one with its own id: it needs no merge and no barrier.
   */
  readonly singleSource: (target: string) => boolean;
  /**
   * The sources (aggregates and views, by name) a consumer reads, by
   * `CatchUp.targetId`; `undefined` for one this model doesn't have.
   */
  readonly sourcesOf: (target: string) => ReadonlyArray<string> | undefined;
  /** What a backfill needs to know of a consumer; `undefined` for one this model doesn't have. */
  readonly planOf: (target: string) => Plan | undefined;
  /**
   * Route a source instance's stored rows (as its `log` returns them) to one
   * consumer only, as history: each row's seq and its deliveries.
   */
  readonly history: (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /**
   * Set a view's or projection's version (`view:Name` or `projection:Name`).
   * Bumping it rebuilds the consumer, and every view or projection that reads
   * it, from the history. Set every version before the platform starts.
   */
  readonly setVersion: (consumer: string, version: number) => void;
  /** A consumer's generation: its version plus those of the views it reads. */
  readonly generationOf: (kind: "view" | "projection", name: string) => number;
  /** The generation of a consumer's storage: a view rebuilt in place keeps it. */
  readonly classGenerationOf: (kind: "view" | "projection", name: string) => number;
  /** A consumer's id, by `CatchUp.targetId`. */
  readonly targetIdOf: (kind: "view" | "projection", name: string) => string;
  /** Whether a view is rebuilt in place: keyed by the one aggregate it reads. */
  readonly inPlace: (kind: "view" | "projection", name: string) => boolean;
  /** The projection that writes a stream, if any. */
  readonly writerOf: (stream: DomainStream.Any) => Projection.Any | undefined;
  readonly decodeStreamEntry: (
    entry: StreamEntry,
  ) => Effect.Effect<DomainStream.Entry<unknown, string>>;
  readonly encodeCommand: (
    aggregate: Aggregate.Any,
    command: { readonly _tag: string },
  ) => Effect.Effect<Json>;
  readonly decodeRejection: (aggregate: Aggregate.Any, json: Json) => unknown;
  readonly decodeReceipt: (
    aggregate: Aggregate.Any,
    commandTag: string,
    json: ReceiptJson,
  ) => Effect.Effect<Aggregate.Receipt>;
  readonly decodeState: (aggregate: Aggregate.Any, json: Json) => unknown;
  readonly encodeDecisionCommand: (
    decision: Decision.Any,
    command: { readonly _tag: string },
  ) => Effect.Effect<Json>;
  readonly decodeDecisionRejection: (decision: Decision.Any, json: Json) => unknown;
  readonly decodeDecisionReceipt: (
    decision: Decision.Any,
    json: DecisionReceiptJson,
  ) => Effect.Effect<Decision.Receipt>;
  readonly decodeViewState: (view: View.Any, json: Json) => unknown;
  readonly decodeViewEntry: (
    view: View.Any,
    entry: ViewEntry,
  ) => Effect.Effect<View.Entry<unknown, unknown>>;
  readonly decodeEvent: (json: Json) => Effect.Effect<unknown>;
  readonly encodeEvent: (event: { readonly _tag: string }) => Effect.Effect<Json>;
}

/**
 * Build the kernel for a set of definitions. Validates tags and routing, and
 * dies with a {@link DefinitionError} for every problem, in definition order:
 * each one is a defect of the Cause.
 */
export const make = (
  definitions: Definitions,
  telemetry: Telemetry.Resolved = Telemetry.resolve(undefined),
): Effect.Effect<Kernel> =>
  Effect.suspend(() => {
    const { kernel, problems } = collect(definitions, telemetry);
    return problems.length > 0
      ? Effect.failCause(Cause.fromReasons(problems.map(Cause.makeDieReason)))
      : Effect.succeed(kernel);
  });

/**
 * Why an `initial` state does not come back the same from JSON text, if it
 * does not. A schema like `Schema.Any` lets a value through that JSON drops
 * or refuses, such as a function or a `bigint`.
 */
const jsonRoundTrip = (
  codec: Schema.Codec<unknown, unknown>,
  encoded: unknown,
): string | undefined => {
  const text = Result.try(() => JSON.stringify(encoded));
  if (Result.isFailure(text)) return describe(text.failure);
  if (text.success === undefined) return "it encodes to nothing";
  const back = Schema.decodeUnknownExit(codec)(JSON.parse(text.success));
  if (Exit.isFailure(back)) return back.cause.pipe(Cause.squash, describe);
  const again = Schema.encodeUnknownExit(codec)(back.value);
  if (Exit.isFailure(again)) return again.cause.pipe(Cause.squash, describe);
  return JSON.stringify(again.value) === text.success
    ? undefined
    : `${text.success} comes back different`;
};
const describe = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause);

/** Build the kernel and collect every definition problem, each once, in order. */
const collect = (definitions: Definitions, telemetry: Telemetry.Resolved) => {
  const problems: Array<DefinitionError> = [];
  const seen = new Set<string>();
  const kernel = build(definitions, telemetry, (problem) => {
    if (seen.has(problem.message)) return;
    seen.add(problem.message);
    problems.push(problem);
  });
  return { kernel, problems };
};

/**
 * Build the kernel. Each definition problem goes to `report`, and the build
 * goes on past it, so {@link make} reports every problem.
 */
const build = (
  definitions: Definitions,
  telemetry: Telemetry.Resolved,
  report: (problem: DefinitionError) => void,
): Kernel => {
  const problem = (reason: Reason) => report(new DefinitionError({ reason }));
  /** A host stores and sends every value as JSON: each schema must have a JSON form. */
  const requireJson = (schema: Schema.Top, path: string) => {
    for (const at of pathsWithoutJson(schema.ast, path)) problem(new NoJsonForm({ path: at }));
  };
  const requireCommandJson = (command: Command.Any) => {
    requireJson(command, `Command ${command.tag}`);
    if (command.reply) requireJson(command.reply, `Command ${command.tag}.reply`);
    for (const rejection of command.rejects) {
      requireJson(rejection, `Rejection ${rejectionTag(rejection)}`);
    }
  };
  /** The JSON an `initial` state is stored as, once it is known to survive JSON. */
  const encodeInitial = (owner: string, schema: Schema.Top, initial: unknown): Json => {
    const codec: Schema.Codec<unknown, unknown> = Schema.toCodecJson(schema as any) as any;
    const encoded = Schema.encodeUnknownExit(codec)(initial);
    if (Exit.isFailure(encoded)) {
      problem(new InvalidInitial({ owner, cause: Cause.squash(encoded.cause) }));
      return null;
    }
    const detail = jsonRoundTrip(codec, encoded.value);
    if (detail !== undefined) problem(new InitialNotJson({ owner, detail }));
    return encoded.value;
  };
  // ---------------------------------------------------------------- events
  const eventCodecs = new Map<string, { readonly cls: Event.Any; readonly codec: JsonCodec }>();
  const registerEvent = (cls: Event.Any) => {
    const existing = eventCodecs.get(cls.tag);
    if (existing && existing.cls !== cls) {
      return problem(new DuplicateEventTag({ tag: cls.tag }));
    }
    if (!existing) {
      requireJson(cls, `Event ${cls.tag}`);
      eventCodecs.set(cls.tag, { cls, codec: jsonCodec(cls) });
    }
  };
  for (const aggregate of definitions.aggregates) {
    for (const event of aggregate.definition.events) registerEvent(event);
  }
  const eventCodec = (tag: string) => {
    const entry = eventCodecs.get(tag);
    return entry
      ? Effect.succeed(entry.codec)
      : Effect.die(new DefinitionError({ reason: new UnknownEvent({ event: tag }) }));
  };
  const encodeEvent = (event: { readonly _tag: string }): Effect.Effect<Json> =>
    Effect.flatMap(eventCodec(event._tag), (codec) => {
      const encoded = codec.encode(event);
      // A value made with `plain` is sealed when a command carries it in; one
      // that reaches an event any other way is never stored.
      const plain = findPlain(encoded);
      return plain === undefined
        ? Effect.succeed(encoded)
        : Effect.die(Unsealed.make({ subject: plain.subject, event: event._tag }));
    });
  const decodeEvent = (json: Json): Effect.Effect<unknown> =>
    Effect.map(eventCodec((json as { _tag: string })._tag), (codec) => codec.decode(json));

  // ----------------------------------------------------- aggregate codecs
  interface AggregateCodecs {
    readonly state: JsonCodec;
    readonly initial: Json;
    readonly commands: Map<
      string,
      { readonly cls: Command.Any; readonly codec: JsonCodec; readonly reply?: JsonCodec }
    >;
    readonly rejections: Map<string, JsonCodec>;
    readonly events: Set<string>;
  }
  const aggregateCodecs = new Map<string, AggregateCodecs>();
  const aggregateByName = new Map<string, Aggregate.Any>();
  for (const aggregate of definitions.aggregates) {
    if (aggregateByName.has(aggregate.aggregateName)) {
      problem(new DuplicateDefinition({ kind: "aggregate", entity: aggregate.aggregateName }));
      continue;
    }
    aggregateByName.set(aggregate.aggregateName, aggregate);
    const def = aggregate.definition;
    const state = jsonCodec(def.state);
    requireJson(def.state, `${aggregate.aggregateName}.state`);
    const commands = new Map<string, { cls: Command.Any; codec: JsonCodec; reply?: JsonCodec }>();
    const rejections = new Map<string, JsonCodec>();
    for (const command of def.commands) {
      requireCommandJson(command);
      commands.set(command.tag, {
        cls: command,
        codec: jsonCodec(command),
        reply: command.reply ? jsonCodec(command.reply) : undefined,
      });
      for (const rejection of command.rejects) {
        const tag = rejectionTag(rejection);
        if (!rejections.has(tag)) rejections.set(tag, jsonCodec(rejection));
      }
    }
    const initial = encodeInitial(aggregate.aggregateName, def.state, def.initial);
    aggregateCodecs.set(aggregate.aggregateName, {
      state,
      initial,
      commands,
      rejections,
      events: new Set(def.events.map((e: Event.Any) => e.tag)),
    });
  }
  const codecsOf = (aggregate: Aggregate.Any) => aggregateCodecs.get(aggregate.aggregateName)!;

  // ------------------------------------------------ rewrites and compactions
  const rewriteByName = new Map<string, { readonly cls: Rewrite.Any; readonly codec: JsonCodec }>();
  for (const rewrite of definitions.rewrites ?? []) {
    const name = rewrite.rewriteName;
    if (rewriteByName.has(name)) {
      problem(new DuplicateDefinition({ kind: "rewrite", entity: name }));
      continue;
    }
    const of = rewrite.definition.of;
    if (aggregateByName.get(of.aggregateName) !== of) {
      problem(new UnknownAggregate({ owner: `Rewrite ${name}`, aggregate: of.aggregateName }));
      continue;
    }
    requireJson(rewrite, `Rewrite ${name}`);
    rewriteByName.set(name, { cls: rewrite, codec: jsonCodec(rewrite) });
  }
  const compactionByName = new Map<string, Compaction.Any>();
  const compactionRuntimes = new Map<string, CompactionRuntime>();
  for (const compaction of definitions.compactions ?? []) {
    const name = compaction.compactionName;
    if (compactionByName.has(name)) {
      problem(new DuplicateDefinition({ kind: "compaction", entity: name }));
      continue;
    }
    const of = compaction.definition.of;
    if (aggregateByName.get(of.aggregateName) !== of) {
      problem(new UnknownAggregate({ owner: `Compaction ${name}`, aggregate: of.aggregateName }));
      continue;
    }
    compactionByName.set(name, compaction);
  }

  // ------------------------------------------------------ decision codecs
  interface DecisionCodecs {
    readonly command: JsonCodec;
    readonly reply?: JsonCodec;
    readonly rejections: Map<string, JsonCodec>;
  }
  const decisionCodecs = new Map<string, DecisionCodecs>();
  // Every command has one implementation: an aggregate, or a decision.
  const implementers = new Map<string, string>();
  const implement = (command: string, by: string) => {
    const first = implementers.get(command);
    if (first === undefined) implementers.set(command, by);
    else if (first !== by) problem(new ImplementedTwice({ command, first, second: by }));
  };
  for (const aggregate of aggregateByName.values()) {
    for (const command of aggregate.definition.commands) {
      implement(command.tag, aggregate.aggregateName);
    }
  }
  for (const decision of definitions.decisions ?? []) {
    const command = decision.command;
    if (decisionCodecs.has(decision.decisionName)) {
      problem(
        new ImplementedTwice({
          command: command.tag,
          first: `the decision ${decision.decisionName}`,
          second: "another decision",
        }),
      );
      continue;
    }
    implement(command.tag, `the decision ${decision.decisionName}`);
    requireCommandJson(command);
    for (const aggregate of new Set(Object.values(decision.reads))) {
      if (aggregateByName.get(aggregate.aggregateName) !== aggregate) {
        problem(
          new UnknownRead({ decision: decision.decisionName, aggregate: aggregate.aggregateName }),
        );
      }
    }
    const rejections = new Map<string, JsonCodec>();
    for (const rejection of command.rejects) {
      const tag = rejectionTag(rejection);
      if (!rejections.has(tag)) rejections.set(tag, jsonCodec(rejection));
    }
    decisionCodecs.set(decision.decisionName, {
      command: jsonCodec(command),
      reply: command.reply ? jsonCodec(command.reply) : undefined,
      rejections,
    });
  }

  // --------------------------------------------------------------- sources
  type SourceEntry =
    | { readonly kind: "aggregate"; readonly aggregate: Aggregate.Any }
    | { readonly kind: "view"; readonly view: View.Any };
  const sources = new Map<string, SourceEntry>();
  const addSource = (name: string, entry: SourceEntry) => {
    if (sources.has(name)) return problem(new DuplicateName({ entity: name }));
    sources.set(name, entry);
  };
  for (const aggregate of definitions.aggregates) {
    addSource(aggregate.aggregateName, { kind: "aggregate", aggregate });
  }
  for (const view of definitions.views) {
    addSource(view.viewName, { kind: "view", view });
    for (const event of view.definition.events ?? []) registerEvent(event);
  }
  const nameOf = (source: View.Source) =>
    source.kind === "Aggregate"
      ? (source as Aggregate.Any).aggregateName
      : (source as View.Any).viewName;
  const sourceEntry = (owner: string, source: View.Source): SourceEntry | undefined => {
    const entry = sources.get(nameOf(source));
    const entity = entry?.kind === "aggregate" ? entry.aggregate : entry?.view;
    if (entity !== source) {
      problem(new UnknownSource({ consumer: owner, source: nameOf(source) }));
      return undefined;
    }
    return entry;
  };
  /** The key that identifies a source's instances: its aggregate, or a view's key. */
  const keyOfSource = (entry: SourceEntry): Key.Any =>
    entry.kind === "aggregate" ? entry.aggregate : entry.view.definition.key;

  for (const stream of definitions.streams) {
    if (sources.has(stream.streamName)) {
      problem(new DuplicateName({ entity: stream.streamName }));
    }
    for (const event of stream.definition.entries) registerEvent(event);
  }

  /** Does a view take this event from this source? */
  const consumes = (view: View.Any, tag: string, source: string) => {
    const def = view.definition;
    return Boolean(
      def.evolve?.[tag] ||
      def.evolve?.[source] ||
      def.emit?.[tag] ||
      def.emit?.[source] ||
      def.events?.some((event) => event.tag === tag),
    );
  };
  /** The tags of the events a source produces. */
  const outputs = new Map<string, ReadonlySet<string>>();
  const visiting = new Set<string>();
  const outputTags = (entry: SourceEntry): ReadonlySet<string> => {
    if (entry.kind === "aggregate") return codecsOf(entry.aggregate).events;
    const view = entry.view;
    const known = outputs.get(view.viewName);
    if (known) return known;
    if (view.definition.events) {
      const declared = new Set(view.definition.events.map((event) => event.tag));
      outputs.set(view.viewName, declared);
      return declared;
    }
    if (visiting.has(view.viewName)) {
      problem(new ConsumesItself({ view: view.viewName }));
      return new Set();
    }
    visiting.add(view.viewName);
    const tags = new Set<string>();
    for (const source of view.definition.from) {
      const upstream = sourceEntry(view.viewName, source);
      if (!upstream) continue;
      for (const tag of outputTags(upstream)) {
        if (consumes(view, tag, nameOf(source))) tags.add(tag);
      }
    }
    visiting.delete(view.viewName);
    outputs.set(view.viewName, tags);
    return tags;
  };

  // --------------------------------------------------------------- routing
  /** What routing sees of an event. */
  interface RouteInput {
    readonly event: unknown;
    /** The source instance: a ref, or a Schema-keyed view's key value. */
    readonly source: unknown;
    readonly envelope: Aggregate.Envelope;
    readonly state: unknown;
    /** The source stream, e.g. `Account/a-1`. */
    readonly stream: string;
  }
  type Route = (input: RouteInput) => ReadonlyArray<{
    readonly key: string;
    readonly routes?: ReadonlyArray<string>;
  }>;
  interface Subscriber {
    readonly kind: "view" | "policy" | "projection";
    readonly name: string;
    readonly route: Route;
  }
  type Handler = (...args: ReadonlyArray<unknown>) => unknown;
  type HandlerMap = { readonly [key: string]: Handler | Record<string, Handler | undefined> };
  const handlers = (value: unknown) => value as HandlerMap | undefined;

  const subscribers = new Map<string, Map<string, Array<Subscriber>>>();
  const subscribe = (source: string, tag: string, subscriber: Subscriber) => {
    const byTag = subscribers.get(source) ?? new Map<string, Array<Subscriber>>();
    subscribers.set(source, byTag);
    const list = byTag.get(tag) ?? [];
    byTag.set(tag, list);
    list.push(subscriber);
  };

  /** Routes that key an event by its own source instance: key `x` hears only from instance `x`. */
  const identityRoutes = new WeakSet<Route>();

  /** How a consumer keyed by `def.key` routes `tag` from `source`. */
  const keyRoute = (
    owner: string,
    def: { readonly key: Key.Any; readonly keyOf?: unknown },
    upstream: SourceEntry,
    source: string,
    tag: string,
  ): Route => {
    const custom = handlers(def.keyOf)?.[tag] ?? handlers(def.keyOf)?.[source];
    const routing = (input: RouteInput) => ({
      event: input.event,
      source: input.source,
      state: input.state,
      envelope: input.envelope,
    });
    // A route returns a ref for an aggregate key, or the value of a Schema key.
    if (typeof custom === "function") {
      return (input) => {
        const ref = custom(routing(input));
        return ref === undefined ? [] : [{ key: Aggregate.targetId(ref) }];
      };
    }
    if (custom) {
      const routes = Object.entries(custom);
      return (input) => {
        const byKey = new Map<string, Array<string>>();
        for (const [route, fn] of routes) {
          const ref = fn?.(routing(input));
          if (ref === undefined) continue;
          const key = Aggregate.targetId(ref);
          const list = byKey.get(key) ?? [];
          byKey.set(key, list);
          list.push(route);
        }
        return [...byKey].map(([key, names]) => ({ key, routes: names }));
      };
    }
    if (keyOfSource(upstream) === def.key) {
      const route: Route = (input) => [{ key: Aggregate.targetId(input.source) }];
      identityRoutes.add(route);
      return route;
    }
    problem(
      new MissingKeyOf({
        consumer: owner,
        event: tag,
        source,
        keyedBy: Key.isAggregate(def.key) ? def.key.aggregateName : undefined,
      }),
    );
    return () => [];
  };

  for (const view of definitions.views) {
    const def = view.definition;
    if (def.state !== undefined && def.initial === undefined) {
      problem(new MissingInitial({ view: view.viewName }));
    }
    if (def.state !== undefined) {
      requireJson(def.state, `${view.viewName}.state`);
      if (def.initial !== undefined) encodeInitial(view.viewName, def.state, def.initial);
    }
    // Route-keyed handlers need the same routes in keyOf.
    for (const field of ["evolve", "emit"] as const) {
      for (const [name, handler] of Object.entries(handlers(def[field]) ?? {})) {
        if (typeof handler === "function" || !handler) continue;
        const routes = handlers(def.keyOf)?.[name];
        for (const route of Object.keys(handler)) {
          if (typeof routes !== "object" || !(route in routes)) {
            problem(
              new UnmatchedRoute({ view: view.viewName, handler: field, source: name, route }),
            );
          }
        }
      }
    }
    for (const source of def.from) {
      const upstream = sourceEntry(view.viewName, source);
      if (!upstream) continue;
      const name = nameOf(source);
      for (const tag of outputTags(upstream)) {
        if (!consumes(view, tag, name)) continue;
        subscribe(name, tag, {
          kind: "view",
          name: view.viewName,
          route: keyRoute(view.viewName, def, upstream, name, tag),
        });
      }
    }
  }

  const fromList = (from: Policy.From): ReadonlyArray<View.Source> =>
    Array.isArray(from) ? from : [from as View.Source];

  /** Subscribe a consumer to the `on` events its sources produce. */
  const subscribeConsumer = (
    kind: "policy" | "projection",
    owner: string,
    from: ReadonlyArray<View.Source>,
    on: ReadonlyArray<Event.Any>,
    route: (upstream: SourceEntry, source: string, tag: string) => Route,
  ) => {
    for (const event of on) {
      let produced = false;
      for (const source of from) {
        const upstream = sourceEntry(owner, source);
        if (!upstream) {
          produced = true; // already reported
          continue;
        }
        if (!outputTags(upstream).has(event.tag)) continue;
        produced = true;
        const name = nameOf(source);
        subscribe(name, event.tag, {
          kind,
          name: owner.replace(/^(Policy|Projection) /, ""),
          route: route(upstream, name, event.tag),
        });
      }
      if (!produced) {
        problem(new NoEmitter({ consumer: owner, sources: from.map(nameOf), event: event.tag }));
      }
    }
  };

  const policyByName = new Map<string, Policy.Any>();
  for (const policy of definitions.policies) {
    if (policyByName.has(policy.policyName)) {
      problem(new DuplicateDefinition({ kind: "policy", entity: policy.policyName }));
      continue;
    }
    policyByName.set(policy.policyName, policy);
    const def = policy.definition;
    const owner = `Policy ${policy.policyName}`;
    subscribeConsumer("policy", owner, fromList(def.from), def.on, (upstream, source, tag) =>
      def.key
        ? keyRoute(owner, { key: def.key, keyOf: def.keyOf }, upstream, source, tag)
        : // Unkeyed: one partition per source instance, so its triggers run in order.
          (input) => [{ key: input.stream }],
    );
  }

  const projectionByName = new Map<string, Projection.Any>();
  const writers = new Map<string, Projection.Any>();
  const streamNames = new Set(definitions.streams.map((stream) => stream.streamName));
  for (const projection of definitions.projections) {
    const name = projection.projectionName;
    if (projectionByName.has(name)) {
      problem(new DuplicateDefinition({ kind: "projection", entity: name }));
      continue;
    }
    projectionByName.set(name, projection);
    const def = projection.definition;
    const owner = `Projection ${name}`;
    subscribeConsumer("projection", owner, def.from, def.on, (upstream, source, tag) =>
      keyRoute(owner, def, upstream, source, tag),
    );
    for (const stream of def.writes ?? []) {
      if (!streamNames.has(stream.streamName)) {
        problem(new UnknownStream({ writer: owner, stream: stream.streamName }));
        continue;
      }
      const existing = writers.get(stream.streamName);
      if (existing && existing !== projection) {
        problem(
          new TwoWriters({
            stream: stream.streamName,
            first: existing.projectionName,
            second: name,
          }),
        );
        continue;
      }
      if (stream.definition.key !== def.key) {
        problem(
          new WriterKeyMismatch({
            writer: owner,
            key: Key.describe(def.key),
            stream: stream.streamName,
            streamKey: Key.describe(stream.definition.key),
          }),
        );
        continue;
      }
      writers.set(stream.streamName, projection);
    }
  }

  // ---------------------------------------------------------------- queries
  // A query is a method of an Api's client, beside its commands, views,
  // streams and aggregates, so it shares their names.
  const callNames = new Set([
    ...sources.keys(),
    ...streamNames,
    ...definitions.aggregates.flatMap((aggregate) =>
      aggregate.definition.commands.map((command: Command.Any) => command.tag),
    ),
  ]);
  const queryNames = new Set<string>();
  for (const query of definitions.queries ?? []) {
    const name = query.queryName;
    if (queryNames.has(name)) {
      problem(new DuplicateDefinition({ kind: "query", entity: name }));
      continue;
    }
    queryNames.add(name);
    if (callNames.has(name)) problem(new DuplicateName({ entity: name }));
    const def = query.definition;
    if (def.paged && !def.success) problem(new PagedWithoutSuccess({ query: name }));
    for (const read of def.waitsFor ?? []) {
      const [readName, held] =
        read.kind === "Projection"
          ? [read.projectionName, projectionByName.get(read.projectionName) === read]
          : read.kind === "View"
            ? [read.viewName, definitions.views.includes(read)]
            : [read.streamName, definitions.streams.includes(read)];
      if (!held) problem(new UnknownWait({ query: name, read: readName }));
    }
  }

  // ------------------------------------------------------------ generations
  const versions = new Map<string, number>();
  const generations = new Map<string, number>();
  const viewSources = (from: ReadonlyArray<View.Source>) =>
    from.flatMap((source) => (source.kind === "Aggregate" ? [] : [(source as View.Any).viewName]));
  const viewByName = new Map(definitions.views.map((view) => [view.viewName, view]));
  /** A consumer's own version: a view's from its declaration, a projection's from its Layer. */
  const versionOf = (kind: "view" | "projection", name: string) =>
    versions.get(`${kind}:${name}`) ??
    (kind === "view" ? (viewByName.get(name)?.definition.version ?? 0) : 0);
  /**
   * A consumer's generation: its own version plus the generations of the
   * views it reads, so rebuilding a view rebuilds everything built on it.
   */
  const generationOf = (kind: "view" | "projection" | "policy", name: string): number => {
    if (kind === "policy") return 0;
    const id = `${kind}:${name}`;
    const known = generations.get(id);
    if (known !== undefined) return known;
    const from =
      kind === "view"
        ? viewByName.get(name)?.definition.from
        : projectionByName.get(name)?.definition.from;
    const generation =
      versionOf(kind, name) +
      viewSources(from ?? []).reduce((sum, view) => sum + generationOf("view", view), 0);
    generations.set(id, generation);
    return generation;
  };
  /**
   * A view keyed by the one aggregate it reads is rebuilt in place: every key
   * holds exactly its own instance's events, so it can read them again itself.
   */
  const inPlace = (kind: "view" | "projection" | "policy", name: string): boolean => {
    if (kind !== "view") return false;
    const from = viewByName.get(name)?.definition.from ?? [];
    return (
      from.length === 1 &&
      from[0]!.kind === "Aggregate" &&
      singleSource(CatchUp.targetId({ kind, name }))
    );
  };
  /**
   * The generation of a consumer's storage (its Durable Object class): its
   * generation, except that a view rebuilt in place keeps its storage.
   */
  const classGenerationOf = (kind: "view" | "projection", name: string): number =>
    inPlace(kind, name) ? 0 : generationOf(kind, name);
  /** Where a subscriber's deliveries go, with its generation when it has one. */
  const targetOf = (subscriber: Pick<Subscriber, "kind" | "name">): Delivery["target"] => {
    const generation = generationOf(subscriber.kind, subscriber.name);
    return {
      kind: subscriber.kind,
      name: subscriber.name,
      ...(generation > 0 ? { generation } : {}),
      ...(generation > 0 && inPlace(subscriber.kind, subscriber.name) ? { inPlace: true } : {}),
    };
  };
  /** A consumer's id, by `CatchUp.targetId`, in this code. */
  const targetIdOf = (kind: "view" | "projection", name: string) =>
    CatchUp.targetId(targetOf({ kind, name }));

  /** Every delivery an event produces; only to the consumers in `only`, if given. */
  const fanOut = (
    input: RouteInput,
    delivery: Omit<Delivery, "target" | "key" | "routes">,
    only?: ReadonlySet<string>,
  ): Array<Delivery> => {
    const out: Array<Delivery> = [];
    for (const subscriber of subscribers.get(delivery.origin)?.get(delivery.tag) ?? []) {
      const target = targetOf(subscriber);
      if (only && !only.has(CatchUp.targetId(target))) continue;
      for (const { key, routes } of subscriber.route(input)) {
        out.push({
          ...delivery,
          target,
          key,
          ...(routes ? { routes } : {}),
        });
      }
    }
    return out;
  };

  /** The views and projections that consume a source: the consumers it catches up. */
  const targetsOf = (source: string): ReadonlyArray<string> => {
    const out = new Set<string>();
    for (const list of subscribers.get(source)?.values() ?? []) {
      for (const subscriber of list) {
        if (subscriber.kind !== "policy") out.add(CatchUp.targetId(targetOf(subscriber)));
      }
    }
    return [...out].sort();
  };

  /**
   * Whether every key of a consumer has exactly one source: it hears only from
   * the instance with its own id, of one source. Such a key has nothing to merge
   * and nothing to wait for: it can take its history as soon as its source has it.
   */
  const singleSource = (target: string): boolean => {
    const [kind, rest] = target.split(":") as [string, string];
    const name = rest.replace(/[#@]\d+$/, "");
    const sources = new Set<string>();
    for (const [source, byTag] of subscribers) {
      for (const list of byTag.values()) {
        for (const subscriber of list) {
          if (subscriber.kind !== kind || subscriber.name !== name) continue;
          if (!identityRoutes.has(subscriber.route)) return false;
          sources.add(source);
        }
      }
    }
    return sources.size === 1;
  };

  /**
   * The sources (aggregates and views, by name) a consumer reads, by
   * `CatchUp.targetId`; `undefined` for one this model doesn't have.
   */
  const sourcesOf = (target: string): ReadonlyArray<string> | undefined => {
    const [kind, rest] = target.split(":") as [string, string];
    const name = (rest ?? "").replace(/[#@]\d+$/, "");
    const known =
      kind === "view"
        ? definitions.views.some((view) => view.viewName === name)
        : definitions.projections.some((projection) => projection.projectionName === name);
    if (!known) return undefined;
    const sources = new Set<string>();
    for (const [source, byTag] of subscribers) {
      for (const list of byTag.values()) {
        if (list.some((subscriber) => subscriber.kind === kind && subscriber.name === name))
          sources.add(source);
      }
    }
    return [...sources].sort();
  };

  const planOf = (target: string): Plan | undefined => {
    const sources = sourcesOf(target);
    if (sources === undefined) return undefined;
    // Rebuilt views among its sources: their keys are the objects named for their generation.
    const generations: Record<string, number> = {};
    for (const source of sources) {
      if (!definitions.views.some((view) => view.viewName === source)) continue;
      // Where the source's keys are stored: a view rebuilt in place keeps its storage.
      const generation = classGenerationOf("view", source);
      if (generation > 0) generations[source] = generation;
    }
    return {
      sources,
      singleSource: singleSource(target),
      ...(Object.keys(generations).length > 0 ? { generations } : {}),
    };
  };

  /** Each source's replay, built once: what routes its stored rows as history. */
  const replayers = new Map<
    string,
    {
      readonly replay: (input: CatchUp.ReplayInput<any>) => Effect.Effect<CatchUp.ReplayResult>;
      readonly seqOf: (row: any) => number;
    }
  >();
  const replayerOf = (source: string) => {
    let found = replayers.get(source);
    if (found) return found;
    const aggregate = definitions.aggregates.find((a) => a.aggregateName === source);
    const view = definitions.views.find((v) => v.viewName === source);
    if (aggregate)
      found = {
        replay: aggregateKit(aggregate, () => Effect.void).replay,
        seqOf: (row: StoredEvent) => row.envelope.seq,
      };
    else if (view)
      found = {
        replay: viewKit(view, () => Effect.void).replay,
        seqOf: (row: ViewEntry) => row.seq,
      };
    if (found) replayers.set(source, found);
    return found;
  };
  const history = (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ): Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  > => {
    const replayer = replayerOf(source);
    if (!replayer) return Effect.succeed([]);
    const targets = targetsOf(source);
    return Effect.forEach(rows, (row) => {
      const seq = replayer.seqOf(row);
      return Effect.map(
        replayer.replay({
          id,
          routed: Object.fromEntries(
            targets.map((t) => [t, t === target ? seq - 1 : Number.MAX_SAFE_INTEGER]),
          ),
          rows: [row],
        }),
        ({ deliveries }) => ({ seq, deliveries }),
      );
    });
  };

  /** Replay stored rows to the consumers lagging behind them, in order. */
  const replay = Effect.fnUntraced(function* <Row>(
    targets: ReadonlyArray<string>,
    input: CatchUp.ReplayInput<Row>,
    seqOf: (row: Row) => number,
    route: (row: Row, only: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<Delivery>>,
  ) {
    const routed: Record<string, number> = { ...input.routed };
    const deliveries: Array<Delivery> = [];
    for (const row of input.rows) {
      const seq = seqOf(row);
      const lagging = new Set(targets.filter((target) => (routed[target] ?? 0) < seq));
      if (lagging.size === 0) continue;
      deliveries.push(...(yield* route(row, lagging)));
      for (const target of lagging) routed[target] = seq;
    }
    return { deliveries, routed } satisfies CatchUp.ReplayResult;
  });

  const viewCodecs = new Map<string, JsonCodec>();
  const viewCodec = (view: View.Any) => {
    let codec = viewCodecs.get(view.viewName);
    if (!codec) viewCodecs.set(view.viewName, (codec = jsonCodec(view.definition.state!)));
    return codec;
  };
  /** Decode the state a delivery carries from a view source. */
  const sourceState = (entry: SourceEntry, json: Json) =>
    json === undefined || json === null || entry.kind !== "view" || !entry.view.definition.state
      ? json
      : viewCodec(entry.view).decode(json);

  // ------------------------------------------------------------- revisions
  const beforeOf = (delivery: Delivery): NonNullable<Delivery["revision"]>["before"] => ({
    tag: delivery.tag,
    event: delivery.event,
    ...(delivery.state === undefined ? {} : { state: delivery.state }),
    ...(delivery.routes ? { routes: delivery.routes } : {}),
  });
  /**
   * What one changed row is to each view and projection key: the row as it
   * is now for a key that still gets it, `gone` for one that no longer does.
   * Policies are not told: what they did has happened.
   */
  const revisions = (
    root: string,
    before: ReadonlyArray<Delivery>,
    after: ReadonlyArray<Delivery>,
  ): Array<Delivery> => {
    const id = (delivery: Delivery) => `${CatchUp.targetId(delivery.target)}|${delivery.key}`;
    const consumer = (delivery: Delivery) => delivery.target.kind !== "policy";
    const was = new Map(before.filter(consumer).map((delivery) => [id(delivery), delivery]));
    const out: Array<Delivery> = [];
    const still = new Set<string>();
    for (const delivery of after.filter(consumer)) {
      const old = was.get(id(delivery));
      still.add(id(delivery));
      out.push({
        ...delivery,
        history: true,
        revision: { root, n: 0, ...(old ? { before: beforeOf(old) } : {}) },
      });
    }
    for (const [key, old] of was) {
      if (still.has(key)) continue;
      out.push({
        ...old,
        history: true,
        revision: { root, n: 0, before: beforeOf(old), gone: true },
      });
    }
    return out;
  };
  /** The revisions of a run of changes, given how a row is routed. */
  const revise = <Row>(
    root: string,
    changes: ReadonlyArray<Change<Row>>,
    route: (row: Row) => Effect.Effect<ReadonlyArray<Delivery>>,
  ): Effect.Effect<ReadonlyArray<Delivery>> =>
    Effect.map(
      Effect.forEach(changes, (change) =>
        Effect.map(
          Effect.all([
            change.before === undefined ? Effect.succeed([]) : route(change.before),
            change.after === undefined ? Effect.succeed([]) : route(change.after),
          ]),
          ([before, after]) => revisions(root, before, after),
        ),
      ),
      (all) => all.flat(),
    );

  // ------------------------------------------------------------------ kits
  /** Fold decided events into an instance's state, stamp them, and route them. */
  const commitOf = (aggregate: Aggregate.Any) => {
    const def = aggregate.definition;
    const codecs = codecsOf(aggregate);
    return Effect.fnUntraced(function* (
      id: string,
      state: unknown,
      version: number,
      decided: ReadonlyArray<{ readonly _tag: string }>,
      now: DateTime.Utc,
      commandId: string,
      history: boolean,
      correlationId: string = commandId,
      trace?: Telemetry.TraceJson,
      at?: ReadonlyArray<number | null>,
    ) {
      const stream = `${aggregate.aggregateName}/${id}`;
      const events: Array<StoredEvent> = [];
      const deliveries: Array<Delivery> = [];
      const sourceRef = Aggregate.makeRef(aggregate, id);
      let next = state;
      for (const [index, event] of decided.entries()) {
        if (!codecs.events.has(event._tag)) {
          return yield* Effect.die(
            new DefinitionError({
              reason: new UndeclaredEvent({
                aggregate: aggregate.aggregateName,
                event: event._tag,
              }),
            }),
          );
        }
        const envelope: Aggregate.Envelope = {
          id,
          stream,
          seq: version + index + 1,
          at: typeof at?.[index] === "number" ? DateTime.makeUnsafe(at[index]) : now,
          commandId,
          correlationId,
        };
        next = (def.evolve as Record<string, (...args: any[]) => unknown>)[event._tag](
          next,
          event,
          envelope,
        );
        const stored: StoredEvent = {
          event: yield* encodeEvent(event),
          envelope: encodeEnvelope(envelope, trace),
        };
        events.push(stored);
        deliveries.push(
          ...fanOut(
            { event, source: sourceRef, envelope, state: undefined, stream },
            {
              source: stream,
              seq: envelope.seq,
              origin: aggregate.aggregateName,
              tag: event._tag,
              event: stored.event,
              envelope: stored.envelope,
              ...(history ? { history } : {}),
            },
          ),
        );
      }
      return { next, events, deliveries };
    });
  };

  const aggregateKit = (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ): Omit<AggregateKit, "push"> => {
    const def = aggregate.definition;
    const codecs = codecsOf(aggregate);
    // oxlint-disable-next-line effecttsgo/schema-sync -- ids decode synchronously when building refs
    const decodeId = Schema.decodeUnknownSync(def.id as any) as (u: unknown) => unknown;
    const commit = commitOf(aggregate);
    /** Route one stored event to its subscribers: those in `only`, or every one (policies too). */
    const routerOf = (rawId: string) => {
      const id = decodeId(rawId) as string;
      const stream = `${aggregate.aggregateName}/${id}`;
      const sourceRef = Aggregate.makeRef(aggregate, id);
      return (row: StoredEvent, only?: ReadonlySet<string>) =>
        Effect.map(decodeEvent(row.event), (event) =>
          fanOut(
            {
              event,
              source: sourceRef,
              envelope: decodeEnvelope(row.envelope),
              state: undefined,
              stream,
            },
            {
              source: stream,
              seq: row.envelope.seq,
              origin: aggregate.aggregateName,
              tag: (row.event as { readonly _tag: string })._tag,
              event: row.event,
              envelope: row.envelope,
              history: true,
            },
            only,
          ),
        );
    };
    return {
      name: aggregate.aggregateName,
      deliver,
      record: Effect.fnUntraced(function* (input) {
        const id = decodeId(input.id) as string;
        const state = codecs.state.decode(input.state ?? codecs.initial);
        const decided = (yield* Effect.forEach(input.events, decodeEvent)) as ReadonlyArray<{
          readonly _tag: string;
        }>;
        const result = yield* commit(
          id,
          state,
          input.version,
          decided,
          DateTime.makeUnsafe(input.now),
          input.commandId,
          false,
          input.correlationId,
          input.trace,
        );
        return {
          state: codecs.state.encode(result.next),
          version: input.version + decided.length,
          events: result.events,
          deliveries: result.deliveries,
        };
      }),
      // Read when used: versions are set once the whole model is built.
      consumerSingleSource: (target: string) => singleSource(target),
      get targets() {
        return targetsOf(aggregate.aggregateName);
      },
      replay: (input) =>
        replay(
          targetsOf(aggregate.aggregateName),
          input,
          (row) => row.envelope.seq,
          routerOf(input.id),
        ),
      consumersOf: (id, rows) =>
        Effect.map(
          Effect.forEach(rows, (row) => routerOf(id)(row)),
          (deliveries) => deliveries.flat(),
        ),
      rewrite: Effect.fnUntraced(function* (run) {
        const rewrite = rewriteByName.get(run.name);
        if (rewrite === undefined || rewrite.cls.definition.of !== aggregate) {
          return yield* Effect.die(
            new DefinitionError({
              reason: new UnlistedRewrite({ kind: "rewrite", entity: run.name }),
            }),
          );
        }
        const definition = rewrite.cls.definition as {
          readonly delete?: boolean;
          readonly events?: Record<string, ((...args: any[]) => unknown) | undefined>;
        };
        const input = rewrite.codec.decode(run.input);
        let state = codecs.state.decode(run.state ?? codecs.initial);
        const changes: Array<Change<StoredEvent>> = [];
        for (const row of run.events) {
          const event = (yield* decodeEvent(row.event)) as { readonly _tag: string };
          const envelope = decodeEnvelope(row.envelope);
          const seq = row.envelope.seq;
          const handler = definition.delete ? () => null : definition.events?.[event._tag];
          const next = (handler ? handler(event, input, envelope) : event) as
            | { readonly _tag: string }
            | null
            | undefined;
          if (next === undefined) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new InvalidRewrite({ rewrite: run.name, event: event._tag }),
              }),
            );
          }
          if (next === null) {
            changes.push({ seq, before: row });
            continue;
          }
          if (next !== event) {
            if (!codecs.events.has(next._tag)) {
              return yield* Effect.die(
                new DefinitionError({
                  reason: new UndeclaredEvent({
                    aggregate: aggregate.aggregateName,
                    event: next._tag,
                  }),
                }),
              );
            }
            const encoded = yield* encodeEvent(next);
            if (!sameJson(encoded, row.event)) {
              changes.push({ seq, before: row, after: { event: encoded, envelope: row.envelope } });
            }
          }
          state = (def.evolve as Record<string, (...args: any[]) => unknown>)[next._tag](
            state,
            next,
            envelope,
          );
        }
        return { state: definition.delete ? null : codecs.state.encode(state), changes };
      }),
      deletes: (name) =>
        (rewriteByName.get(name)?.cls.definition as { readonly delete?: boolean } | undefined)
          ?.delete === true,
      broken: (json) => {
        const state = codecs.state.decode(json ?? codecs.initial);
        for (const [name, holds] of Object.entries(def.invariants ?? {})) {
          if (!(holds as (state: unknown) => boolean)(state)) return name;
        }
        return undefined;
      },
      revise: (rawId, root, changes) => {
        const id = decodeId(rawId) as string;
        const stream = `${aggregate.aggregateName}/${id}`;
        const sourceRef = Aggregate.makeRef(aggregate, id);
        return revise(root, changes, (row) =>
          Effect.map(decodeEvent(row.event), (event) =>
            fanOut(
              {
                event,
                source: sourceRef,
                envelope: decodeEnvelope(row.envelope),
                state: undefined,
                stream,
              },
              {
                source: stream,
                seq: row.envelope.seq,
                origin: aggregate.aggregateName,
                tag: (row.event as { readonly _tag: string })._tag,
                event: row.event,
                envelope: row.envelope,
                history: true,
              },
            ),
          ),
        );
      },
      reached: (rawId, events) => {
        const id = decodeId(rawId) as string;
        const stream = `${aggregate.aggregateName}/${id}`;
        const sourceRef = Aggregate.makeRef(aggregate, id);
        return Effect.map(
          Effect.forEach(events, (row) =>
            Effect.map(decodeEvent(row.event), (event) =>
              fanOut(
                {
                  event,
                  source: sourceRef,
                  envelope: decodeEnvelope(row.envelope),
                  state: undefined,
                  stream,
                },
                {
                  source: stream,
                  seq: row.envelope.seq,
                  origin: aggregate.aggregateName,
                  tag: (row.event as { readonly _tag: string })._tag,
                  event: row.event,
                  envelope: row.envelope,
                },
              ),
            ),
          ),
          (all) => {
            const out = new Map<string, Reached>();
            for (const { target, key } of all.flat()) {
              if (target.kind !== "view") continue;
              out.set(`${target.name}|${key}`, { name: target.name, key });
            }
            return [...out.values()];
          },
        );
      },
      recall: (rawId, root, recall, reached) => {
        const id = decodeId(rawId) as string;
        const stream = `${aggregate.aggregateName}/${id}`;
        const definition = rewriteByName.get(recall.name)?.cls.definition as
          | { readonly delete?: boolean; readonly events?: Record<string, unknown> }
          | undefined;
        // A rewrite with no handlers leaves every event as it is.
        if (!definition?.delete && Object.keys(definition?.events ?? {}).length === 0) return [];
        return reached.flatMap(({ name, key }): Array<Delivery> => {
          // A view the model no longer has holds nothing to change.
          if (!definitions.views.some((view) => view.viewName === name)) return [];
          return [
            {
              target: targetOf({ kind: "view", name }),
              key,
              source: stream,
              seq: 0,
              origin: aggregate.aggregateName,
              tag: "",
              event: null,
              envelope: { id, stream, seq: 0, at: 0, commandId: root, correlationId: root },
              history: true,
              revision: { root, n: 0, recall },
            },
          ];
        });
      },
      rollup: Effect.fnUntraced(function* (input) {
        const compaction = compactionByName.get(input.name);
        if (compaction === undefined || compaction.definition.of !== aggregate) {
          return yield* Effect.die(
            new DefinitionError({
              reason: new UnlistedRewrite({ kind: "compaction", entity: input.name }),
            }),
          );
        }
        const id = decodeId(input.id) as string;
        const state = codecs.state.decode(input.state ?? codecs.initial);
        const same = (other: unknown) =>
          sameJson(codecs.state.encode(other), codecs.state.encode(state));
        const now = DateTime.makeUnsafe(input.now);
        const commandId = `compact:${input.name}:${input.version}`;
        const events = (
          compaction.definition.rollup as (
            state: unknown,
            ctx: { readonly id: string; readonly version: number },
          ) => ReadonlyArray<{ readonly _tag: string }>
        )(state, { id, version: input.version });
        // From nothing: what a consumer rebuilt after the compaction folds.
        const fresh = yield* commit(
          id,
          codecs.state.decode(codecs.initial),
          input.version,
          events,
          now,
          commandId,
          true,
        );
        if (!same(fresh.next)) return undefined;
        // On the instance itself: what it folds now.
        const result = yield* commit(id, state, input.version, events, now, commandId, true);
        if (!same(result.next)) return undefined;
        // Marked, so a view key that holds what it replaces keeps it unfolded.
        const marked = <Row extends { readonly envelope: EnvelopeJson }>(row: Row): Row => ({
          ...row,
          envelope: { ...row.envelope, rollup: input.version },
        });
        return {
          state: codecs.state.encode(result.next),
          version: input.version + events.length,
          events: result.events.map(marked),
          deliveries: result.deliveries.map(marked),
        };
      }),
      get compactions() {
        return [...compactionByName.values()]
          .filter((compaction) => compaction.definition.of === aggregate)
          .map((compaction) => {
            const runtime = compactionRuntimes.get(compaction.compactionName);
            return {
              name: compaction.compactionName,
              afterEvents: runtime?.afterEvents,
              archive: runtime?.archive ?? (() => Effect.void),
            };
          });
      },
      seed: Effect.fnUntraced(function* (input) {
        const id = decodeId(input.id) as string;
        const state = codecs.state.decode(input.state ?? codecs.initial);
        const decided = (yield* Effect.forEach(input.events, decodeEvent)) as ReadonlyArray<{
          readonly _tag: string;
        }>;
        const result = yield* commit(
          id,
          state,
          input.version,
          decided,
          DateTime.makeUnsafe(input.now),
          input.commandId,
          true,
          undefined,
          undefined,
          input.at,
        );
        return {
          state: codecs.state.encode(result.next),
          version: input.version + decided.length,
          events: result.events,
          deliveries: result.deliveries,
        };
      }),
      handle: (input) => {
        const tag = (input.command as { readonly _tag: string })._tag;
        const correlationId = input.correlationId ?? input.commandId;
        const base = {
          "domain.aggregate": aggregate.aggregateName,
          "domain.command": tag,
          "domain.id": String(input.id),
          "domain.stream": `${aggregate.aggregateName}/${input.id}`,
          "domain.command_id": input.commandId,
          "domain.correlation_id": correlationId,
        };
        const decideAndCommit = Effect.gen(function* () {
          const command = codecs.commands.get(tag);
          if (!command) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new UnhandledCommand({ aggregate: aggregate.aggregateName, command: tag }),
              }),
            );
          }
          const decoded = command.codec.decode(input.command) as { readonly _tag: string };
          const state = codecs.state.decode(input.state ?? codecs.initial);
          const id = decodeId(input.id) as string;
          const now = DateTime.makeUnsafe(input.now);
          let decision = Aggregate.decisionOf(aggregate, state, decoded, {
            id,
            now,
            commandId: input.commandId,
            stream: `${aggregate.aggregateName}/${id}`,
            version: input.version,
          });
          if (decision === undefined) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new UnhandledCommand({ aggregate: aggregate.aggregateName, command: tag }),
              }),
            );
          }
          // An effectful decision runs here, inside the decide span, with the
          // context the command was sent with (its only requirement, enforced
          // by `Aggregate.Decision`).
          if (Effect.isEffect(decision)) {
            const context = yield* RequestContext.restore(input.context);
            const settled = settle(
              yield* Effect.exit(
                Effect.provideContext(
                  decidedAt(decision, now),
                  context as Context.Context<unknown>,
                ),
              ),
            );
            if (settled._tag === "Failed")
              return yield* Effect.failCause(settled.cause as Cause.Cause<never>);
            decision = settled.decision;
          }
          const judged = judge(aggregate.aggregateName, command.cls, decision);
          if (judged._tag === "Undeclared") return yield* Effect.die(judged.error);
          if (judged._tag === "Rejected") {
            const rejection = judged.rejection;
            const codec = codecs.rejections.get(rejection._tag)!;
            yield* Effect.annotateCurrentSpan({ "domain.outcome": rejection._tag });
            return { _tag: "Rejected", rejection: codec.encode(rejection) } as HandleResult;
          }
          const trace = yield* Telemetry.currentTrace;
          const { next, events, deliveries } = yield* commit(
            id,
            state,
            input.version,
            judged.events,
            now,
            input.commandId,
            false,
            correlationId,
            trace,
          );
          const replyFn = (def.reply as Record<string, (...args: any[]) => unknown> | undefined)?.[
            decoded._tag
          ];
          const reply =
            replyFn && command.reply ? command.reply.encode(replyFn(next, judged.events)) : null;
          const decided = judged.events;
          yield* Effect.annotateCurrentSpan({
            "domain.outcome": "accepted",
            "domain.events": decided.length,
            "domain.version": input.version + decided.length,
          });
          const span = yield* Effect.orElseSucceed(Effect.currentSpan, () => undefined);
          const at = BigInt(input.now) * 1_000_000n;
          for (const [index, event] of decided.entries()) {
            span?.event(event._tag, at, { "domain.seq": input.version + index + 1 });
            yield* Telemetry.record(Telemetry.events, {
              "domain.aggregate": aggregate.aggregateName,
              "domain.event": event._tag,
            });
          }
          return {
            _tag: "Accepted",
            state: codecs.state.encode(next),
            version: input.version + decided.length,
            events,
            reply,
            deliveries,
          } as HandleResult;
        });
        return Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const result = yield* decideAndCommit.pipe(
            Effect.annotateLogs(base),
            Effect.withSpan(`Domain.decide ${aggregate.aggregateName}.${tag}`, {
              kind: "server",
              attributes: base,
              ...(input.trace && !input.link ? { parent: Telemetry.spanOf(input.trace) } : {}),
              ...(input.trace && input.link
                ? { links: [{ span: Telemetry.spanOf(input.trace), attributes: {} }] }
                : {}),
            }),
          );
          const outcome =
            result._tag === "Accepted"
              ? "accepted"
              : ((result.rejection as { readonly _tag?: string })._tag ?? "rejected");
          const tags = { "domain.aggregate": aggregate.aggregateName, "domain.command": tag };
          yield* Telemetry.record(Telemetry.commands, { ...tags, "domain.outcome": outcome });
          yield* Telemetry.record(
            Telemetry.commandDuration,
            tags,
            (yield* Clock.currentTimeMillis) - started,
          );
          return result;
        });
      },
    };
  };

  const decisionKit = (decision: Decision.Any): DecisionKit => {
    const name = decision.decisionName;
    const def = decision.definition;
    const command = decision.command;
    const codecs = decisionCodecs.get(name)!;
    const undeclared = (returned: string, list: "events" | "rejects") =>
      new DefinitionError({
        reason: new UndeclaredDecision({ aggregate: name, command: command.tag, returned, list }),
      });
    const named = Object.entries(def.reads);
    /**
     * The instances a decoded command involves: each once, in stream order,
     * and the stream (or streams) each name in `reads` stands for.
     */
    const readsOf = (decoded: unknown) => {
      const ids = def.keyOf(decoded);
      const byStream = new Map<
        string,
        { keys: Array<string>; aggregate: Aggregate.Any; id: string }
      >();
      const streams: Record<string, string | ReadonlyArray<string>> = {};
      for (const [key, aggregate] of named) {
        const streamOf = (id: string) => {
          const stream = `${aggregate.aggregateName}/${id}`;
          const found = byStream.get(stream);
          if (found === undefined) byStream.set(stream, { keys: [key], aggregate, id });
          else if (!found.keys.includes(key)) found.keys.push(key);
          return stream;
        };
        const id = ids[key]!;
        streams[key] = typeof id === "string" ? streamOf(id) : id.map(streamOf);
      }
      return {
        streams,
        reads: [...byStream.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([stream, read]) => ({ ...read, stream })),
      };
    };
    /** One value per name in `reads`: of its instance, or of each of its instances. */
    const byName = (
      streams: Record<string, string | ReadonlyArray<string>>,
      of: (stream: string) => unknown,
    ): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(streams).map(([key, stream]) => [
          key,
          typeof stream === "string" ? of(stream) : stream.map(of),
        ]),
      );
    return {
      name,
      reads: (json) =>
        Effect.sync((): ReadonlyArray<DecisionRead> =>
          readsOf(codecs.command.decode(json)).reads.map(({ keys, aggregate, id, stream }) => ({
            keys,
            aggregate: aggregate.aggregateName,
            id,
            stream,
          })),
        ),
      decide: (input) => {
        const correlationId = input.correlationId ?? input.commandId;
        const base = {
          "domain.decision": name,
          "domain.command": command.tag,
          "domain.command_id": input.commandId,
          "domain.correlation_id": correlationId,
        };
        const decide = Effect.gen(function* () {
          const decoded = codecs.command.decode(input.command) as { readonly _tag: string };
          const { streams, reads } = readsOf(decoded);
          const now = DateTime.makeUnsafe(input.now);
          const states = new Map(input.states.map((state) => [state.stream, state]));
          // What `decide` sees of each instance, under every name that stands for it.
          const seen = new Map<string, unknown>();
          const current = new Map<string, { state: unknown; version: number }>();
          for (const read of reads) {
            const stored = states.get(read.stream);
            const state = codecsOf(read.aggregate).state.decode(
              stored?.state ?? codecsOf(read.aggregate).initial,
            );
            const version = stored?.version ?? 0;
            current.set(read.stream, { state, version });
            seen.set(read.stream, {
              id: read.id,
              stream: read.stream,
              state,
              version,
              record: (event: unknown) => Decision.recorded(read.stream, event),
            });
          }
          let decision = def.decide(
            byName(streams, (stream) => seen.get(stream)),
            decoded,
            { commandId: input.commandId, now },
          );
          // An effectful decision runs inside the decide span, with the context
          // the command was sent with (its only requirement).
          if (Effect.isEffect(decision)) {
            const context = yield* RequestContext.restore(input.context);
            const settled = settle(
              yield* Effect.exit(
                Effect.provideContext(
                  decidedAt(decision, now),
                  context as Context.Context<unknown>,
                ),
              ),
            );
            if (settled._tag === "Failed")
              return yield* Effect.failCause(settled.cause as Cause.Cause<never>);
            decision = settled.decision;
          }
          if (!Array.isArray(decision)) {
            const rejection = decision as { readonly _tag: string };
            const codec = codecs.rejections.get(rejection?._tag);
            if (!codec) return yield* Effect.die(undeclared(String(rejection?._tag), "rejects"));
            yield* Effect.annotateCurrentSpan({ "domain.outcome": rejection._tag });
            return { _tag: "Rejected", rejection: codec.encode(rejection) } as DecideResult;
          }
          // Each event goes to the instance it was recorded on, in the order recorded.
          const recorded = new Map<string, Array<{ readonly _tag: string }>>();
          const events: Array<{ readonly _tag: string }> = [];
          // Where each event commits: its stream, and its place among that stream's.
          const at: Array<{ readonly stream: string; readonly seq: number }> = [];
          for (const item of decision as ReadonlyArray<unknown>) {
            const stream = Decision.recordedOn(item);
            if (stream === undefined || !current.has(stream)) {
              return yield* Effect.die(
                new DefinitionError({
                  reason: new UnreadRecord({
                    decision: name,
                    returned: String((item as { readonly _tag?: string } | null)?._tag ?? item),
                  }),
                }),
              );
            }
            const event = (item as Decision.Recorded<{ readonly _tag: string }>).event;
            if (!command.events.some((cls) => cls.tag === event._tag)) {
              return yield* Effect.die(undeclared(event._tag, "events"));
            }
            const list = recorded.get(stream);
            if (list) list.push(event);
            else recorded.set(stream, [event]);
            events.push(event);
            at.push({
              stream,
              seq: current.get(stream)!.version + recorded.get(stream)!.length,
            });
          }
          const trace = yield* Telemetry.currentTrace;
          const writes: Array<DecisionWrite> = [];
          const after = new Map<string, unknown>();
          for (const read of reads) {
            const { state, version } = current.get(read.stream)!;
            const decided = recorded.get(read.stream) ?? [];
            for (const event of decided) {
              if (!codecsOf(read.aggregate).events.has(event._tag)) {
                return yield* Effect.die(
                  new DefinitionError({
                    reason: new UndeclaredEvent({
                      aggregate: read.aggregate.aggregateName,
                      event: event._tag,
                    }),
                  }),
                );
              }
            }
            // The reply reads each instance's state after its events.
            const next =
              def.reply === undefined || decided.length === 0
                ? state
                : (yield* commitOf(read.aggregate)(
                    read.id,
                    state,
                    version,
                    decided,
                    now,
                    input.commandId,
                    false,
                    correlationId,
                  )).next;
            after.set(read.stream, next);
            writes.push({
              keys: read.keys,
              aggregate: read.aggregate.aggregateName,
              id: read.id,
              stream: read.stream,
              version,
              events: yield* Effect.forEach(decided, encodeEvent),
            });
          }
          yield* Effect.annotateCurrentSpan({
            "domain.outcome": "accepted",
            "domain.events": events.length,
          });
          for (const event of events) {
            yield* Telemetry.record(Telemetry.events, {
              "domain.aggregate": name,
              "domain.event": event._tag,
            });
          }
          return {
            _tag: "Accepted",
            writes,
            receipt: {
              commits: writes.map((write) => ({
                stream: write.stream,
                version: write.version + write.events.length,
              })),
              events: yield* Effect.forEach(events, encodeEvent),
              at,
              reply:
                def.reply && codecs.reply
                  ? codecs.reply.encode(
                      def.reply(
                        byName(streams, (stream) => after.get(stream)),
                        events,
                      ),
                    )
                  : null,
            },
            correlationId,
            ...(trace ? { trace } : {}),
          } as DecideResult;
        });
        return Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const result = yield* decide.pipe(
            Effect.annotateLogs(base),
            Effect.withSpan(`Domain.decide ${name}`, {
              kind: "server",
              attributes: base,
              ...(input.trace && !input.link ? { parent: Telemetry.spanOf(input.trace) } : {}),
              ...(input.trace && input.link
                ? { links: [{ span: Telemetry.spanOf(input.trace), attributes: {} }] }
                : {}),
            }),
          );
          const outcome =
            result._tag === "Accepted"
              ? "accepted"
              : ((result.rejection as { readonly _tag?: string })._tag ?? "rejected");
          const tags = { "domain.aggregate": name, "domain.command": command.tag };
          yield* Telemetry.record(Telemetry.commands, { ...tags, "domain.outcome": outcome });
          yield* Telemetry.record(
            Telemetry.commandDuration,
            tags,
            (yield* Clock.currentTimeMillis) - started,
          );
          return result;
        });
      },
    };
  };

  /** The handler for an input: by event tag, else by source name; per route if routed. */
  const pick = (
    map: HandlerMap | undefined,
    tag: string,
    source: string,
    route: string | undefined,
  ): Handler | undefined => {
    const handler = map?.[tag] ?? map?.[source];
    if (typeof handler === "function") return handler;
    return handler && route !== undefined ? handler[route] : undefined;
  };

  const viewKit = (
    view: View.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ): Omit<ViewKit, "push"> => {
    const def = view.definition;
    const stateful = def.state !== undefined;
    const codec = stateful ? viewCodec(view) : undefined;
    const declared = def.events ? new Set(def.events.map((event) => event.tag)) : undefined;
    const evolve = handlers(def.evolve);
    const emit = handlers(def.emit);
    const encodeState = (state: unknown) =>
      codec && state !== null && state !== undefined ? codec.encode(state) : null;
    /** Route one emitted entry to its subscribers: those in `only`, or every one (policies too). */
    const viewRouterOf = (id: string) => {
      const keyRef = Key.refOf(def.key, id);
      const stream = `${view.viewName}/${id}`;
      return (row: ViewEntry, only?: ReadonlySet<string>) =>
        Effect.map(decodeEvent(row.event), (event) =>
          fanOut(
            {
              event,
              source: keyRef,
              envelope: decodeEnvelope(row.envelope),
              state: codec && row.state !== null ? codec.decode(row.state) : null,
              stream,
            },
            {
              source: stream,
              seq: row.seq,
              origin: view.viewName,
              tag: (row.event as { readonly _tag: string })._tag,
              event: row.event,
              envelope: row.envelope,
              state: row.state,
              ...(row.root ? { root: row.root } : {}),
              history: true,
            },
            only,
          ),
        );
    };
    const kit: Omit<ViewKit, "push" | "refold" | "revise" | "recall"> = {
      name: view.viewName,
      deliver,
      consumerSingleSource: (target: string) => singleSource(target),
      get targets() {
        return targetsOf(view.viewName);
      },
      get generation() {
        return generationOf("view", view.viewName);
      },
      get classGeneration() {
        return classGenerationOf("view", view.viewName);
      },
      get target() {
        return targetIdOf("view", view.viewName);
      },
      get singleSource() {
        return singleSource(`view:${view.viewName}`);
      },
      history: (target, source, id, rows) => history(target, source, id, rows),
      replay: (input) =>
        replay(targetsOf(view.viewName), input, (row) => row.seq, viewRouterOf(input.id)),
      consumersOf: (id, rows) =>
        Effect.map(
          Effect.forEach(rows, (row) => viewRouterOf(id)(row)),
          (deliveries) => deliveries.flat(),
        ),
      observe: (key, batch) => (effect) => {
        if (!telemetry.views || batch.every((d) => d.history)) return effect;
        const traces = batch.flatMap((d) => (d.envelope.trace ? [d.envelope.trace] : []));
        const single = batch.length === 1 && traces.length === 1;
        const attributes = {
          "domain.view": view.viewName,
          "domain.key": key,
          "domain.batch": batch.length,
          ...(batch.length === 1 ? deliveryAttributes(batch[0]!) : {}),
        };
        return effect.pipe(
          Effect.withSpan(`Domain.view ${view.viewName}`, {
            kind: "consumer",
            attributes,
            ...(single
              ? { parent: Telemetry.spanOf(traces[0]!) }
              : { links: traces.map((t) => ({ span: Telemetry.spanOf(t), attributes: {} })) }),
          }),
          Effect.tap(() =>
            Telemetry.record(Telemetry.runs, {
              "domain.kind": "view",
              "domain.consumer": view.viewName,
              "domain.outcome": "ok",
            }),
          ),
        );
      },
      apply: (key, snapshot, batch) => applyBatch(key, snapshot, batch, false),
    };
    /**
     * `kit.apply`. `stored` is set for inputs the key has applied before (a
     * refold): each roll-up among them is folded, as it was the first time.
     */
    const applyBatch = Effect.fnUntraced(function* (
      key: string,
      snapshot: ViewSnapshot,
      batch: ReadonlyArray<Delivery>,
      stored: boolean,
    ) {
      {
        let current: unknown =
          codec && snapshot.state !== null ? codec.decode(snapshot.state) : null;
        let { version, seq } = snapshot;
        const checkpoints: Record<string, number> = { ...snapshot.checkpoints };
        let lastFact = snapshot.last;
        // Written before this record existed: each source's fills in on its next delivery.
        const emitted: Record<string, EmittedRange> = { ...snapshot.emitted };
        const folded: Record<string, number> = { ...snapshot.folded };
        let changed = false;
        const entries: Array<ViewEntry> = [];
        const downstream: Array<Delivery> = [];
        const inputs: Array<ViewInput> = [];
        const keyRef = Key.refOf(def.key, key);
        const stream = `${view.viewName}/${key}`;
        const generation = generationOf("view", view.viewName);
        for (const delivery of batch) {
          const sent = delivery.target.generation ?? 0;
          // For an earlier generation: sent by an instance still on older code.
          if (sent < generation) continue;
          if (sent > generation) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new NewerGeneration({ consumer: view.viewName, sent, runs: generation }),
              }),
            );
          }
          if ((checkpoints[delivery.source] ?? 0) >= delivery.seq) continue;
          // A roll-up of events the key already holds from this source: what
          // it folded from them stands, so the roll-up is kept and not folded.
          const rollup = delivery.envelope.rollup;
          const covered =
            !stored &&
            rollup !== undefined &&
            (checkpoints[delivery.source] ?? 0) > 0 &&
            folded[delivery.source] !== rollup;
          if (rollup !== undefined && !covered) folded[delivery.source] = rollup;
          checkpoints[delivery.source] = delivery.seq;
          lastFact = { stream: delivery.source, seq: delivery.seq };
          changed = true;
          const emittedBefore = seq;
          const seqs: Array<number> = [];
          inputs.push({ delivery, seqs, ...(covered ? { covered } : {}) });
          const origin = sources.get(delivery.origin)!;
          const event = (yield* decodeEvent(delivery.event)) as { readonly _tag: string };
          const envelope = decodeEnvelope(delivery.envelope);
          const context = {
            key: keyRef,
            source: Key.refOf(keyOfSource(origin), envelope.id),
            state: sourceState(origin, delivery.state),
            envelope,
            at: envelope.at,
          };
          for (const route of covered ? [] : (delivery.routes ?? [undefined])) {
            const before = stateful ? (current ?? def.initial) : null;
            const evolveFn = stateful
              ? pick(evolve, delivery.tag, delivery.origin, route)
              : undefined;
            if (evolveFn) {
              current = evolveFn(before, event, context) ?? null;
              version += 1;
            }
            const emitFn = pick(emit, delivery.tag, delivery.origin, route);
            const emitted = !declared
              ? evolveFn
                ? [event]
                : []
              : emitFn
                ? [emitFn(event, { ...context, before, after: current })].flat()
                : declared.has(delivery.tag)
                  ? [event]
                  : [];
            for (const out of emitted as ReadonlyArray<{ readonly _tag: string } | undefined>) {
              if (out === undefined) continue;
              if (declared && !declared.has(out._tag)) {
                return yield* Effect.die(
                  new DefinitionError({
                    reason: new UndeclaredEmit({ view: view.viewName, event: out._tag }),
                  }),
                );
              }
              seq += 1;
              seqs.push(seq);
              const outEnvelope: Aggregate.Envelope = {
                id: key,
                stream,
                seq,
                at: envelope.at,
                commandId: envelope.commandId,
                correlationId: envelope.correlationId,
              };
              const entry: ViewEntry = {
                seq,
                event: yield* encodeEvent(out),
                envelope: encodeEnvelope(outEnvelope, delivery.envelope.trace),
                state: encodeState(current),
                root: rootOf(delivery),
              };
              entries.push(entry);
              downstream.push(
                ...fanOut(
                  { event: out, source: keyRef, envelope: outEnvelope, state: current, stream },
                  {
                    source: stream,
                    seq,
                    origin: view.viewName,
                    tag: out._tag,
                    event: entry.event,
                    envelope: entry.envelope,
                    state: entry.state,
                    root: entry.root,
                    ...(delivery.history ? { history: true } : {}),
                  },
                ),
              );
            }
          }
          // What this command's deliveries from the source have become, so far.
          const commandId = delivery.envelope.commandId;
          const last = emitted[delivery.source];
          emitted[delivery.source] = {
            commandId,
            sourceSeq: delivery.seq,
            after: last?.commandId === commandId ? last.after : emittedBefore,
            through: seq,
          };
        }
        const next: ViewSnapshot = {
          state: encodeState(current),
          version,
          checkpoints,
          seq,
          ...(generation > 0 ? { generation } : {}),
          ...(lastFact === undefined ? {} : { last: lastFact }),
          emitted,
          ...(Object.keys(folded).length > 0 ? { folded } : {}),
        };
        return { snapshot: next, changed, entries, downstream, inputs };
      }
    });
    return Object.assign(kit, {
      refold: Effect.fnUntraced(function* (
        key: string,
        cursor: { readonly snapshot: ViewSnapshot; readonly top: number },
        rows: ReadonlyArray<ViewInput | Delivery>,
      ) {
        let snapshot = cursor.snapshot;
        let top = cursor.top;
        const inputs: Array<ViewInput> = [];
        const entries: Array<ViewEntry> = [];
        for (const row of rows) {
          const { delivery, seqs: had, covered } = viewInputOf(row);
          for (const seq of had ?? []) top = Math.max(top, seq);
          if (covered) {
            // Kept, never folded: the key has read its source through it.
            if ((snapshot.checkpoints[delivery.source] ?? 0) < delivery.seq) {
              snapshot = {
                ...snapshot,
                checkpoints: { ...snapshot.checkpoints, [delivery.source]: delivery.seq },
              };
            }
            inputs.push({ delivery, seqs: [], covered });
            continue;
          }
          const emitted = snapshot.emitted;
          const step = yield* applyBatch(key, snapshot, [delivery], true);
          if (!step.changed) continue;
          // Each entry keeps the seq its input's entry had; one more takes a new seq.
          const seqs: Array<number> = [];
          for (const [index, entry] of step.entries.entries()) {
            const seq = had?.[index] ?? ++top;
            seqs.push(seq);
            entries.push({ ...entry, seq, envelope: { ...entry.envelope, seq } });
          }
          const last = emitted?.[delivery.source];
          const commandId = delivery.envelope.commandId;
          const after =
            last?.commandId === commandId
              ? last.after
              : seqs.length > 0
                ? Math.min(...seqs) - 1
                : top;
          snapshot = {
            ...step.snapshot,
            emitted: {
              ...step.snapshot.emitted,
              [delivery.source]: {
                commandId,
                sourceSeq: delivery.seq,
                after,
                through: seqs.length > 0 ? Math.max(...seqs) : after,
              },
            },
          };
          inputs.push({ delivery, seqs });
        }
        return { snapshot, top, inputs, entries };
      }),
      recall: Effect.fnUntraced(function* (
        key: string,
        revised: Delivery,
        rows: ReadonlyArray<ViewInput | Delivery>,
      ) {
        const recall = revised.revision?.recall;
        const rewrite = recall === undefined ? undefined : rewriteByName.get(recall.name);
        if (recall === undefined || rewrite === undefined) return { rows, changed: false };
        const aggregate = rewrite.cls.definition.of as Aggregate.Any;
        const definition = rewrite.cls.definition as {
          readonly delete?: boolean;
          readonly events?: Record<string, ((...args: any[]) => unknown) | undefined>;
        };
        const input = rewrite.codec.decode(recall.input);
        const out: Array<ViewInput | Delivery> = [];
        let changed = false;
        for (const row of rows) {
          const { delivery, seqs, covered } = viewInputOf(row);
          if (
            delivery.source !== revised.source ||
            delivery.origin !== aggregate.aggregateName ||
            delivery.seq > recall.through
          ) {
            out.push(row);
            continue;
          }
          if (definition.delete) {
            changed = true;
            continue;
          }
          const handler = definition.events?.[delivery.tag];
          if (handler === undefined) {
            out.push(row);
            continue;
          }
          const event = (yield* decodeEvent(delivery.event)) as { readonly _tag: string };
          const envelope = decodeEnvelope(delivery.envelope);
          const next = handler(event, input, envelope) as
            | { readonly _tag: string }
            | null
            | undefined;
          if (next === undefined) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new InvalidRewrite({ rewrite: recall.name, event: event._tag }),
              }),
            );
          }
          if (next === null) {
            changed = true;
            continue;
          }
          const encoded = next === event ? delivery.event : yield* encodeEvent(next);
          if (sameJson(encoded, delivery.event)) {
            out.push(row);
            continue;
          }
          changed = true;
          // The event as it is now, if the key is still given it.
          const { target: _target, key: _key, routes: _routes, ...rest } = delivery;
          const now = fanOut(
            {
              event: next,
              source: Aggregate.makeRef(aggregate, envelope.id),
              envelope,
              state: undefined,
              stream: delivery.source,
            },
            { ...rest, tag: next._tag, event: encoded },
          ).find(
            (routed) =>
              routed.target.kind === "view" &&
              routed.target.name === view.viewName &&
              routed.key === key,
          );
          if (now === undefined) continue;
          out.push({ delivery: now, seqs: seqs ?? [], ...(covered ? { covered } : {}) });
        }
        return { rows: out, changed };
      }),
      revise: (key: string, root: string, changes: ReadonlyArray<Change<ViewEntry>>) => {
        const keyRef = Key.refOf(def.key, key);
        const stream = `${view.viewName}/${key}`;
        return revise(root, changes, (row) =>
          Effect.map(decodeEvent(row.event), (event) =>
            fanOut(
              {
                event,
                source: keyRef,
                envelope: decodeEnvelope(row.envelope),
                state: codec && row.state !== null ? codec.decode(row.state) : null,
                stream,
              },
              {
                source: stream,
                seq: row.seq,
                origin: view.viewName,
                tag: (row.event as { readonly _tag: string })._tag,
                event: row.event,
                envelope: row.envelope,
                state: row.state,
                ...(row.root ? { root: row.root } : {}),
                history: true,
              },
            ),
          ),
        );
      },
    });
  };

  const policyKit = (
    policy: Policy.Any,
    // The platform runs it inside its runtime, where the handler's RuntimeContext is.
    handler: (trigger: unknown) => Effect.Effect<void>,
  ): PolicyKit => {
    const policyKey = policy.definition.key;
    return {
      name: policy.policyName,
      run: (delivery) => {
        // Seeded history is the past; policies only react to what happens now.
        // A rewrite's revision is the past changed: what a policy did has happened.
        if (delivery.history || delivery.revision) return Effect.void;
        const upstream = sources.get(delivery.origin)!;
        const envelope = decodeEnvelope(delivery.envelope);
        const source = Key.refOf(keyOfSource(upstream), envelope.id);
        const key = policyKey ? Key.refOf(policyKey, delivery.key) : source;
        const state = sourceState(upstream, delivery.state);
        const attributes = {
          "domain.policy": policy.policyName,
          "domain.key": delivery.key,
          ...deliveryAttributes(delivery),
        };
        const parent = parentOf(delivery);
        return Effect.flatMap(decodeEvent(delivery.event), (event) =>
          Effect.forEach(
            delivery.routes ?? [undefined],
            (route) => {
              let n = 0;
              const prefix = `${delivery.source}:${delivery.seq}:${policy.policyName}${route === undefined ? "" : `:${route}`}`;
              return handler({ key, route, source, event, envelope, state }).pipe(
                Effect.provideContext(
                  Context.make(Aggregate.PolicyRun, { next: () => `${prefix}:${n++}` }).pipe(
                    Context.add(Telemetry.Correlation, { id: envelope.correlationId }),
                  ),
                ),
              );
            },
            { discard: true },
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const tags = { "domain.kind": "policy", "domain.consumer": policy.policyName };
              yield* Telemetry.record(Telemetry.lag, tags, now - delivery.envelope.at);
              yield* Telemetry.record(Telemetry.runs, {
                ...tags,
                "domain.outcome": Exit.isSuccess(exit) ? "ok" : "failed",
              });
            }),
          ),
          Effect.annotateLogs(attributes),
          Effect.withSpan(`Domain.policy ${policy.policyName}`, {
            kind: "consumer",
            attributes,
            ...(parent ? { parent } : {}),
          }),
        );
      },
    };
  };

  const projectionInputs = (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ): Effect.Effect<ReadonlyArray<unknown>> =>
    Effect.gen(function* () {
      const keyRef = Key.refOf(projection.definition.key, key);
      const generation = generationOf("projection", projection.projectionName);
      const inputs: Array<unknown> = [];
      for (const { delivery, position } of batch) {
        const upstream = sources.get(delivery.origin)!;
        const envelope = decodeEnvelope(delivery.envelope);
        const source = Key.refOf(keyOfSource(upstream), envelope.id);
        const event = yield* decodeEvent(delivery.event);
        const state = sourceState(upstream, delivery.state);
        // Shared by every route the delivery takes, so their appends count up together.
        const meta: InputMetaValue = {
          projection: projection.projectionName,
          key,
          generation,
          position,
          source: delivery.source,
          sourceSeq: delivery.seq,
          root: rootOf(delivery),
          at: delivery.envelope.at,
          commandId: delivery.envelope.commandId,
          appends: 0,
        };
        for (const route of delivery.routes ?? [undefined]) {
          const input = { key: keyRef, route, source, event, envelope, state, position };
          Object.defineProperty(input, InputMeta, { value: meta, enumerable: false });
          inputs.push(input);
        }
      }
      return inputs;
    });

  const projectionRewrites = (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ): Effect.Effect<ReadonlyArray<unknown>> =>
    Effect.gen(function* () {
      const keyRef = Key.refOf(projection.definition.key, key);
      const inputs: Array<unknown> = [];
      for (const { delivery, position } of batch) {
        const revision = delivery.revision;
        if (revision?.before === undefined) continue;
        const upstream = sources.get(delivery.origin)!;
        const envelope = decodeEnvelope(delivery.envelope);
        const source = Key.refOf(keyOfSource(upstream), envelope.id);
        const before = yield* decodeEvent(revision.before.event);
        const after = revision.gone ? undefined : yield* decodeEvent(delivery.event);
        const state = revision.gone ? undefined : sourceState(upstream, delivery.state);
        // An event that changed routes is one input per route it had or has.
        // What `Stream.rewrite` reads: the source event whose entries it replaces.
        const meta: InputMetaValue = {
          projection: projection.projectionName,
          key,
          generation: generationOf("projection", projection.projectionName),
          position,
          source: delivery.source,
          sourceSeq: delivery.seq,
          root: rootOf(delivery),
          at: delivery.envelope.at,
          commandId: delivery.envelope.commandId,
          appends: 0,
        };
        const was: ReadonlyArray<string | undefined> = revision.before.routes ?? [undefined];
        const is: ReadonlyArray<string | undefined> = revision.gone
          ? []
          : (delivery.routes ?? [undefined]);
        for (const route of new Set([...was, ...is])) {
          const had = was.includes(route);
          const has = is.includes(route);
          const input = {
            key: keyRef,
            route,
            source,
            envelope,
            before: had ? before : undefined,
            after: has ? after : undefined,
            state,
            position,
          };
          Object.defineProperty(input, InputMeta, { value: meta, enumerable: false });
          inputs.push(input);
        }
      }
      return inputs;
    });

  const rewriteReach = (rewrite: Rewrite.Any): ReadonlyArray<string> => {
    const of = rewrite.definition.of;
    const definition = rewrite.definition as {
      readonly delete?: boolean;
      readonly events?: Record<string, unknown>;
    };
    const changed: ReadonlySet<string> = definition.delete
      ? (aggregateCodecs.get(of.aggregateName)?.events ?? new Set())
      : new Set(Object.keys(definition.events ?? {}));
    // The tags of each source whose events the rewrite can change.
    const reached = new Map<string, ReadonlySet<string>>([[of.aggregateName, changed]]);
    for (let grew = true; grew;) {
      grew = false;
      for (const view of definitions.views) {
        if (reached.has(view.viewName)) continue;
        const entry = sources.get(view.viewName);
        if (entry === undefined) continue;
        const takes = view.definition.from.some((source) => {
          const name = nameOf(source);
          return [...(reached.get(name) ?? [])].some((tag) => consumes(view, tag, name));
        });
        if (!takes) continue;
        // A view's state rides on every entry, so any of them may change.
        reached.set(view.viewName, outputTags(entry));
        grew = true;
      }
    }
    return definitions.projections
      .filter((projection) =>
        projection.definition.from.some((source) => {
          const tags = reached.get(nameOf(source));
          return (
            tags !== undefined && projection.definition.on.some((event) => tags.has(event.tag))
          );
        }),
      )
      .map((projection) => projection.projectionName);
  };

  const consumerKeys = (
    kind: "view" | "projection",
    name: string,
    source: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
    state?: Json,
  ): ReadonlyArray<string> => {
    const entry = sources.get(source);
    if (entry === undefined) return [];
    const stream = `${source}/${id}`;
    const envelope: Aggregate.Envelope = {
      id,
      stream,
      seq,
      at: DateTime.makeUnsafe(0),
      commandId: "",
      correlationId: "",
    };
    const keys: Array<string> = [];
    for (const subscriber of subscribers.get(source)?.get(event._tag) ?? []) {
      if (subscriber.kind !== kind || subscriber.name !== name) continue;
      const input = {
        event,
        source:
          entry.kind === "aggregate"
            ? Aggregate.makeRef(entry.aggregate, id)
            : Key.refOf(keyOfSource(entry), id),
        envelope,
        state: entry.kind === "aggregate" ? undefined : sourceState(entry, state ?? null),
        stream,
      };
      for (const { key } of subscriber.route(input)) keys.push(key);
    }
    return keys;
  };

  const projectionKeys = (
    projection: Projection.Any,
    source: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
    state?: Json,
  ) => consumerKeys("projection", projection.projectionName, source, id, event, seq, state);
  const viewKeys = (
    view: View.Any,
    source: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
    state?: Json,
  ) => consumerKeys("view", view.viewName, source, id, event, seq, state);

  return {
    aggregateKit,
    decisionKit,
    viewKit,
    policyKit,
    projectionInputs,
    projectionRewrites,
    rewriteReach,
    encodeRewrite: (rewrite) => {
      const entry = rewriteByName.get(rewrite._tag);
      return entry
        ? Effect.sync(() => entry.codec.encode(rewrite))
        : Effect.die(
            new DefinitionError({
              reason: new UnlistedRewrite({ kind: "rewrite", entity: rewrite._tag }),
            }),
          );
    },
    setCompaction: (name, runtime) => void compactionRuntimes.set(name, runtime),
    decodeStored: (row) =>
      Effect.map(decodeEvent(row.event), (event) => ({
        event,
        envelope: decodeEnvelope(row.envelope),
      })),
    projectionKeys,
    viewKeys,
    get targets() {
      return [
        ...definitions.views.map((view) => targetIdOf("view", view.viewName)),
        ...definitions.projections.map((projection) =>
          targetIdOf("projection", projection.projectionName),
        ),
      ].sort();
    },
    singleSource,
    sourcesOf,
    planOf,
    history,
    setVersion: (consumer, version) => {
      versions.set(consumer, version);
      generations.clear();
    },
    generationOf,
    classGenerationOf,
    targetIdOf,
    inPlace,
    writerOf: (stream) => writers.get(stream.streamName),
    decodeStreamEntry: (entry) =>
      Effect.map(decodeEvent(entry.event), (event) => ({
        event,
        envelope: decodeEnvelope(entry.envelope),
      })),
    decodeEvent,
    encodeEvent,
    encodeCommand: (aggregate, command) => {
      const entry = codecsOf(aggregate).commands.get(command._tag);
      return entry
        ? Effect.sync(() => entry.codec.encode(command))
        : Effect.die(
            new DefinitionError({
              reason: new UnhandledCommand({
                aggregate: aggregate.aggregateName,
                command: command._tag,
              }),
            }),
          );
    },
    decodeRejection: (aggregate, json) =>
      codecsOf(aggregate)
        .rejections.get((json as { _tag: string })._tag)!
        .decode(json),
    decodeReceipt: (aggregate, commandTag, json) => {
      const reply = codecsOf(aggregate).commands.get(commandTag)?.reply;
      return Effect.map(Effect.forEach(json.events, decodeEvent), (events) => ({
        stream: json.stream,
        version: json.version,
        commits: [{ stream: json.stream, version: json.version }],
        events,
        reply: reply && json.reply !== null ? reply.decode(json.reply) : undefined,
      })) as Effect.Effect<Aggregate.Receipt>;
    },
    decodeState: (aggregate, json) => {
      const codecs = codecsOf(aggregate);
      return codecs.state.decode(json ?? codecs.initial);
    },
    encodeDecisionCommand: (decision, command) =>
      Effect.sync(() => decisionCodecs.get(decision.decisionName)!.command.encode(command)),
    decodeDecisionRejection: (decision, json) =>
      decisionCodecs
        .get(decision.decisionName)!
        .rejections.get((json as { _tag: string })._tag)!
        .decode(json),
    decodeDecisionReceipt: (decision, json) => {
      const reply = decisionCodecs.get(decision.decisionName)!.reply;
      return Effect.map(Effect.forEach(json.events, decodeEvent), (events) => ({
        commits: json.commits,
        events,
        reply: reply && json.reply !== null ? reply.decode(json.reply) : undefined,
      })) as Effect.Effect<Decision.Receipt>;
    },
    decodeViewState: (view, json) => viewCodec(view).decode(json),
    decodeViewEntry: (view, entry) =>
      Effect.map(decodeEvent(entry.event), (event) => ({
        event,
        state:
          entry.state === null || !view.definition.state
            ? null
            : viewCodec(view).decode(entry.state),
        envelope: decodeEnvelope(entry.envelope),
      })),
  };
};
