import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "./Output.ts";

/**
 * The shapes a {@link secret} can be derived from.
 *
 * - `string` — wrapped in `Redacted.make` and bound as a literal.
 * - `Redacted<string>` — bound as-is.
 * - `Effect<string | Redacted<string>>` — resolved at deploy time.
 * - `Config<string | Redacted<string>>` — resolved against the active
 *   `ConfigProvider` at deploy time.
 */
export type SecretInput<R = never> =
  | string
  | Redacted.Redacted<string>
  | Effect.Effect<string | Redacted.Redacted<string>, any, R>
  | Config.Config<string | Redacted.Redacted<string>>;

/**
 * Bind a secret value into the active {@link RuntimeContext} (e.g. a
 * Cloudflare Worker's `env`) under the given `name` so the resource
 * provider deploys it as a secret (e.g. `secret_text` for Cloudflare).
 *
 * The result is an `Output<Redacted<string>>` — `yield*`-ing it returns
 * an `Accessor<Redacted<string>>` that resolves the value at runtime.
 *
 * @example One-arg shortcut — reads `Config.redacted("API_KEY")`
 * ```ts
 * const apiKey = yield* Alchemy.Secret("API_KEY");
 * ```
 *
 * @example From a literal
 * ```ts
 * const apiKey = yield* Alchemy.Secret("API_KEY", "sk-123");
 * ```
 *
 * @example From an Effect
 * ```ts
 * const apiKey = yield* Alchemy.Secret(
 *   "API_KEY",
 *   Effect.succeed(Redacted.make("sk-123")),
 * );
 * ```
 *
 * @example From a Config
 * ```ts
 * const apiKey = yield* Alchemy.Secret("API_KEY", Config.redacted("API_KEY"));
 * ```
 */
export function Secret(
  name: string,
): Output.Output<Redacted.Redacted<string>, never>;
export function Secret<R = never>(
  name: string,
  value: SecretInput<R>,
): Output.Output<Redacted.Redacted<string>, R>;
export function Secret<R = never>(
  name: string,
  value?: SecretInput<R>,
): Output.Output<Redacted.Redacted<string>, R> {
  const source = value ?? Config.redacted(name);
  const base = toOutput<string | Redacted.Redacted<string>, R>(source);
  return Output.named(
    base.pipe(
      Output.map((v) => (Redacted.isRedacted(v) ? v : Redacted.make(v))),
    ) as Output.Output<Redacted.Redacted<string>, R>,
    name,
  );
}

/** @internal */
export const toOutput = <T, R = never>(
  source: T | Effect.Effect<T, any, R> | Config.Config<T> | Output.Output<T, R>,
): Output.Output<T, R> => {
  if (Output.isOutput(source)) {
    return source;
  }
  if (Config.isConfig(source)) {
    return Output.asOutput(source.asEffect() as any) as Output.Output<T, R>;
  }
  if (Effect.isEffect(source)) {
    return Output.asOutput(source as any) as Output.Output<T, R>;
  }
  return Output.asOutput(source as T) as Output.Output<T, R>;
};
