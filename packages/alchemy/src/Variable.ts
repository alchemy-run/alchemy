import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Output from "./Output.ts";
import { toOutput } from "./Secret.ts";

/**
 * The shapes a {@link variable} can be derived from.
 */
export type VariableInput<T, R = never> =
  | T
  | Effect.Effect<T, any, R>
  | Config.Config<T>;

/**
 * Bind a non-secret value into the active {@link RuntimeContext} (e.g. a
 * Cloudflare Worker's `env`) under the given `name`. Counterpart to
 * {@link Secret} for plain (non-redacted) values — the resource provider
 * deploys it as `plain_text` / `json` rather than `secret_text`.
 *
 * The result is an `Output<T>` — `yield*`-ing it returns an `Accessor<T>`
 * that resolves the value at runtime.
 *
 * @example One-arg shortcut — reads `Config.string("DATABASE_URL")`
 * ```ts
 * const url = yield* Alchemy.Variable("DATABASE_URL");
 * ```
 *
 * @example From a literal
 * ```ts
 * const port = yield* Alchemy.Variable("PORT", 3000);
 * ```
 */
export function Variable(name: string): Output.Output<string, never>;
export function Variable<T, R = never>(
  name: string,
  value: VariableInput<T, R>,
): Output.Output<T, R>;
export function Variable<T = string, R = never>(
  name: string,
  value?: VariableInput<T, R>,
): Output.Output<T, R> {
  const source: any = value ?? Config.string(name);
  return Output.named(toOutput<T, R>(source), name);
}
