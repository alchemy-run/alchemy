import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import type * as Command from "./Command.ts";
import type * as Event from "./Event.ts";
import type {
  AggregateKit,
  Delivery,
  EnvelopeJson,
  Json,
  PolicyKit,
  ReceiptJson,
  StoredEvent,
  ViewEntry,
  ViewKit,
  ViewSnapshot,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import type * as View from "./View.ts";

/**
 * The entities of a Domain.
 */
export interface Definitions {
  readonly aggregates: ReadonlyArray<Aggregate.Any>;
  readonly views: ReadonlyArray<View.Any>;
  readonly policies: ReadonlyArray<Policy.Any>;
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
export const encodeEnvelope = (envelope: Aggregate.Envelope): EnvelopeJson => ({
  id: envelope.id,
  stream: envelope.stream,
  seq: envelope.seq,
  at: DateTime.toEpochMillis(envelope.at),
  commandId: envelope.commandId,
});

/** @internal */
export const decodeEnvelope = (json: EnvelopeJson): Aggregate.Envelope => ({
  ...json,
  at: DateTime.makeUnsafe(json.at),
});

/**
 * The pure semantics shared by every platform: decide, evolve, reply,
 * routing and view application, plus every codec.
 */
export interface Kernel {
  readonly aggregateKit: (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => AggregateKit;
  readonly viewKit: (view: View.Any, deliver: (d: Delivery) => Effect.Effect<void>) => ViewKit;
  readonly policyKit: (policy: Policy.Any, handler: Policy.Handler<unknown>) => PolicyKit;
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
 * Build the kernel for a set of definitions. Validates tags and routing.
 */
export const make = (definitions: Definitions): Kernel => {
  // ---------------------------------------------------------------- events
  const eventCodecs = new Map<string, { readonly cls: Event.Any; readonly codec: JsonCodec }>();
  const registerEvent = (cls: Event.Any) => {
    const existing = eventCodecs.get(cls.tag);
    if (existing && existing.cls !== cls) {
      throw new DefinitionError(`Two different events are tagged '${cls.tag}'`);
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
      throw new DefinitionError(`Duplicate aggregate '${aggregate.aggregateName}'`);
    }
    aggregateByName.set(aggregate.aggregateName, aggregate);
    const def = aggregate.definition;
    const state = jsonCodec(def.state);
    const commands = new Map<string, { cls: Command.Any; codec: JsonCodec; reply?: JsonCodec }>();
    const rejections = new Map<string, JsonCodec>();
    for (const command of def.commands) {
      commands.set(command.tag, {
        cls: command,
        codec: jsonCodec(command),
        reply: command.reply ? jsonCodec(command.reply) : undefined,
      });
      for (const rejection of command.rejects) {
        if (!rejections.has(rejection.tag)) rejections.set(rejection.tag, jsonCodec(rejection));
      }
    }
    aggregateCodecs.set(aggregate.aggregateName, {
      state,
      initial: state.encode(def.initial),
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
    if (sources.has(name)) throw new DefinitionError(`Two entities are named '${name}'`);
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
  const sourceEntry = (owner: string, source: View.Source) => {
    const entry = sources.get(nameOf(source));
    const entity = entry?.kind === "aggregate" ? entry.aggregate : entry?.view;
    if (entity !== source) {
      throw new DefinitionError(`${owner} consumes ${nameOf(source)}, which is not in the Domain`);
    }
    return entry!;
  };
  /** The aggregate whose refs identify a source's instances. */
  const keyAggregateOf = (entry: SourceEntry) =>
    entry.kind === "aggregate" ? entry.aggregate : entry.view.definition.key;

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
      throw new DefinitionError(`${view.viewName} consumes itself through other views`);
    }
    visiting.add(view.viewName);
    const tags = new Set<string>();
    for (const source of view.definition.from) {
      const upstream = sourceEntry(view.viewName, source);
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
    readonly kind: "view" | "policy";
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

  const keyRoute = (view: View.Any, upstream: SourceEntry, source: string, tag: string): Route => {
    const def = view.definition;
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
    throw new DefinitionError(
      `${view.viewName} consumes '${tag}' from ${source}, which is not keyed by ${def.key.aggregateName}: add keyOf.${tag}`,
    );
  };

  for (const view of definitions.views) {
    const def = view.definition;
    if (def.state !== undefined && def.initial === undefined) {
      throw new DefinitionError(`${view.viewName} declares state without initial`);
    }
    // Route-keyed handlers need the same routes in keyOf.
    for (const field of ["evolve", "emit"] as const) {
      for (const [name, handler] of Object.entries(handlers(def[field]) ?? {})) {
        if (typeof handler === "function" || !handler) continue;
        const routes = handlers(def.keyOf)?.[name];
        for (const route of Object.keys(handler)) {
          if (typeof routes !== "object" || !(route in routes)) {
            throw new DefinitionError(
              `${view.viewName}.${field}.${name}.${route} has no matching route in keyOf.${name}`,
            );
          }
        }
      }
    }
    for (const source of def.from) {
      const upstream = sourceEntry(view.viewName, source);
      const name = nameOf(source);
      for (const tag of outputTags(upstream)) {
        if (!consumes(view, tag, name)) continue;
        subscribe(name, tag, {
          kind: "view",
          name: view.viewName,
          route: keyRoute(view, upstream, name, tag),
        });
      }
    }
  }

  const policyByName = new Map<string, Policy.Any>();
  for (const policy of definitions.policies) {
    if (policyByName.has(policy.policyName))
      throw new DefinitionError(`Duplicate policy '${policy.policyName}'`);
    policyByName.set(policy.policyName, policy);
    const { from, on } = policy.definition;
    const upstream = sourceEntry(`Policy ${policy.policyName}`, from);
    for (const event of on) {
      if (!outputTags(upstream).has(event.tag)) {
        throw new DefinitionError(
          `Policy ${policy.policyName}: ${nameOf(from)} does not emit '${event.tag}'`,
        );
      }
      // One policy instance per source instance, so triggers run in order.
      subscribe(nameOf(from), event.tag, {
        kind: "policy",
        name: policy.policyName,
        route: (input) => [{ key: input.stream }],
      });
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
  ): AggregateKit => {
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
        };
        next = (def.evolve as Record<string, (...args: any[]) => unknown>)[event._tag](
          next,
          event,
          envelope,
        );
        const stored: StoredEvent = {
          event: encodeEvent(event),
          envelope: encodeEnvelope(envelope),
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
        const command = codecs.commands.get((input.command as { _tag: string })._tag);
        if (!command)
          throw new DefinitionError(
            `${aggregate.aggregateName} does not handle '${(input.command as any)._tag}'`,
          );
        const decoded = command.codec.decode(input.command) as { readonly _tag: string };
        const state = codecs.state.decode(input.state ?? codecs.initial);
        const id = decodeId(input.id) as string;
        const now = DateTime.makeUnsafe(input.now);
        const decision = (def.decide as Record<string, (...args: any[]) => unknown>)[decoded._tag](
          state,
          decoded,
          {
            id,
            now,
          },
        );
        if (!Array.isArray(decision)) {
          const rejection = decision as { readonly _tag: string };
          const codec = codecs.rejections.get(rejection._tag);
          if (!codec || !command.cls.rejects.some((r) => r.tag === rejection._tag)) {
            throw new DefinitionError(
              `${aggregate.aggregateName}.decide.${decoded._tag} returned '${rejection?._tag}', which ${decoded._tag} does not declare in rejects`,
            );
          }
          return { _tag: "Rejected", rejection: codec.encode(rejection) };
        }
        const { next, events, deliveries } = commit(
          id,
          state,
          input.version,
          decision,
          now,
          input.commandId,
          false,
        );
        const replyFn = (def.reply as Record<string, (...args: any[]) => unknown> | undefined)?.[
          decoded._tag
        ];
        const reply =
          replyFn && command.reply ? command.reply.encode(replyFn(next, decision)) : null;
        return {
          _tag: "Accepted",
          state: codecs.state.encode(next),
          version: input.version + decision.length,
          events,
          reply,
          deliveries,
        };
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

  const viewKit = (view: View.Any, deliver: (d: Delivery) => Effect.Effect<void>): ViewKit => {
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
              };
              const entry: ViewEntry = {
                seq,
                event: encodeEvent(out),
                envelope: encodeEnvelope(outEnvelope),
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
    const upstream = sources.get(nameOf(policy.definition.from))!;
    return {
      name: policy.policyName,
      run: (delivery) => {
        // Seeded history is the past; policies only react to what happens now.
        if (delivery.history) return Effect.void;
        const envelope = decodeEnvelope(delivery.envelope);
        const trigger = {
          source: Aggregate.makeRef(keyAggregateOf(upstream), envelope.id),
          event: decodeEvent(delivery.event),
          envelope,
          state: sourceState(upstream, delivery.state),
        };
        let n = 0;
        const prefix = `${delivery.source}:${delivery.seq}:${policy.policyName}`;
        return handler(trigger).pipe(
          Effect.provideService(Aggregate.PolicyRun, { next: () => `${prefix}:${n++}` }),
        );
      },
    };
  };

  return {
    aggregateKit,
    viewKit,
    policyKit,
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
