import { Credentials } from "@distilled.cloud/discord/Credentials";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

export interface DeployerTokenAttributes {
  /** The bot token the stack deploys with. */
  botToken: Redacted.Redacted<string>;
  /** Discord API base URL. */
  apiBaseUrl: string;
}

/**
 * The deploying application's bot token, recorded so bindings can hand it to
 * their host. Discord can't mint a second or narrower token for a bot (a bot
 * has exactly one token, reset only in the Developer Portal), so a host gets
 * the token the stack deploys with. Resetting the token and redeploying
 * updates every host.
 */
export type DeployerToken = Resource<
  "Discord.DeployerToken",
  {},
  DeployerTokenAttributes,
  never,
  Providers
>;

export const DeployerToken = Resource<DeployerToken>("Discord.DeployerToken");

const current = Effect.gen(function* () {
  const { token, apiBaseUrl } = yield* yield* Credentials;
  return { botToken: token, apiBaseUrl } satisfies DeployerTokenAttributes;
});

export const DeployerTokenProvider = () =>
  Provider.effect(
    DeployerToken,
    Effect.gen(function* () {
      return {
        // Nothing lives in Discord: the token belongs to the deployer.
        nuke: { skip: true },
        diff: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const next = yield* current;
          if (
            Redacted.value(next.botToken) !== Redacted.value(output.botToken) ||
            next.apiBaseUrl !== output.apiBaseUrl
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
        list: () => Effect.succeed([]),
      };
    }),
  );
