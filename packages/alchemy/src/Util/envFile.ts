import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { envString } from "../RuntimeContext.ts";

/**
 * The variable a {@link containerEnvFile} lists `-e NAME` for each key in.
 * A unit passes it to `docker run` as `$ALCHEMY_DOCKER_ENV`: systemd splits
 * an unbraced variable into one argument per word.
 */
export const DOCKER_ENV = "ALCHEMY_DOCKER_ENV";

/** An `env` key a systemd `EnvironmentFile=` can't hold. */
export class InvalidEnvKey extends Data.TaggedError("InvalidEnvKey")<{ readonly key: string }> {
  override get message() {
    return this.key === DOCKER_ENV
      ? `env key ${DOCKER_ENV} is reserved for the container's docker run arguments`
      : `env key ${JSON.stringify(this.key)} isn't a shell-style name ([A-Za-z_][A-Za-z0-9_]*), which systemd needs to set it`;
  }
}

// The names systemd's `EnvironmentFile=` accepts; it drops any other line.
const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const sorted = (env: Record<string, unknown>, reserved?: string) =>
  Effect.gen(function* () {
    const entries = Object.entries(env)
      .flatMap(([key, value]) => {
        const text = envString(value);
        return text === undefined ? [] : [[key, text] as const];
      })
      .sort(([a], [b]) => a.localeCompare(b));
    const invalid = entries.find(([key]) => !validName.test(key) || key === reserved);
    if (invalid) return yield* new InvalidEnvKey({ key: invalid[0] });
    return entries;
  });

const line = (key: string, text: string) => `${key}="${text.replaceAll(/["\\`$]/g, "\\$&")}"`;

/**
 * A systemd `EnvironmentFile=`, sorted so its hash is stable. Each value is
 * double-quoted: systemd keeps everything inside, newlines included, and
 * unescapes `\"`, `\\`, `\$` and `` \` ``. A quote only opens at the start of
 * a value, so single quotes can't carry a `'`. A key systemd can't hold
 * (`MY.KEY`) fails with {@link InvalidEnvKey} instead of being dropped.
 */
export const systemdEnvFile = (env: Record<string, unknown>) =>
  sorted(env).pipe(
    Effect.map((entries) => entries.map(([key, text]) => line(key, text)).join("\n")),
  );

/**
 * {@link systemdEnvFile} for a unit that runs a container. It also sets
 * {@link DOCKER_ENV} to `-e NAME` for each key, so `docker run` copies every
 * value from its own environment. Docker's `--env-file` can't hold a newline;
 * a value systemd loads can.
 */
export const containerEnvFile = (env: Record<string, unknown>) =>
  sorted(env, DOCKER_ENV).pipe(
    Effect.map((entries) =>
      [
        ...entries.map(([key, text]) => line(key, text)),
        line(DOCKER_ENV, entries.map(([key]) => `-e ${key}`).join(" ")),
      ].join("\n"),
    ),
  );
