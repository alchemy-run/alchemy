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

export interface EnvChange {
  readonly name: string;
  readonly value: string | null;
}

/** The variable writes around one push. */
export interface EnvSyncPlan {
  /** Written before the push: new names and changed values. */
  readonly before: ReadonlyArray<EnvChange>;
  /**
   * Written after a successful push: managed names that left `desired`. The
   * running code may still read them, and Convex refuses to remove a variable
   * that the pushed auth config reads, so they go once the new code is live.
   */
  readonly after: ReadonlyArray<EnvChange>;
  /** Undoes `before`: the earlier value, or null where there was none. */
  readonly restore: ReadonlyArray<EnvChange>;
  /**
   * Names this resource never set that already hold a different value, other
   * than a value the deployment took from its project's defaults.
   */
  readonly foreign: ReadonlyArray<string>;
}

const byName = (a: EnvChange, b: EnvChange) => a.name.localeCompare(b.name);

export const planEnvSync = (
  observed: Readonly<Record<string, string | undefined>>,
  desired: Readonly<Record<string, string>>,
  managed: ReadonlyArray<string>,
  /** The project's default values for this deployment's type. */
  inherited: Readonly<Record<string, string>> = {},
): EnvSyncPlan => {
  const changed = Object.entries(desired).filter(([name, value]) => observed[name] !== value);
  return {
    before: changed.map(([name, value]) => ({ name, value })).toSorted(byName),
    after: managed
      .filter((name) => !(name in desired) && observed[name] !== undefined)
      .map((name) => ({ name, value: null }))
      .toSorted(byName),
    restore: changed.map(([name]) => ({ name, value: observed[name] ?? null })).toSorted(byName),
    foreign: changed
      .filter(
        ([name]) =>
          !managed.includes(name) &&
          observed[name] !== undefined &&
          observed[name] !== inherited[name],
      )
      .map(([name]) => name)
      .toSorted(),
  };
};
