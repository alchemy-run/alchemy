import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";

export interface PublicKeyAttributes {
  /** Application id. */
  applicationId: string;
  /** Hex Ed25519 key Discord signs interactions and webhook events with. */
  publicKey: string;
}

/**
 * The application's public key, recorded so event sources can bind it into
 * their host before the host's URL is registered with Discord. Discord PINGs
 * an interactions or event-webhook URL when it is set, so the host must
 * already verify signatures; reading the key here keeps it independent of
 * the endpoint resource that depends on the host.
 */
export type PublicKey = Resource<"Discord.PublicKey", {}, PublicKeyAttributes, never, Providers>;

export const PublicKey = Resource<PublicKey>("Discord.PublicKey");

const current = Effect.gen(function* () {
  const app = yield* discord.getMyApplication({});
  return { applicationId: app.id, publicKey: app.verify_key } satisfies PublicKeyAttributes;
});

export const PublicKeyProvider = () =>
  Provider.succeed(PublicKey, {
    nuke: { skip: true },
    diff: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const next = yield* current;
      return next.publicKey !== output.publicKey ? ({ action: "update" } as const) : undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: () => current,
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
  });
