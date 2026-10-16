/**
 * The gateways an isolate has yielded, by id. Kept apart from Gateway.ts
 * (which reaches into the Cloudflare and AWS module graphs) so the runtime
 * bridges can look a client up without bundling either.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { GatewayClient } from "./Gateway.ts";
import type { EgressRef } from "./Kind.ts";

const clients = new Map<string, GatewayClient>();

/** @internal Called by `yield* Gateway`. */
export const registerGatewayClient = (client: GatewayClient) => {
  clients.set(client.id, client);
};

/** The client for gateway `id`, if this isolate yielded it. */
export const gatewayClient = (id: string): GatewayClient | undefined => clients.get(id);

/** What {@link mintFor} answers: plain values, so it crosses a Durable Object RPC as is. */
export type MintReply =
  | { readonly grant: string; readonly expires: number }
  | { readonly refused: string }
  | { readonly error: string };

/**
 * Mint a grant for `refs` at gateway `id` through its {@link GatewayClient}
 * (a service binding RPC or a Lambda invoke, whichever hosts it). Used by
 * the container relay, which asks the Durable Object that granted the
 * egress to mint for it.
 */
export const mintFor = (
  id: string,
  refs: ReadonlyArray<EgressRef>,
  ttlMillis: number,
): Effect.Effect<MintReply, never, RuntimeContext> => {
  const client = clients.get(id);
  if (!client) {
    return Effect.succeed({ error: `gateway ${id} was not yielded by this Durable Object` });
  }
  return client.mint(refs, Duration.millis(ttlMillis)).pipe(
    Effect.map(({ grant, expires }): MintReply => ({ grant, expires })),
    Effect.catchTags({
      EgressNotServed: (error) => Effect.succeed<MintReply>({ refused: error.message }),
      EgressGatewayError: (error) => Effect.succeed<MintReply>({ error: error.message }),
    }),
  );
};
