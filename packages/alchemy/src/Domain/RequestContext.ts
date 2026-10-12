import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
 * Declare a service that middleware provides to a request, such as the
 * current actor. It belongs to the request, not to any one entity: a
 * command carries it to its aggregate's `decide`, and a read carries it to
 * `validate`. Both may run elsewhere (e.g. in a Durable Object), so it has a
 * schema. Policies provide it themselves when they send commands.
 *
 * **Example:** The current actor
 * ```typescript
 * export class CurrentActor extends Domain.RequestContext<CurrentActor>()("Bank/CurrentActor", Actor) {}
 * ```
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
      encode: Schema.encodeUnknownSync(codec),
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
export const restore = (json: Json): EffectContext.Context<never> => {
  let context = EffectContext.empty() as EffectContext.Context<unknown>;
  for (const [key, value] of Object.entries(json)) {
    const entry = registry.get(key);
    if (!entry) throw new Error(`Unknown request context '${key}'`);
    context = EffectContext.add(context, entry.tag, entry.decode(value));
  }
  return context as EffectContext.Context<never>;
};
