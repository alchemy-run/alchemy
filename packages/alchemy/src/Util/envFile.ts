import { envString } from "../RuntimeContext.ts";

/**
 * The variable a {@link containerEnvFile} lists `-e NAME` for each key in.
 * A unit passes it to `docker run` as `$ALCHEMY_DOCKER_ENV`: systemd splits
 * an unbraced variable into one argument per word.
 */
export const DOCKER_ENV = "ALCHEMY_DOCKER_ENV";

// The names systemd's `EnvironmentFile=` accepts; it drops any other line.
const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const sorted = (env: Record<string, unknown>) =>
  Object.entries(env)
    .flatMap(([key, value]) => {
      const text = envString(value);
      return text === undefined || !validName.test(key) ? [] : [[key, text] as const];
    })
    .sort(([a], [b]) => a.localeCompare(b));

const line = (key: string, text: string) => `${key}="${text.replaceAll(/["\\`$]/g, "\\$&")}"`;

/**
 * A systemd `EnvironmentFile=`, sorted so its hash is stable. Each value is
 * double-quoted: systemd keeps everything inside, newlines included, and
 * unescapes `\"`, `\\`, `\$` and `` \` ``. A quote only opens at the start of
 * a value, so single quotes can't carry a `'`. Keys must be shell-style
 * names (`[A-Za-z_][A-Za-z0-9_]*`); systemd can't hold any other, so they
 * are left out.
 */
export const systemdEnvFile = (env: Record<string, unknown>): string =>
  sorted(env)
    .map(([key, text]) => line(key, text))
    .join("\n");

/**
 * {@link systemdEnvFile} for a unit that runs a container. It also sets
 * {@link DOCKER_ENV} to `-e NAME` for each key, so `docker run` copies every
 * value from its own environment. Docker's `--env-file` can't hold a newline;
 * a value systemd loads can.
 */
export const containerEnvFile = (env: Record<string, unknown>): string => {
  const entries = sorted(env);
  return [
    ...entries.map(([key, text]) => line(key, text)),
    line(DOCKER_ENV, entries.map(([key]) => `-e ${key}`).join(" ")),
  ].join("\n");
};
