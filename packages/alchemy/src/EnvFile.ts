import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { envString } from "./RuntimeContext.ts";

/** A Docker `--env-file` holds one line per variable, so it can't carry a newline. */
export class MultilineEnvValue extends Data.TaggedError("MultilineEnvValue")<{
  readonly key: string;
  readonly message: string;
}> {}

const sorted = (env: Record<string, unknown>) =>
  Object.entries(env)
    .flatMap(([key, value]) => {
      const text = envString(value);
      return text === undefined ? [] : [[key, text] as const];
    })
    .sort(([a], [b]) => a.localeCompare(b));

/**
 * A systemd `EnvironmentFile=`, sorted so its hash is stable. Each value is
 * double-quoted: systemd keeps everything inside, newlines included, and
 * unescapes `\"`, `\\`, `\$` and `` \` ``. A quote only opens at the start of
 * a value, so single quotes can't carry a `'`.
 */
export const systemdEnvFile = (env: Record<string, unknown>): string =>
  sorted(env)
    .map(([key, text]) => `${key}="${text.replaceAll(/["\\`$]/g, "\\$&")}"`)
    .join("\n");

/**
 * A `docker run --env-file`: one literal `NAME=value` per line, sorted so its
 * hash is stable. Docker reads the rest of the line verbatim, so a value with
 * a newline can't be written and fails the deploy instead of arriving changed.
 */
export const dockerEnvFile = (
  env: Record<string, unknown>,
): Effect.Effect<string, MultilineEnvValue> => {
  const entries = sorted(env);
  const multiline = entries.find(([, text]) => text.includes("\n"));
  return multiline
    ? Effect.fail(
        new MultilineEnvValue({
          key: multiline[0],
          message: `env ${multiline[0]} contains a newline, which a Docker env file can't hold. Encode it (e.g. base64) or run the program without an image.`,
        }),
      )
    : Effect.succeed(entries.map(([key, text]) => `${key}=${text}`).join("\n"));
};
