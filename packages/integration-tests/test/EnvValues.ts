import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * `env` values a host must deploy so the process reads back the string in
 * {@link expectedEnv}: a string as-is, a `Redacted` unwrapped, anything else
 * as JSON. Each host's env test deploys these and echoes `process.env`.
 */
export const envValues = {
  ENV_PLAIN: "hello",
  ENV_JSONISH: "12345678901.12345678901234",
  ENV_EMPTY: "",
  ENV_QUOTES: "it's a\"b\\c$d`e",
  ENV_MULTILINE: "line1\nline2",
  ENV_NUMBER: 3000,
  ENV_OBJECT: { region: "eu", debug: true },
  ENV_SECRET: Redacted.make("s3cret"),
  ENV_SECRET_OBJECT: Redacted.make({ k: 1 }),
};

export type EnvValueKey = keyof typeof envValues;

/** What `process.env[key]` must hold for each of {@link envValues}. */
export const expectedEnv: Record<EnvValueKey, string> = {
  ENV_PLAIN: "hello",
  ENV_JSONISH: "12345678901.12345678901234",
  ENV_EMPTY: "",
  ENV_QUOTES: "it's a\"b\\c$d`e",
  ENV_MULTILINE: "line1\nline2",
  ENV_NUMBER: "3000",
  ENV_OBJECT: '{"region":"eu","debug":true}',
  ENV_SECRET: "s3cret",
  ENV_SECRET_OBJECT: '{"k":1}',
};

const envValueKeys = Object.keys(envValues) as EnvValueKey[];

/** The raw value of every {@link envValues} key, `null` when unset. */
export const readEnvValues = (env: Record<string, string | undefined>) =>
  Object.fromEntries(envValueKeys.map((key) => [key, env[key] ?? null])) as Record<
    EnvValueKey,
    string | null
  >;

/** {@link readEnvValues} over the deployed process's own environment. */
export const echoEnv = Effect.sync(() =>
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
  readEnvValues(process.env),
);

/**
 * {@link envValues} without `keys`, for a host whose platform can't carry
 * them (AWS Batch drops an empty value), and the matching
 * {@link expectedEnv} with those keys unset.
 */
export const envValuesWithout = (...keys: EnvValueKey[]) => ({
  values: Object.fromEntries(
    Object.entries(envValues).filter(([key]) => !keys.includes(key as EnvValueKey)),
  ),
  expected: Object.fromEntries(
    envValueKeys.map((key) => [key, keys.includes(key) ? null : expectedEnv[key]]),
  ) as Record<EnvValueKey, string | null>,
});

/**
 * What {@link bindEnvOutputs} must echo: a plain Output lands in the
 * platform env verbatim, and a Redacted one comes back from `yield*` as a
 * Redacted even when its value looks like JSON.
 */
export const expectedBound = {
  plain: { redacted: false, value: "my-queue", raw: "my-queue" },
  secret: { redacted: true, value: "123456" },
};

const BOUND_PLAIN = "ENV_BOUND_PLAIN";

/**
 * Bind two Outputs derived from `source` in a host's init (through the
 * runtime context's `set`/`get`) and return the request-time effect that
 * echoes what each reads back. `source`'s value is ignored; it only gives the
 * Outputs a real upstream resource. Keys are uppercase so Prisma's match.
 */
export const bindEnvOutputs = (source: Output.Output<unknown>) =>
  Effect.gen(function* () {
    const plain = yield* Output.named(
      source.pipe(Output.map(() => "my-queue")),
      BOUND_PLAIN,
    ) as Output.Output<string>;
    const secret = yield* Output.named(
      source.pipe(Output.map(() => Redacted.make("123456"))),
      "ENV_BOUND_SECRET",
    ) as Output.Output<Redacted.Redacted<string>>;

    const describe = (value: unknown) =>
      Redacted.isRedacted(value)
        ? { redacted: true, value: Redacted.value(value) as unknown }
        : { redacted: false, value };

    return Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
      const raw = yield* Effect.sync(() => process.env[BOUND_PLAIN] ?? null);
      return {
        plain: { ...describe(yield* plain), raw },
        secret: describe(yield* secret),
      };
    }) as Effect.Effect<
      Record<
        keyof typeof expectedBound,
        { redacted: boolean; value: unknown; raw?: string | null }
      >,
      never,
      RuntimeContext
    >;
  });

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body?: string }> {
  override get message() {
    return `status ${this.status}${this.body === undefined ? "" : `: ${this.body}`}`;
  }
}

/**
 * GET `url` as JSON, retrying (bounded) while a freshly deployed host is not
 * serving 200s yet. A host that boots a VM passes a longer `times`.
 */
export const getJson = (url: string, { times = 20 }: { times?: number } = {}) =>
  HttpClient.get(url).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new NotReady({ status: 0 })),
    }),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) => Effect.fail(new NotReady({ status: res.status, body }))),
          ),
    ),
    // A booting host refuses connections too, so every failure retries.
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times }),
  );
