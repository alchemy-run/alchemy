import type * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";

/**
 * The App-secrets version a Machine that reads `secrets` as env must
 * reach: the newest of their last writes. Fly may start a Machine on an
 * older vault without it, and a new value raises it, which rolls the
 * Machines.
 *
 * @internal
 */
export const minSecretsVersion = (secrets: readonly Fly.Secret[]) =>
  Output.all(...secrets.map((secret) => secret.version)).pipe(
    Output.map((versions) => {
      const known = versions.filter((version): version is number => version !== undefined);
      return known.length === 0 ? undefined : Math.max(...known);
    }),
  );
