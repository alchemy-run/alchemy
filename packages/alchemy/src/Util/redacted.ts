import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";

/**
 * Wrap a plain string, passing an already-redacted value through unchanged.
 */
export const toRedacted = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
    ? (value as Redacted.Redacted<string>)
    : Redacted.make(value);

/**
 * Lift a secret value through whichever lazy {@link Input} wrapper it arrived
 * in, so the inner string is wrapped *after* the engine resolves it.
 *
 * Wrapping the input itself (`Redacted.make(input)`) produces an opaque
 * `Redacted<Config | Effect | Output>` that the plan cannot resolve, and
 * casting the input to `Redacted<string>` is worse still: it typechecks, the
 * engine resolves the value to a plain string, and the provider's
 * `Redacted.value` call then runs against a non-redacted value.
 */
export const liftRedacted = (
  value: Input<string | Redacted.Redacted<string>>,
): Input<Redacted.Redacted<string>> =>
  Config.isConfig(value)
    ? Config.map(value, toRedacted)
    : Effect.isEffect(value)
      ? Effect.map(value, toRedacted)
      : Output.isOutput(value)
        ? Output.map(
            value as Output.Output<string | Redacted.Redacted<string>>,
            toRedacted,
          )
        : toRedacted(value as string | Redacted.Redacted<string>);
