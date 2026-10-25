/**
 * Shared process setup for programs on an `Azure.Compute.VirtualMachine`.
 * No Effect: the async entry imports it too.
 *
 * The VM's systemd unit starts Node.js in the release directory, which holds
 * the bundle and `env.json` (the program's env, written by the deploy). The
 * env is loaded into `process.env` before the program's module is imported.
 */
import { existsSync, readFileSync } from "node:fs";

/** Copy `env.json` (or `$ALCHEMY_ENV_FILE`) into `process.env`. */
export const loadEnv = (): void => {
  const file = process.env.ALCHEMY_ENV_FILE ?? "env.json";
  if (!existsSync(file)) return;
  const env = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") process.env[key] = value;
  }
};

// Must stay in step with `packEnvValue` in `alchemy/RuntimeContext`.
export const decodeEnvValue = (raw: string | undefined): unknown => {
  if (raw === undefined || !/^[\x20\t\r\n]*["{[0-9tfn-]/.test(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { _tag?: unknown })._tag === "Redacted" &&
      typeof (parsed as { value?: unknown }).value === "string"
    ) {
      return (parsed as { value: string }).value;
    }
    return parsed;
  } catch {
    return raw;
  }
};
