import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import * as Command from "./Command.ts";
import type * as Event from "./Event.ts";
import type {
  Accepted,
  AggregateKit,
  Delivery,
  EnvelopeJson,
  HandleResult,
  Json,
  PolicyKit,
  ReceiptJson,
  StoredEvent,
  StreamEntry,
  ViewEntry,
  ViewKit,
  ViewSnapshot,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import type * as Projection from "./Projection.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as DomainStream from "./Stream.ts";
import * as Telemetry from "./Telemetry.ts";
import type * as View from "./View.ts";

/**
 * The entities of a Domain.
 */
export interface Definitions {
  readonly aggregates: ReadonlyArray<Aggregate.Any>;
  readonly views: ReadonlyArray<View.Any>;
  readonly policies: ReadonlyArray<Policy.Any>;
  readonly projections: ReadonlyArray<Projection.Any>;
  readonly streams: ReadonlyArray<DomainStream.Any>;
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
  readonly position: number;
  readonly source: string;
  readonly sourceSeq: number;
  readonly at: number;
  readonly commandId: string;
  /** Appends made for this input so far in this run. */
  appends: number;
}

/**
 * A domain definition error (duplicate tag, missing `keyOf`, …), raised while
 * the kernel is built.
 */
export class DefinitionError extends Data.TaggedError("DefinitionError")<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

interface JsonCodec {
  readonly encode: (value: unknown) => Json;
  readonly decode: (json: Json) => any;
}

const jsonCodec = (schema: Schema.Top): JsonCodec => {
  const codec = Schema.toCodecJson(schema as any) as any;
  return {
    encode: Schema.encodeUnknownSync(codec),
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
  readonly viewKit: (
    view: View.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => Omit<ViewKit, "push">;
  readonly policyKit: (policy: Policy.Any, handler: Policy.Handler<unknown>) => PolicyKit;
  /** Decode a run of a projection key's input log into handler inputs. */
  readonly projectionInputs: (
    projection: Projection.Any,
    key: string,
    batch: ReadonlyArray<Accepted>,
  ) => ReadonlyArray<unknown>;
  /** The keys of a projection an aggregate's committed event is routed to (empty if it is not consumed). */
  readonly projectionKeys: (
    projection: Projection.Any,
    aggregate: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
  ) => ReadonlyArray<string>;
  /** The projection that writes a stream, if any. */
  readonly writerOf: (stream: DomainStream.Any) => Projection.Any | undefined;
  readonly decodeStreamEntry: (entry: StreamEntry) => DomainStream.Entry<unknown, string>;
  readonly encodeCommand: (aggregate: Aggregate.Any, command: { readonly _tag: string }) => Json;
  readonly decodeRejection: (aggregate: Aggregate.Any, json: Json) => unknown;
  readonly decodeReceipt: (
    aggregate: Aggregate.Any,
    commandTag: string,
    json: ReceiptJson,
  ) => Aggregate.Receipt;
  readonly decodeState: (aggregate: Aggregate.Any, json: Json | null) => unknown;
  readonly decodeViewState: (view: View.Any, json: Json) => unknown;
  readonly decodeViewEntry: (view: View.Any, entry: ViewEntry) => View.Entry<unknown, unknown>;
  readonly decodeEvent: (json: Json) => unknown;
  readonly encodeEvent: (event: { readonly _tag: string }) => Json;
}

/**
 * Build the kernel for a set of definitions. Validates tags and routing, and
 * dies with a {@link DefinitionError} for the first problem.
 */
export const make = (
  definitions: Definitions,
  telemetry: Telemetry.Resolved = Telemetry.resolve(undefined),
): Effect.Effect<Kernel> =>
  Effect.suspend(() => {
    const { kernel, problems } = collect(definitions, telemetry);
    return problems.length > 0 ? Effect.die(problems[0]) : Effect.succeed(kernel);
  });

/**
 * Every problem {@link make} would die with, without building anything.
 * Empty when the definitions are valid.
 */
export const verify = (definitions: Definitions): ReadonlyArray<DefinitionError> =>
  collect(definitions, Telemetry.resolve(undefined)).problems;

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
 * goes on past it, so {@link verify} sees every problem.
 */
const build = (
  definitions: Definitions,
  telemetry: Telemetry.Resolved,
  report: (problem: DefinitionError) => void,
): Kernel => {
  const problem = (message: string) => report(new DefinitionError(message));
  // ---------------------------------------------------------------- events
  const eventCodecs = new Map<string, { readonly cls: Event.Any; readonly codec: JsonCodec }>();
  const registerEvent = (cls: Event.Any) => {
    const existing = eventCodecs.get(cls.tag);
    if (existing && existing.cls !== cls) {
      return problem(`Two different events are tagged '${cls.tag}'`);
    }
    if (!existing) eventCodecs.set(cls.tag, { cls, codec: jsonCodec(cls) });
  };
  for (const aggregate of definitions.aggregates) {
    for (const event of aggregate.definition.events) registerEvent(event);
  }
  const eventCodec = (tag: string) => {
    const entry = eventCodecs.get(tag);
    if (!entry) throw new DefinitionError(`Unknown event '${tag}'`);
    return entry.codec;
  };
  const encodeEvent = (event: { readonly _tag: string }) => eventCodec(event._tag).encode(event);
  const decodeEvent = (json: Json) => eventCodec((json as { _tag: string })._tag).decode(json);
  /** The span attributes an event's declaration adds. */
  const eventAttributes = (event: { readonly _tag: string }) =>
    Telemetry.attributesOf(eventCodecs.get(event._tag)?.cls, event);

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
      problem(`Duplicate aggregate '${aggregate.aggregateName}'`);
      continue;
    }
    aggregateByName.set(aggregate.aggregateName, aggregate);
    const def = aggregate.definition;
    const state = jsonCodec(def.state);
    const commands = new Map<string, { cls: Command.Any; codec: JsonCodec; reply?: JsonCodec }>();
    const rejections = new Map<string, JsonCodec>();
    for (const command of def.commands) {
      // The payload carries the target and the idempotency key beside the
      // input, so an input field with either name never reaches `decide`.
      for (const field of ["target", "commandId"] satisfies Array<Command.ReservedField>) {
        if (field in command.input) {
          problem(
            `${command.tag} declares the input field '${field}', which its payload uses itself`,
          );
        }
      }
      commands.set(command.tag, {
        cls: command,
        codec: jsonCodec(command),
        reply: command.reply ? jsonCodec(command.reply) : undefined,
      });
      for (const rejection of command.rejects) {
        if (!rejections.has(rejection.tag)) rejections.set(rejection.tag, jsonCodec(rejection));
      }
    }
    let initial: Json = null;
    try {
      initial = state.encode(def.initial);
    } catch (error) {
      problem(
        `${aggregate.aggregateName}.initial does not match its state schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    aggregateCodecs.set(aggregate.aggregateName, {
      state,
      initial,
      commands,
      rejections,
      events: new Set(def.events.map((e: Event.Any) => e.tag)),
    });
  }
  const codecsOf = (aggregate: Aggregate.Any) => aggregateCodecs.get(aggregate.aggregateName)!;

  // --------------------------------------------------------------- sources
  type SourceEntry =
    | { readonly kind: "aggregate"; readonly aggregate: Aggregate.Any }
    | { readonly kind: "view"; readonly view: View.Any };
  const sources = new Map<string, SourceEntry>();
  const addSource = (name: string, entry: SourceEntry) => {
    if (sources.has(name)) return problem(`Two entities are named '${name}'`);
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
      problem(`${owner} consumes ${nameOf(source)}, which is not in the Domain`);
      return undefined;
    }
    return entry;
  };
  /** The aggregate whose refs identify a source's instances. */
  const keyAggregateOf = (entry: SourceEntry) =>
    entry.kind === "aggregate" ? entry.aggregate : entry.view.definition.key;

  for (const stream of definitions.streams) {
    if (sources.has(stream.streamName)) {
      problem(`Two entities are named '${stream.streamName}'`);
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
      problem(`${view.viewName} consumes itself through other views`);
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
    readonly source: Aggregate.Ref;
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

  /** How a consumer keyed by `def.key` routes `tag` from `source`. */
  const keyRoute = (
    owner: string,
    def: { readonly key: Aggregate.Any; readonly keyOf?: unknown },
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
    if (typeof custom === "function") {
      return (input) => {
        const ref = custom(routing(input)) as Aggregate.Ref | undefined;
        return ref ? [{ key: ref.id as string }] : [];
      };
    }
    if (custom) {
      const routes = Object.entries(custom);
      return (input) => {
        const byKey = new Map<string, Array<string>>();
        for (const [route, fn] of routes) {
          const ref = fn?.(routing(input)) as Aggregate.Ref | undefined;
          if (!ref) continue;
          const list = byKey.get(ref.id as string) ?? [];
          byKey.set(ref.id as string, list);
          list.push(route);
        }
        return [...byKey].map(([key, names]) => ({ key, routes: names }));
      };
    }
    if (keyAggregateOf(upstream) === def.key)
      return (input) => [{ key: input.source.id as string }];
    problem(
      `${owner} consumes '${tag}' from ${source}, which is not keyed by ${def.key.aggregateName}: add keyOf.${tag}`,
    );
    return () => [];
  };

  for (const view of definitions.views) {
    const def = view.definition;
    if (def.state !== undefined && def.initial === undefined) {
      problem(`${view.viewName} declares state without initial`);
    }
    // Route-keyed handlers need the same routes in keyOf.
    for (const field of ["evolve", "emit"] as const) {
      for (const [name, handler] of Object.entries(handlers(def[field]) ?? {})) {
        if (typeof handler === "function" || !handler) continue;
        const routes = handlers(def.keyOf)?.[name];
        for (const route of Object.keys(handler)) {
          if (typeof routes !== "object" || !(route in routes)) {
            problem(
              `${view.viewName}.${field}.${name}.${route} has no matching route in keyOf.${name}`,
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
        problem(`${owner}: none of ${from.map(nameOf).join(", ")} emits '${event.tag}'`);
      }
    }
  };

  const policyByName = new Map<string, Policy.Any>();
  for (const policy of definitions.policies) {
    if (policyByName.has(policy.policyName)) {
      problem(`Duplicate policy '${policy.policyName}'`);
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
      problem(`Duplicate projection '${name}'`);
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
        problem(`${owner} writes ${stream.streamName}, which is not in the Domain`);
        continue;
      }
      const existing = writers.get(stream.streamName);
      if (existing && existing !== projection) {
        problem(
          `${stream.streamName} has two writers, ${existing.projectionName} and ${name}: a stream key has exactly one`,
        );
        continue;
      }
      if (stream.definition.key !== def.key) {
        problem(
          `${owner} is keyed by ${def.key.aggregateName}, so it cannot write ${stream.streamName}, keyed by ${stream.definition.key.aggregateName}`,
        );
        continue;
      }
      writers.set(stream.streamName, projection);
    }
  }

  /** Every delivery an event produces. */
  const fanOut = (
    input: RouteInput,
    delivery: Omit<Delivery, "target" | "key" | "routes">,
  ): Array<Delivery> => {
    const out: Array<Delivery> = [];
    for (const subscriber of subscribers.get(delivery.origin)?.get(delivery.tag) ?? []) {
      for (const { key, routes } of subscriber.route(input)) {
        out.push({
          ...delivery,
          target: { kind: subscriber.kind, name: subscriber.name },
          key,
          ...(routes ? { routes } : {}),
        });
      }
    }
    return out;
  };

  const viewCodecs = new Map<string, JsonCodec>();
  const viewCodec = (view: View.Any) => {
    let codec = viewCodecs.get(view.viewName);
    if (!codec) viewCodecs.set(view.viewName, (codec = jsonCodec(view.definition.state!)));
    return codec;
  };
  /** Decode the state a delivery carries from a view source. */
  const sourceState = (entry: SourceEntry, json: Json | null | undefined) =>
    json === undefined || json === null || entry.kind !== "view" || !entry.view.definition.state
      ? json
      : viewCodec(entry.view).decode(json);

  // ------------------------------------------------------------------ kits
  const aggregateKit = (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ): Omit<AggregateKit, "push"> => {
    const def = aggregate.definition;
    const codecs = codecsOf(aggregate);
    const decodeId = Schema.decodeUnknownSync(def.id as any) as (u: unknown) => unknown;
    const commit = (
      id: string,
      state: unknown,
      version: number,
      decided: ReadonlyArray<{ readonly _tag: string }>,
      now: DateTime.Utc,
      commandId: string,
      history: boolean,
      correlationId: string = commandId,
      trace?: Telemetry.TraceJson,
    ) => {
      const stream = `${aggregate.aggregateName}/${id}`;
      const events: Array<StoredEvent> = [];
      const deliveries: Array<Delivery> = [];
      const sourceRef = Aggregate.makeRef(aggregate, id);
      let next = state;
      decided.forEach((event, index) => {
        if (!codecs.events.has(event._tag)) {
          throw new DefinitionError(
            `${aggregate.aggregateName} does not declare event '${event._tag}'`,
          );
        }
        const envelope: Aggregate.Envelope = {
          id,
          stream,
          seq: version + index + 1,
          at: now,
          commandId,
          correlationId,
        };
        next = (def.evolve as Record<string, (...args: any[]) => unknown>)[event._tag](
          next,
          event,
          envelope,
        );
        const stored: StoredEvent = {
          event: encodeEvent(event),
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
      });
      return { next, events, deliveries };
    };
    return {
      name: aggregate.aggregateName,
      deliver,
      seed: (input) => {
        const id = decodeId(input.id) as string;
        const state = codecs.state.decode(input.state ?? codecs.initial);
        const decided = input.events.map(decodeEvent);
        const result = commit(
          id,
          state,
          input.version,
          decided,
          DateTime.makeUnsafe(input.now),
          input.commandId,
          true,
        );
        return {
          state: codecs.state.encode(result.next),
          version: input.version + decided.length,
          events: result.events,
          deliveries: result.deliveries,
        };
      },
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
              new DefinitionError(`${aggregate.aggregateName} does not handle '${tag}'`),
            );
          }
          const decoded = command.codec.decode(input.command) as { readonly _tag: string };
          yield* Effect.annotateCurrentSpan(Telemetry.attributesOf(command.cls, decoded));
          const state = codecs.state.decode(input.state ?? codecs.initial);
          const id = decodeId(input.id) as string;
          const now = DateTime.makeUnsafe(input.now);
          let decision = (def.decide as Record<string, (...args: any[]) => unknown>)[decoded._tag](
            state,
            decoded,
            { id, now },
          );
          // An effectful decision runs here, inside the decide span, with the
          // context the command was sent with (its only requirement, enforced
          // by `Aggregate.Decision`).
          if (Effect.isEffect(decision)) {
            const exit = yield* Effect.exit(
              Effect.provideContext(
                decision as Effect.Effect<unknown, unknown, never>,
                RequestContext.restore(input.context),
              ),
            );
            if (Exit.isSuccess(exit)) {
              decision = exit.value;
            } else {
              const rejection = Cause.findErrorOption(exit.cause);
              if (Option.isNone(rejection))
                return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
              decision = rejection.value;
            }
          }
          if (!Array.isArray(decision)) {
            const rejection = decision as { readonly _tag: string };
            const codec = codecs.rejections.get(rejection._tag);
            const declared = command.cls.rejects.find((r) => r.tag === rejection._tag);
            if (!codec || !declared) {
              return yield* Effect.die(
                new DefinitionError(
                  `${aggregate.aggregateName}.decide.${decoded._tag} returned '${rejection?._tag}', which ${decoded._tag} does not declare in rejects`,
                ),
              );
            }
            yield* Effect.annotateCurrentSpan({
              "domain.outcome": rejection._tag,
              ...Telemetry.attributesOf(declared, rejection),
            });
            return { _tag: "Rejected", rejection: codec.encode(rejection) } as HandleResult;
          }
          for (const event of decision as ReadonlyArray<{ readonly _tag: string }>) {
            if (!command.cls.events.some((e) => e.tag === event._tag)) {
              return yield* Effect.die(
                new DefinitionError(
                  `${aggregate.aggregateName}.decide.${decoded._tag} returned '${event._tag}', which ${decoded._tag} does not declare in events`,
                ),
              );
            }
          }
          const trace = yield* Telemetry.currentTrace;
          const { next, events, deliveries } = commit(
            id,
            state,
            input.version,
            decision,
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
            replyFn && command.reply ? command.reply.encode(replyFn(next, decision)) : null;
          const decided = decision as ReadonlyArray<{ readonly _tag: string }>;
          yield* Effect.annotateCurrentSpan({
            "domain.outcome": "accepted",
            "domain.events": decided.length,
            "domain.version": input.version + decided.length,
          });
          const span = yield* Effect.orElseSucceed(Effect.currentSpan, () => undefined);
          const at = BigInt(input.now) * 1_000_000n;
          for (const [index, event] of decided.entries()) {
            span?.event(event._tag, at, {
              "domain.seq": input.version + index + 1,
              ...eventAttributes(event),
            });
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
          const started = yield* Effect.sync(() => Date.now());
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
            (yield* Effect.sync(() => Date.now())) - started,
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
    return {
      name: view.viewName,
      deliver,
      observe: (key, batch) => (effect) => {
        if (!telemetry.views || batch.length === 0 || batch.every((d) => d.history)) return effect;
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
      apply: (key, snapshot, batch) => {
        let current: unknown =
          codec && snapshot.state !== null ? codec.decode(snapshot.state) : null;
        let { version, seq } = snapshot;
        const checkpoints: Record<string, number> = { ...snapshot.checkpoints };
        let changed = false;
        const entries: Array<ViewEntry> = [];
        const downstream: Array<Delivery> = [];
        const keyRef = Aggregate.makeRef(def.key, key);
        const stream = `${view.viewName}/${key}`;
        for (const delivery of batch) {
          if ((checkpoints[delivery.source] ?? 0) >= delivery.seq) continue;
          checkpoints[delivery.source] = delivery.seq;
          changed = true;
          const origin = sources.get(delivery.origin)!;
          const event = decodeEvent(delivery.event) as { readonly _tag: string };
          const envelope = decodeEnvelope(delivery.envelope);
          const context = {
            key: keyRef,
            source: Aggregate.makeRef(keyAggregateOf(origin), envelope.id),
            state: sourceState(origin, delivery.state),
            envelope,
            at: envelope.at,
          };
          for (const route of delivery.routes ?? [undefined]) {
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
                throw new DefinitionError(
                  `${view.viewName} emitted '${out._tag}', which it does not declare in events`,
                );
              }
              seq += 1;
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
                event: encodeEvent(out),
                envelope: encodeEnvelope(outEnvelope, delivery.envelope.trace),
                state: encodeState(current),
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
                    ...(delivery.history ? { history: true } : {}),
                  },
                ),
              );
            }
          }
        }
        const next: ViewSnapshot = { state: encodeState(current), version, checkpoints, seq };
        return { snapshot: next, changed, entries, downstream };
      },
    };
  };

  const policyKit = (policy: Policy.Any, handler: Policy.Handler<unknown>): PolicyKit => {
    const keyAggregate = policy.definition.key;
    return {
      name: policy.policyName,
      run: (delivery) => {
        // Seeded history is the past; policies only react to what happens now.
        if (delivery.history) return Effect.void;
        const upstream = sources.get(delivery.origin)!;
        const envelope = decodeEnvelope(delivery.envelope);
        const source = Aggregate.makeRef(keyAggregateOf(upstream), envelope.id);
        const key = keyAggregate ? Aggregate.makeRef(keyAggregate, delivery.key) : source;
        const event = decodeEvent(delivery.event);
        const state = sourceState(upstream, delivery.state);
        const attributes = {
          "domain.policy": policy.policyName,
          "domain.key": delivery.key,
          ...deliveryAttributes(delivery),
        };
        const parent = parentOf(delivery);
        return Effect.forEach(
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
        ).pipe(
          Effect.tap(() =>
            Effect.annotateCurrentSpan(eventAttributes(event as { readonly _tag: string })),
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const now = yield* Effect.sync(() => Date.now());
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
  ): ReadonlyArray<unknown> => {
    const keyRef = Aggregate.makeRef(projection.definition.key, key);
    const inputs: Array<unknown> = [];
    for (const { delivery, position } of batch) {
      const upstream = sources.get(delivery.origin)!;
      const envelope = decodeEnvelope(delivery.envelope);
      const source = Aggregate.makeRef(keyAggregateOf(upstream), envelope.id);
      const event = decodeEvent(delivery.event);
      const state = sourceState(upstream, delivery.state);
      // Shared by every route the delivery takes, so their appends count up together.
      const meta: InputMetaValue = {
        projection: projection.projectionName,
        key,
        position,
        source: delivery.source,
        sourceSeq: delivery.seq,
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
  };

  const projectionKeys = (
    projection: Projection.Any,
    aggregate: string,
    id: string,
    event: { readonly _tag: string },
    seq: number,
  ): ReadonlyArray<string> => {
    const entry = sources.get(aggregate);
    if (entry?.kind !== "aggregate") return [];
    const stream = `${aggregate}/${id}`;
    const envelope: Aggregate.Envelope = {
      id,
      stream,
      seq,
      at: DateTime.makeUnsafe(0),
      commandId: "",
      correlationId: "",
    };
    const keys: Array<string> = [];
    for (const subscriber of subscribers.get(aggregate)?.get(event._tag) ?? []) {
      if (subscriber.kind !== "projection" || subscriber.name !== projection.projectionName)
        continue;
      const input = {
        event,
        source: Aggregate.makeRef(entry.aggregate, id),
        envelope,
        state: undefined,
        stream,
      };
      for (const { key } of subscriber.route(input)) keys.push(key);
    }
    return keys;
  };

  return {
    aggregateKit,
    viewKit,
    policyKit,
    projectionInputs,
    projectionKeys,
    writerOf: (stream) => writers.get(stream.streamName),
    decodeStreamEntry: (entry) => ({
      event: decodeEvent(entry.event),
      envelope: decodeEnvelope(entry.envelope),
    }),
    decodeEvent,
    encodeEvent,
    encodeCommand: (aggregate, command) => {
      const entry = codecsOf(aggregate).commands.get(command._tag);
      if (!entry)
        throw new DefinitionError(`${aggregate.aggregateName} does not handle '${command._tag}'`);
      return entry.codec.encode(command);
    },
    decodeRejection: (aggregate, json) =>
      codecsOf(aggregate)
        .rejections.get((json as { _tag: string })._tag)!
        .decode(json),
    decodeReceipt: (aggregate, commandTag, json) => {
      const reply = codecsOf(aggregate).commands.get(commandTag)?.reply;
      return {
        stream: json.stream,
        version: json.version,
        events: json.events.map(decodeEvent),
        reply: reply && json.reply !== null ? reply.decode(json.reply) : undefined,
      };
    },
    decodeState: (aggregate, json) => {
      const codecs = codecsOf(aggregate);
      return codecs.state.decode(json ?? codecs.initial);
    },
    decodeViewState: (view, json) => viewCodec(view).decode(json),
    decodeViewEntry: (view, entry) => ({
      event: decodeEvent(entry.event),
      state:
        entry.state === null || !view.definition.state ? null : viewCodec(view).decode(entry.state),
      envelope: decodeEnvelope(entry.envelope),
    }),
  };
};
