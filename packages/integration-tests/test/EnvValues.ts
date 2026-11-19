import * as Redacted from "effect/Redacted";

/**
 * `env` values a host must deploy so the process reads back the string in
 * {@link expectedEnv}: a string as-is, a `Redacted` unwrapped, anything else
 * as JSON. Each host's env test deploys these and echoes `process.env`.
 */
export const envValues = {
  ENV_PLAIN: "hello",
  ENV_JSONISH: "12345678901.12345678901234",
  ENV_EMPTY: "",
  ENV_APOSTROPHE: "it's",
  ENV_SPECIAL: 'a"b\\c$d`e',
  ENV_MULTILINE: "line1\nline2",
  ENV_NUMBER: 3000,
  ENV_BOOL: true,
  ENV_OBJECT: { region: "eu", debug: true },
  ENV_ARRAY: ["a", "b"],
  ENV_SECRET: Redacted.make("s3cret"),
  ENV_SECRET_NUMBER: Redacted.make("123456"),
  ENV_SECRET_OBJECT: Redacted.make({ k: 1 }),
};

export type EnvValueKey = keyof typeof envValues;

/** What `process.env[key]` must hold for each of {@link envValues}. */
export const expectedEnv: Record<EnvValueKey, string> = {
  ENV_PLAIN: "hello",
  ENV_JSONISH: "12345678901.12345678901234",
  ENV_EMPTY: "",
  ENV_APOSTROPHE: "it's",
  ENV_SPECIAL: 'a"b\\c$d`e',
  ENV_MULTILINE: "line1\nline2",
  ENV_NUMBER: "3000",
  ENV_BOOL: "true",
  ENV_OBJECT: '{"region":"eu","debug":true}',
  ENV_ARRAY: '["a","b"]',
  ENV_SECRET: "s3cret",
  ENV_SECRET_NUMBER: "123456",
  ENV_SECRET_OBJECT: '{"k":1}',
};

export const envValueKeys = Object.keys(envValues) as EnvValueKey[];

/**
 * The raw value of every {@link envValues} key, `null` when unset. Call it
 * inside the deployed process (wrapped in `Effect.sync`).
 */
export const readEnvValues = (env: Record<string, string | undefined>) =>
  Object.fromEntries(envValueKeys.map((key) => [key, env[key] ?? null])) as Record<
    EnvValueKey,
    string | null
  >;

/**
 * {@link envValues} without `keys`, for a host whose platform can't carry
 * them (a Docker env file can't hold a newline), and the matching
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
