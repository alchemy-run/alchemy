import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import type * as Command from "./Command.ts";
import type * as Event from "./Event.ts";
import type * as Feed from "./Feed.ts";
import type {
  AggregateKit,
  Delivery,
  EnvelopeJson,
  FeedEntry,
  FeedKit,
  FeedState,
  Json,
  PolicyKit,
  ReceiptJson,
  StoredEvent,
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
  readonly feeds: ReadonlyArray<Feed.Any>;
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

type KeyRoute = (
  event: any,
  source: Aggregate.Ref,
  envelope: Aggregate.Envelope,
) => ReadonlyArray<string>;

interface Subscriber {
  readonly kind: "view" | "feed" | "policy";
  readonly name: string;
  readonly route: KeyRoute;
}

const toKeys = (value: unknown): ReadonlyArray<string> => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((ref: Aggregate.Ref) => ref.id as string);
  return [(value as Aggregate.Ref).id as string];
};

/**
 * The pure semantics shared by every platform: decide, evolve, reply,
 * routing, view application and feed mapping, plus every codec.
 */
export interface Kernel {
  readonly aggregateKit: (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ) => AggregateKit;
  readonly viewKit: (view: View.Any, deliver: (d: Delivery) => Effect.Effect<void>) => ViewKit;
  readonly feedKit: (feed: Feed.Any) => FeedKit;
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
  readonly decodeFeedEntry: (feed: Feed.Any, json: Json) => unknown;
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
  const includes = (from: ReadonlyArray<unknown>, entity: unknown) => from.includes(entity);

  // --------------------------------------------------------------- routing
  const subscribers = new Map<string, Map<string, Array<Subscriber>>>();
  const subscribe = (aggregate: Aggregate.Any, tag: string, subscriber: Subscriber) => {
    if (!codecsOf(aggregate).events.has(tag)) return;
    const byTag = subscribers.get(aggregate.aggregateName) ?? new Map<string, Array<Subscriber>>();
    subscribers.set(aggregate.aggregateName, byTag);
    const list = byTag.get(tag) ?? [];
    byTag.set(tag, list);
    list.push(subscriber);
  };
  const eventRoute = (
    owner: string,
    keyAggregate: Aggregate.Any,
    keyOf: { readonly [tag: string]: ((...args: any[]) => unknown) | undefined } | undefined,
    source: Aggregate.Any,
    tag: string,
  ): KeyRoute => {
    const custom = keyOf?.[tag];
    if (custom) {
      return (event, sourceRef, envelope) => toKeys(custom({ event, source: sourceRef, envelope }));
    }
    if (keyAggregate === source) return (_event, sourceRef) => [sourceRef.id as string];
    throw new DefinitionError(
      `${owner} consumes '${tag}' from ${source.aggregateName} but is keyed by ${keyAggregate.aggregateName}: add keyOf.${tag}`,
    );
  };

  const viewByName = new Map<string, View.Any>();
  for (const view of definitions.views) {
    if (viewByName.has(view.viewName))
      throw new DefinitionError(`Duplicate view '${view.viewName}'`);
    viewByName.set(view.viewName, view);
  }
  for (const view of definitions.views) {
    const def = view.definition;
    for (const source of def.from) {
      if ((source as Aggregate.Any).kind !== "Aggregate") continue;
      const aggregate = source as Aggregate.Any;
      for (const tag of Object.keys(def.evolve)) {
        if (!codecsOf(aggregate).events.has(tag)) continue;
        subscribe(aggregate, tag, {
          kind: "view",
          name: view.viewName,
          route: eventRoute(view.viewName, def.key, def.keyOf, aggregate, tag),
        });
      }
    }
  }
  const feedByName = new Map<string, Feed.Any>();
  for (const feed of definitions.feeds) {
    if (feedByName.has(feed.feedName))
      throw new DefinitionError(`Duplicate feed '${feed.feedName}'`);
    feedByName.set(feed.feedName, feed);
    const def = feed.definition;
    const tags = def.map ? Object.keys(def.map) : (def.events ?? []).map((e) => e.tag);
    for (const aggregate of def.from) {
      for (const tag of tags) {
        if (!codecsOf(aggregate).events.has(tag)) continue;
        subscribe(aggregate, tag, {
          kind: "feed",
          name: feed.feedName,
          route: eventRoute(feed.feedName, def.key, def.keyOf, aggregate, tag),
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
    if (!includes(definitions.aggregates, from)) {
      throw new DefinitionError(
        `Policy ${policy.policyName} listens to an aggregate missing from the Domain`,
      );
    }
    for (const event of on) {
      if (!codecsOf(from).events.has(event.tag)) {
        throw new DefinitionError(
          `Policy ${policy.policyName}: ${from.aggregateName} does not emit '${event.tag}'`,
        );
      }
      subscribe(from, event.tag, {
        kind: "policy",
        name: policy.policyName,
        route: (_event, sourceRef) => [Aggregate.streamOf(sourceRef as any)],
      });
    }
  }

  // downstream view routes: source view name → [{ target, route(state) }]
  const downstream = new Map<
    string,
    Array<{
      readonly target: View.Any;
      readonly route: (state: unknown, key: string) => string | undefined;
    }>
  >();
  for (const view of definitions.views) {
    for (const source of view.definition.from) {
      if ((source as View.Any).kind !== "View") continue;
      const upstream = source as View.Any;
      if (!view.definition.evolve[upstream.viewName]) continue;
      const custom = view.definition.keyOf?.[upstream.viewName];
      const route = custom
        ? (state: unknown) => toKeys(custom(state))[0]
        : upstream.definition.key === view.definition.key
          ? (_state: unknown, key: string) => key
          : (() => {
              throw new DefinitionError(
                `${view.viewName} consumes ${upstream.viewName} with a different key: add keyOf.${upstream.viewName}`,
              );
            })();
      const list = downstream.get(upstream.viewName) ?? [];
      downstream.set(upstream.viewName, list);
      list.push({ target: view, route });
    }
  }

  const viewCodecs = new Map<string, JsonCodec>();
  const viewCodec = (view: View.Any) => {
    let codec = viewCodecs.get(view.viewName);
    if (!codec) viewCodecs.set(view.viewName, (codec = jsonCodec(view.definition.state)));
    return codec;
  };
  const feedCodecs = new Map<string, JsonCodec>();
  const feedCodec = (feed: Feed.Any) => {
    let codec = feedCodecs.get(feed.feedName);
    if (!codec && feed.definition.entry) {
      feedCodecs.set(feed.feedName, (codec = jsonCodec(feed.definition.entry)));
    }
    return codec;
  };

  // ------------------------------------------------------------------ kits
  const aggregateKit = (
    aggregate: Aggregate.Any,
    deliver: (d: Delivery) => Effect.Effect<void>,
  ): AggregateKit => {
    const def = aggregate.definition;
    const codecs = codecsOf(aggregate);
    const routes = subscribers.get(aggregate.aggregateName);
    const decodeId = Schema.decodeUnknownSync(def.id as any) as (u: unknown) => unknown;
    const commit = (
      id: string,
      state: unknown,
      version: number,
      decided: ReadonlyArray<{ readonly _tag: string }>,
      now: DateTime.Utc,
      commandId: string,
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
        for (const subscriber of routes?.get(event._tag) ?? []) {
          for (const key of subscriber.route(event, sourceRef, envelope)) {
            deliveries.push({
              target: { kind: subscriber.kind, name: subscriber.name },
              key,
              source: stream,
              seq: envelope.seq,
              body: {
                type: "event",
                tag: event._tag,
                event: stored.event,
                envelope: stored.envelope,
              },
            });
          }
        }
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

  const viewKit = (view: View.Any, deliver: (d: Delivery) => Effect.Effect<void>): ViewKit => {
    const def = view.definition;
    const codec = viewCodec(view);
    const evolve = def.evolve as Record<string, ((...args: any[]) => unknown) | undefined>;
    const targets = downstream.get(view.viewName) ?? [];
    return {
      name: view.viewName,
      deliver,
      apply: (key, snapshot, batch) => {
        const before = snapshot.state === null ? null : codec.decode(snapshot.state);
        let current: unknown = before;
        let version = snapshot.version;
        const checkpoints: Record<string, number> = { ...snapshot.checkpoints };
        let changed = false;
        for (const delivery of batch) {
          if ((checkpoints[delivery.source] ?? 0) >= delivery.seq) continue;
          checkpoints[delivery.source] = delivery.seq;
          const base = current ?? def.initial;
          const body = delivery.body;
          let next: unknown;
          if (body.type === "event") {
            const handler = evolve[body.tag];
            if (!handler) continue;
            next = handler(base, decodeEvent(body.event), decodeEnvelope(body.envelope));
          } else {
            const handler = evolve[body.view];
            const upstream = viewByName.get(body.view);
            if (!handler || !upstream) continue;
            const upstreamCodec = viewCodec(upstream);
            next = handler(base, {
              source: Aggregate.makeRef(upstream.definition.key, body.key),
              before: body.before === null ? null : upstreamCodec.decode(body.before),
              after: body.after === null ? null : upstreamCodec.decode(body.after),
            });
          }
          current = next ?? null;
          version += 1;
          changed = true;
        }
        const next: ViewSnapshot = {
          state: current === null ? null : codec.encode(current),
          version,
          checkpoints,
        };
        const out: Array<Delivery> = [];
        if (changed) {
          const source = `${view.viewName}/${key}`;
          for (const { target, route } of targets) {
            const keyBefore = before === null ? undefined : route(before, key);
            const keyAfter = current === null ? undefined : route(current, key);
            const body = (b: unknown, a: unknown) =>
              ({ type: "change", view: view.viewName, key, before: b, after: a }) as const;
            if (keyBefore !== undefined && keyBefore !== keyAfter) {
              out.push({
                target: { kind: "view", name: target.viewName },
                key: keyBefore,
                source,
                seq: version,
                body: body(snapshot.state, null),
              });
            }
            if (keyAfter !== undefined) {
              out.push({
                target: { kind: "view", name: target.viewName },
                key: keyAfter,
                source,
                seq: version,
                body: body(keyBefore === keyAfter ? snapshot.state : null, next.state),
              });
            }
          }
        }
        return { snapshot: next, changed, downstream: out };
      },
    };
  };

  const feedKit = (feed: Feed.Any): FeedKit => {
    const def = feed.definition;
    const codec = feedCodec(feed);
    const map = def.map as Record<string, ((...args: any[]) => unknown) | undefined> | undefined;
    return {
      name: feed.feedName,
      append: (key, state, batch) => {
        let seq = state.seq;
        const checkpoints: Record<string, number> = { ...state.checkpoints };
        const entries: Array<FeedEntry> = [];
        for (const delivery of batch) {
          if ((checkpoints[delivery.source] ?? 0) >= delivery.seq) continue;
          checkpoints[delivery.source] = delivery.seq;
          const body = delivery.body;
          if (body.type !== "event") continue;
          if (map) {
            const handler = map[body.tag];
            if (!handler || !codec) continue;
            const envelope = decodeEnvelope(body.envelope);
            const entry = handler(decodeEvent(body.event), {
              key: Aggregate.makeRef(def.key, key),
              at: envelope.at,
              envelope,
            });
            if (entry === undefined) continue;
            entries.push({ seq: ++seq, entry: codec.encode(entry) });
          } else {
            entries.push({ seq: ++seq, entry: { event: body.event, envelope: body.envelope } });
          }
        }
        return { state: { seq, checkpoints } satisfies FeedState, entries };
      },
    };
  };

  const policyKit = (policy: Policy.Any, handler: Policy.Handler<unknown>): PolicyKit => {
    const from = policy.definition.from;
    return {
      name: policy.policyName,
      run: (delivery) => {
        const body = delivery.body;
        if (body.type !== "event") return Effect.void;
        const envelope = decodeEnvelope(body.envelope);
        const trigger = {
          source: Aggregate.makeRef(from, envelope.id),
          event: decodeEvent(body.event),
          envelope,
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
    feedKit,
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
    decodeFeedEntry: (feed, json) => {
      const codec = feedCodec(feed);
      if (codec) return codec.decode(json);
      const raw = json as { event: Json; envelope: EnvelopeJson };
      return { event: decodeEvent(raw.event), envelope: decodeEnvelope(raw.envelope) };
    },
  };
};
