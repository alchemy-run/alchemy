import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { DevRelay } from "alchemy/Local/Relay/Relay";
import * as Effect from "effect/Effect";

/**
 * Alchemy's hosted dev relay: `alchemy dev --relay https://<DEV_RELAY_DOMAIN>`
 * gives every local resource a stable `https://<name>.<namespace>.<domain>`
 * URL over one WebSocket from the dev sidecar.
 *
 * ```sh
 * DEV_RELAY_ZONE=alchemy.run DEV_RELAY_DOMAIN=dev.alchemy.run \
 * DEV_RELAY_TOKEN=… alchemy deploy --config stacks/dev-relay.ts --stage prod
 * ```
 *
 * The zone needs a certificate covering two wildcard levels
 * (`*.<namespace>.<domain>`): Advanced Certificate Manager or Total TLS.
 * Put `<domain>` on the Public Suffix List so browsers treat each namespace
 * as its own site.
 */
export default Alchemy.Stack(
  "DevRelay",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const relay = yield* DevRelay;
    return { url: relay.url };
  }),
);
