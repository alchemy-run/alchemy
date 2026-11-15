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
   * or is removed. Supply a Redacted value, or an optional Redacted config
   * (`Config.option(Config.Redacted("EXISTING_KEY"))`) when migrating from
   * an environment variable that may be removed after the initial deployment.
   * Like generated secrets, imported values are persisted in the state backend.
   * Protect access to that backend.
   *
   * @example
   * initial: Config.option(Config.Redacted("EXISTING_KEY"))
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
export const Random = Resource<Random>("Alchemy.Random");

export const RandomProvider = () =>
  Provider.succeed(Random, {
    // A generated or imported secret is immutable for this resource instance.
    // Changing initial/bytes after creation must not produce a phantom update.
    diff: ({ output }) => Effect.succeed(output?.text ? { action: "noop" as const } : undefined),
    reconcile: ({ news = {}, output }) =>
      Effect.sync(() => {
        // Observe — there is no remote state. The cached `output.text` is
        // the authoritative current value; once minted it is preserved
        // across reconciles to keep the secret stable.
        if (output?.text) {
          return output;
        }

        // Ensure — no observed value: import the caller's existing secret
        // when provided, or mint a fresh one. Neither a changed seed nor an
        // absent optional config can rotate a persisted output.
        if (Redacted.isRedacted(news.initial)) {
          return { text: news.initial };
        }
        if (news.initial !== undefined && Option.isSome(news.initial)) {
          return { text: news.initial.value };
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
