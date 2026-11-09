import { Credentials, DEFAULT_REGION } from "@distilled.cloud/archil/Credentials";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

export interface DeployerKeyAttributes {
  /** The API key the stack deploys with. */
  apiKey: Redacted.Redacted<string>;
  /** Archil region the key acts in. */
  region: string;
}

/**
 * The deploying account's API key, recorded so bindings can hand it to
 * their host. Archil only mints API keys from a console session (an API
 * key gets a 401), and its keys can't be scoped, so a host gets the same
 * key the stack deploys with. Rotating the deploy key updates every host.
 */
export type DeployerKey = Resource<
  "Archil.DeployerKey",
  {},
  DeployerKeyAttributes,
  never,
  Providers
>;

export const DeployerKey = Resource<DeployerKey>("Archil.DeployerKey");

const current = Effect.gen(function* () {
  const { apiKey, region } = yield* yield* Credentials;
  return { apiKey, region: region ?? DEFAULT_REGION } satisfies DeployerKeyAttributes;
});

export const DeployerKeyProvider = () =>
  Provider.effect(
    DeployerKey,
    Effect.gen(function* () {
      return {
        // Nothing lives in Archil: the key belongs to the deployer.
        nuke: { skip: true },
        diff: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const next = yield* current;
          if (
            Redacted.value(next.apiKey) !== Redacted.value(output.apiKey) ||
            next.region !== output.region
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* () {
          return yield* current;
        }),
        delete: () => Effect.void,
      };
    }),
  );
