/**
 * Where a runner reads every secret bound into its environment besides the
 * database URL and the gateway token, for hosts that keep secrets in a
 * secret store: one JSON object of env names to values, loaded into
 * `process.env` before the runner starts.
 *
 * @internal
 */
import * as Effect from "effect/Effect";

export const SECRET_ENV = "CLUSTER_SECRET_ENV";

/** Load {@link SECRET_ENV} into `process.env`, and drop it. */
export const loadSecretEnv = Effect.sync(() => {
  const blob = process.env[SECRET_ENV];
  if (blob === undefined) return;
  delete process.env[SECRET_ENV];
  for (const [key, value] of Object.entries(JSON.parse(blob) as Record<string, string>)) {
    process.env[key] = value;
  }
});
