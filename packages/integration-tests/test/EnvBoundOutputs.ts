import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Outputs a host's init binds with `yield*`, which goes through the runtime
 * context's `set` (deploy) and `get` (runtime). Each is named so its env key
 * is fixed (uppercase, so Prisma's uppercased keys match).
 */
export const boundKeys = {
  plain: "ENV_BOUND_PLAIN",
  secretDigits: "ENV_BOUND_SECRET_DIGITS",
  secretText: "ENV_BOUND_SECRET_TEXT",
} as const;

/** What `/bound` must echo for each bound Output. */
export const expectedBound = {
  // A plain string Output lands in the platform env verbatim, no quotes.
  plain: { redacted: false, value: "my-queue", raw: "my-queue" },
  // A Redacted Output comes back from `yield*` as a Redacted, even when its
  // value looks like JSON.
  secretDigits: { redacted: true, value: "123456" },
  secretText: { redacted: true, value: "abc" },
};

/**
 * Bind three Outputs derived from `source` in a host's init and return the
 * request-time effect that echoes what each reads back. `source` only gives
 * the Outputs a real upstream resource; its value is ignored.
 */
export const bindEnvOutputs = (source: Output.Output<unknown>) =>
  Effect.gen(function* () {
    const plain = yield* Output.named(
      source.pipe(Output.map(() => "my-queue")),
      boundKeys.plain,
    ) as Output.Output<string>;
    const secretDigits = yield* Output.named(
      source.pipe(Output.map(() => Redacted.make("123456"))),
      boundKeys.secretDigits,
    ) as Output.Output<Redacted.Redacted<string>>;
    const secretText = yield* Output.named(
      source.pipe(Output.map(() => Redacted.make("abc"))),
      boundKeys.secretText,
    ) as Output.Output<Redacted.Redacted<string>>;

    const describe = (value: unknown) =>
      Redacted.isRedacted(value)
        ? { redacted: true, value: Redacted.value(value) as unknown }
        : { redacted: false, value };

    return Effect.gen(function* () {
      const raw = yield* Effect.sync(
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
        () => process.env[boundKeys.plain] ?? null,
      );
      return {
        plain: { ...describe(yield* plain), raw },
        secretDigits: describe(yield* secretDigits),
        secretText: describe(yield* secretText),
      };
    }) as Effect.Effect<
      Record<keyof typeof boundKeys, { redacted: boolean; value: unknown; raw?: string | null }>,
      never,
      RuntimeContext
    >;
  });
