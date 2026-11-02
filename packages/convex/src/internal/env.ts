import { createHmac } from "node:crypto";

/**
 * What to send to `update_environment_variables`. Only names in `managed` are
 * ever deleted, so a variable set by hand survives.
 */
export const envChanges = (
  observed: Readonly<Record<string, string | undefined>>,
  desired: Readonly<Record<string, string>>,
  managed: ReadonlyArray<string>,
) => [
  ...Object.entries(desired)
    .filter(([name, value]) => observed[name] !== value)
    .map(([name, value]) => ({ name, value: value as string | null })),
  ...managed
    .filter((name) => !(name in desired) && name in observed)
    .map((name) => ({ name, value: null as string | null })),
];

/**
 * A digest of the variables that changes when any of them does. Keyed, because
 * it lands in state and in the push command's environment, and an unkeyed hash
 * of a short secret can be guessed.
 */
export const envHash = (env: Readonly<Record<string, string>>, key: string) =>
  createHmac("sha256", key)
    .update(JSON.stringify(Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
