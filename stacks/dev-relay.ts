import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { CloudflareEnvironment } from "alchemy/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "alchemy/Cloudflare/Zone/lookup";
import { DevRelay } from "alchemy/Local/Relay/Relay";
import * as Config from "effect/Config";
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
    const zoneName = yield* Config.string("DEV_RELAY_ZONE");
    const domain = yield* Config.string("DEV_RELAY_DOMAIN");
    const token = yield* Config.redacted("DEV_RELAY_TOKEN");
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name: zoneName }).pipe(
      Effect.orDie,
    );
    if (!zone) {
      return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
    }
    const relay = yield* DevRelay("Relay", {
      zoneId: zone.id,
      domain,
      token,
    });
    return { url: relay.url };
  }),
);
