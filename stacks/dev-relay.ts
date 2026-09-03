import * as Alchemy from "alchemy";
import * as ACME from "alchemy/ACME";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Fly from "alchemy/Fly";
import { DevRelay } from "alchemy/Local/Relay/Relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Alchemy's hosted dev relay: `alchemy dev --relay https://<DEV_RELAY_DOMAIN>`
 * gives every local resource a stable `https://<name>.<namespace>.<domain>`
 * URL over one WebSocket from the dev sidecar.
 *
 * ```sh
 * DEV_RELAY_ZONE=alchemy.run DEV_RELAY_DOMAIN=dev.alchemy.run \
 * DEV_RELAY_TOKEN=… ZERO_SSL_KEY=… alchemy deploy --config stacks/dev-relay.ts --stage prod
 * ```
 *
 * Runs on Fly (TLS ends at Fly's proxy, one wildcard certificate per
 * namespace issued by the service itself). Put `<domain>` on the Public
 * Suffix List so browsers treat each namespace as its own site.
 */
export default Alchemy.Stack(
  "DevRelay",
  {
    providers: Layer.mergeAll(
      Fly.providers(),
      Cloudflare.providers(),
      ACME.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const relay = yield* DevRelay;
    return { url: relay.url };
  }),
);
