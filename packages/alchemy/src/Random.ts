import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { PropsInput } from "./Input.ts";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";

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
   * Like generated secrets, imported values are persisted in the state backend.
   * Protect access to that backend.
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

export const makeRandom = (id: string, props?: PropsInput<RandomProps>) =>
  Random(id, props).pipe(Effect.map((rand) => rand.text));

/**
 * A deterministic-in-state random secret generator.
 *
 * The value is generated once on create and then persisted in state so
 * subsequent deploys keep the same secret unless the resource is replaced.
 */
export const Random = Resource<Random>("Alchemy.Random", {
  // Config would be eagerly resolved by the planner even when a secret is
  // already stored. Option is an opaque leaf and defers resolution to create.
  normalizeProps: (props) =>
    props !== null &&
    typeof props === "object" &&
    "initial" in props &&
    Config.isConfig(props.initial)
      ? { ...props, initial: Option.some(props.initial) }
      : props,
});

export const RandomProvider = () =>
  Provider.succeed(Random, {
    // A generated or imported secret is immutable for this resource instance.
    // Changing initial/bytes after creation must not produce a phantom update.
    diff: ({ output }) => Effect.succeed(output?.text ? { action: "noop" as const } : undefined),
    reconcile: ({ news = {}, output }) =>
      Effect.gen(function* () {
        // Observe — there is no remote state. The cached `output.text` is
        // the authoritative current value; once minted it is preserved
        // across reconciles to keep the secret stable.
        if (output?.text) {
          return output;
        }

        // Ensure — no observed value: import the caller's existing secret
        // when provided, or mint a fresh one. Neither a changed seed nor an
        // absent optional config can rotate a persisted output.
        const deferred = Option.isOption(news.initial)
          ? Option.getOrUndefined(news.initial)
          : news.initial;
        const initial: unknown = Config.isConfig(deferred) ? yield* deferred : deferred;
        const value = Option.isOption(initial) ? Option.getOrUndefined(initial) : initial;
        if (value !== undefined) {
          if (!Redacted.isRedacted(value) || typeof Redacted.value(value) !== "string") {
            return yield* Effect.fail({
              _tag: "InvalidRandomInitial",
              message: "Random.initial must resolve to a Redacted<string>",
            });
          }
          return { text: value as Redacted.Redacted<string> };
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
    read: ({ output }) => Effect.succeed(output),
    // Non-listable: the value is generated client-side with
    // `crypto.getRandomValues` and lives only in alchemy state. There is no
    // remote service to enumerate, so listing yields nothing.
    list: () => Effect.succeed([]),
  });
