import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DefinitionError, UnknownRequestContext } from "./DefinitionError.ts";

/** The JSON form of a request's context, by service key. */
export type Json = Readonly<Record<string, unknown>>;

interface Registered {
  readonly tag: EffectContext.Key<unknown, unknown>;
  readonly encode: (value: unknown) => unknown;
  readonly decode: (json: unknown) => unknown;
}

const registry = new Map<string, Registered>();

/**
 * The class type returned by {@link make}.
 */
export interface RequestContextClass<
  Self,
  Key extends string,
  S extends Schema.Top,
> extends EffectContext.ServiceClass<Self, Key, S["Type"]> {
  /** Encodes the value so it can travel with a request into the domain. */
  readonly schema: S;
}

/**
 * A service middleware provides to a request, such as the current actor. It
 * belongs to the request: a command carries it to its aggregate's `decide`,
 * and a read carries it to `validate`. Both may run elsewhere, such as in a
 * Durable Object, so it has a schema. Policies provide it themselves when
 * they send commands.
 *
 * ### Declaring a request context
 * **Example:** The current actor
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 *
 * export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
 *   "Bank/CurrentActor",
 *   Schema.Struct({ customerId: Schema.String }),
 * ) {}
 * ```
 *
 * ### Providing it from middleware
 * **Example:** A session middleware that provides it
 * ```typescript
 * import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
 * import * as Schema from "effect/Schema";
 * import { CurrentActor } from "./CurrentActor.ts";
 *
 * export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
 *
 * export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
 *   "Bank/Session",
 *   { error: Unauthorized },
 * ) {}
 * ```
 *
 * @primitive
 */
export const make =
  <Self>() =>
  <const Key extends string, S extends Schema.Top>(
    key: Key,
    schema: S,
  ): RequestContextClass<Self, Key, S> => {
    const Tag = EffectContext.Service<Self, S["Type"]>()(key);
    const codec = Schema.toCodecJson(
      schema as unknown as Schema.Codec<unknown, unknown>,
    ) as Schema.Codec<unknown, unknown>;
    registry.set(key, {
      tag: Tag as unknown as EffectContext.Key<unknown, unknown>,
      // oxlint-disable-next-line effecttsgo/schema-sync -- context codecs are sync by contract
      encode: Schema.encodeUnknownSync(codec),
      // oxlint-disable-next-line effecttsgo/schema-sync -- context codecs are sync by contract
      decode: Schema.decodeUnknownSync(codec),
    });
    return class extends Tag {
      static readonly schema: S = schema;
    } as unknown as RequestContextClass<Self, Key, S>;
  };

/**
 * Encode every request context service present in the current fiber.
 *
 * @internal
 */
export const capture: Effect.Effect<Json> = Effect.gen(function* () {
  const captured: Record<string, unknown> = {};
  for (const [key, entry] of registry) {
    const value = yield* Effect.serviceOption(entry.tag);
    if (Option.isSome(value)) captured[key] = entry.encode(value.value);
  }
  return captured;
});

/**
 * Decode a request's context back into services, for `decide` or `validate`.
 *
 * @internal
 */
export const restore = Effect.fn(function* (json: Json) {
  let context = EffectContext.empty() as EffectContext.Context<unknown>;
  for (const [key, value] of Object.entries(json)) {
    const entry = registry.get(key);
    if (!entry)
      return yield* Effect.die(new DefinitionError({ reason: new UnknownRequestContext({ key }) }));
    context = EffectContext.add(context, entry.tag, entry.decode(value));
  }
  return context as EffectContext.Context<never>;
});

/**
 * Where a live read's middleware records when its verdict expires (see
 * {@link setExpiry}): the earliest time any of them set.
 *
 * @internal
 */
export interface Expiry {
  at: number | undefined;
}

/**
 * The {@link Expiry} of the request being judged. Only a live read has one;
 * a command or query has none, and {@link setExpiry} does nothing there.
 *
 * @internal
 */
export const CurrentExpiry = EffectContext.Reference<Expiry | undefined>(
  "alchemy/Domain/RequestContext/CurrentExpiry",
  { defaultValue: () => undefined },
);

/**
 * Say when a middleware's verdict expires, such as when the session token it
 * checked does. A live read (`watch`, `events`) pushed over a WebSocket is
 * closed then, even if its key has no new commits; the client reconnects at
 * once from its cursor, which runs the middleware again. A caller still
 * allowed misses nothing, and one it now refuses gets its typed error. When
 * several middleware set an expiry, the earliest wins: one middleware never
 * extends another's verdict. Commands and queries are judged on every call,
 * so it changes nothing for them.
 *
 * ### Ending a live read when its session expires
 * **Example:** A session middleware whose token carries its expiry
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as Option from "effect/Option";
 *
 * export const SessionLive = Layer.succeed(
 *   Session,
 *   Effect.fn(function* (effect, { headers }) {
 *     const session = yield* verifySession(headers);
 *     if (Option.isNone(session)) return yield* new Unauthorized();
 *     yield* Domain.setExpiry(session.value.expires);
 *     return yield* Effect.provideService(effect, CurrentActor, session.value.actor);
 *   }),
 * );
 * ```
 */
export const setExpiry = Effect.fn(function* (at: Date | number) {
  const expiry = yield* CurrentExpiry;
  if (expiry === undefined) return;
  const millis = typeof at === "number" ? at : at.getTime();
  expiry.at = expiry.at === undefined ? millis : Math.min(expiry.at, millis);
});
