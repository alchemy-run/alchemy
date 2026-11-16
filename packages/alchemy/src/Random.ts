import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { PropsInput } from "./Input.ts";
import * as Output from "./Output.ts";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";
import { isEffectOf } from "./Util/effect.ts";

export interface RandomProps {
  /**
   * Number of random bytes to generate before hex encoding.
   * @default 32
   */
  bytes?: number;
  /**
   * Use an existing secret on the first deployment rather than generating one.
   * Once stored, the original value takes precedence even if this input changes
   * or is removed. A required `Config.Redacted("EXISTING_KEY")` is evaluated
   * only when initially creating the resource; after that the variable may
   * be removed. Use `Config.option` to allow generation when it was never set.
   * Effect-valued and resource Output inputs are also supported. The bootstrap
   * input is not stored as a second copy in resource props; only the generated
   * or imported secret is persisted in the state backend. Protect that state.
   *
   * @example
   * initial: Config.Redacted("EXISTING_KEY")
   */
  initial?: Redacted.Redacted<string> | Option.Option<Redacted.Redacted<string>>;
}

export type Random = Resource<
  "Alchemy.Random",
  RandomProps,
  {
    text: Redacted.Redacted<string>;
  }
>;

/**
 * Return a persisted random secret directly as `Redacted<string>`.
 *
 * The same `initial` input as {@link Random} may import an existing secret
 * on first creation; the saved value remains authoritative afterward.
 *
 * @example
 * const password = yield* makeRandom("DatabasePassword", {
 *   bytes: 16,
 *   initial: Config.option(Config.Redacted("EXISTING_DATABASE_PASSWORD")),
 * });
 */
export const makeRandom = (id: string, props?: PropsInput<RandomProps>) =>
  Random(id, props).pipe(Effect.map((rand) => rand.text));

/**
 * Generate a random secret or adopt an existing secret on first creation.
 *
 * The value is persisted in Alchemy state and remains unchanged on later
 * deployments, even if `initial` or `bytes` changes. If `initial` is a
 * required config that is missing on the first deployment, creation fails
 * rather than generating a new key. A missing optional config instead
 * generates a new secret.
 *
 * ### Adopt an existing secret
 *
 * ```typescript
 * const secret = yield* Random("EncryptionKey", {
 *   initial: Config.Redacted("EXISTING_ENCRYPTION_KEY"),
 * });
 * // The environment variable is not required after the first deployment.
 * ```
 *
 * ### Generate when no existing secret is configured
 *
 * ```typescript
 * const secret = yield* Random("SigningKey", {
 *   bytes: 32,
 *   initial: Config.option(Config.Redacted("EXISTING_SIGNING_KEY")),
 * });
 * // secret.text: Redacted<string>
 * ```
 *
 * `Redacted` protects ordinary output formatting; the state backend must
 * still protect persisted secrets.
 *
 * @resource
 */
export const Random = Resource<Random>("Alchemy.Random", {
  // One-shot inputs must not be retained alongside the secret in state.
  // Preserve Output dependencies by boxing their resolved value with map;
  // other inputs are opaque Option leaves and resolve only on first create.
  normalizeProps: (props) => {
    if (props === null || typeof props !== "object" || !("initial" in props)) return props;
    const initial = props.initial;
    if (initial === undefined) return props;
    return {
      ...props,
      initial: Output.isOutput(initial) ? Output.map(initial, Option.some) : Option.some(initial),
    };
  },
});

const isValidSecret = (value: unknown): value is Redacted.Redacted<string> =>
  Redacted.isRedacted(value) && typeof Redacted.value(value) === "string";

const missingSavedSecret = () => ({
  _tag: "InvalidRandomState" as const,
  message:
    "Persisted Alchemy.Random secret is missing or invalid. Restore its original state; refusing to rotate or accept a corrupted key.",
});

export const RandomProvider = () =>
  Provider.succeed(Random, {
    // A generated or imported secret is immutable for this resource instance.
    // Changing initial/bytes after creation must not produce a phantom update.
    diff: ({ output, previousStatus }) =>
      output === undefined
        ? previousStatus === "created" ||
          previousStatus === "updated" ||
          previousStatus === "replaced"
          ? Effect.fail(missingSavedSecret())
          : Effect.succeed(undefined)
        : isValidSecret(output?.text)
          ? Effect.succeed({ action: "noop" as const })
          : Effect.fail(missingSavedSecret()),
    reconcile: ({ news = {}, output }) =>
      Effect.gen(function* () {
        // Observe — there is no remote state. The cached `output.text` is
        // the authoritative current value; once minted it is preserved
        // across reconciles to keep the secret stable.
        if (output !== undefined) {
          if (!isValidSecret(output.text)) return yield* Effect.fail(missingSavedSecret());
          return output;
        }
        // A failed first create can leave a "creating" checkpoint with old
        // props but no output. The planner re-drives create in that case.
        // Detect corrupt completed rows in diff; don't block this recovery.

        // Ensure — no observed value: import the caller's existing secret
        // when provided, or mint a fresh one. Neither a changed seed nor an
        // absent optional config can rotate a persisted output.
        const deferred = Option.isOption(news.initial)
          ? Option.getOrUndefined(news.initial)
          : news.initial;
        const initial: unknown = isEffectOf(deferred) ? yield* deferred : deferred;
        const value = Option.isOption(initial) ? Option.getOrUndefined(initial) : initial;
        if (value !== undefined) {
          if (!isValidSecret(value)) {
            return yield* Effect.fail({
              _tag: "InvalidRandomInitial",
              message: "Random.initial must resolve to a Redacted<string>",
            });
          }
          return { text: value };
        }

        const byteLength = news.bytes ?? 32;
        const bytes = new Uint8Array(byteLength);
        crypto.getRandomValues(bytes);
        return {
          text: Redacted.make(
            Array.from(bytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          ),
        };
      }),
    delete: () => Effect.void,
    read: ({ output }) =>
      output === undefined || isValidSecret(output.text)
        ? Effect.succeed(output)
        : Effect.fail(missingSavedSecret()),
    // Non-listable: the value is generated client-side with
    // `crypto.getRandomValues` and lives only in alchemy state. There is no
    // remote service to enumerate, so listing yields nothing.
    list: () => Effect.succeed([]),
  });
