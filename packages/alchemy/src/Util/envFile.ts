import { envString } from "../RuntimeContext.ts";

/** The variable {@link containerEnvFile} lists the env keys in. */
const ENV_KEYS = "ALCHEMY_ENV_KEYS";

const sorted = (env: Record<string, unknown>) =>
  Object.entries(env)
    .flatMap(([key, value]) => {
      const text = envString(value);
      return text === undefined ? [] : [[key, text] as const];
    })
    .sort(([a], [b]) => a.localeCompare(b));

const line = (key: string, text: string) => `${key}="${text.replaceAll(/["\\`$]/g, "\\$&")}"`;

/**
 * A systemd `EnvironmentFile=`, sorted so its hash is stable. Each value is
 * double-quoted: systemd keeps everything inside, newlines included, and
 * unescapes `\"`, `\\`, `\$` and `` \` ``. A quote only opens at the start of
 * a value, so single quotes can't carry a `'`.
 */
export const systemdEnvFile = (env: Record<string, unknown>): string =>
  sorted(env)
    .map(([key, text]) => line(key, text))
    .join("\n");

/**
 * {@link systemdEnvFile} for a unit that runs a container: it also lists the
 * keys, so {@link dockerEnvArgs} can pass each one through with `-e NAME`.
 * Docker's own `--env-file` can't hold a newline; a value systemd loads into
 * the `docker` CLI's environment can.
 */
export const containerEnvFile = (env: Record<string, unknown>): string => {
  const entries = sorted(env);
  return [
    ...entries.map(([key, text]) => line(key, text)),
    line(ENV_KEYS, entries.map(([key]) => key).join(" ")),
  ].join("\n");
};

/**
 * Shell for a systemd `ExecStart=/bin/sh -c '…'` that exports the
 * {@link containerEnvFile} at `path` and puts `-e NAME` for each of its keys
 * into `"$@"`, to pass to `docker run`. The file's double-quoted values use
 * `sh`'s own escapes, so sourcing it reads them back unchanged. `$$` keeps
 * systemd from expanding the variables itself.
 */
export const dockerEnvArgs = (path: string) =>
  `set -a; . ${path}; set +a; for k in $$${ENV_KEYS}; do set -- "$$@" -e "$$k"; done;`;
