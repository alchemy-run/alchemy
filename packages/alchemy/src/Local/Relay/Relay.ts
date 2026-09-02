import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { CloudflareEnvironment } from "../../Cloudflare/CloudflareEnvironment.ts";
import * as DNS from "../../Cloudflare/DNS/index.ts";
import { findZoneByName } from "../../Cloudflare/Zone/lookup.ts";
import DevRelayWorker from "./RelayWorker.ts";

/**
 * Deploys an Alchemy dev relay: the Effect-native Worker + Durable Object in
 * `RelayWorker.ts` (with its routes) plus the proxied DNS records its
 * hostnames need, on a zone you own — so `alchemy dev --relay https://<domain>`
 * gives every local resource a stable `https://<name>.<namespace>.<domain>`
 * URL over a single WebSocket from the dev sidecar.
 *
 * Configured through `Config` (env vars / `.env`):
 *
 * - `DEV_RELAY_ZONE` — zone name (`example.com`)
 * - `DEV_RELAY_DOMAIN` — relay domain (`dev.example.com`)
 * - `DEV_RELAY_SCHEME` — `https` (default) or `http`
 * - `DEV_RELAY_TOKEN` — optional shared bearer token
 *
 * ### Deploying a relay
 * **Example:** In a stack
 * ```typescript
 * const relay = yield* DevRelay;
 * return { url: relay.url }; // alchemy dev --relay <url>
 * ```
 *
 * Two-level hostnames (`api.sam.dev.example.com`) need a certificate covering
 * `*.sam.dev.example.com` — Advanced Certificate Manager (or Total TLS) on the
 * zone; Universal SSL only covers one wildcard level.
 */
export const DevRelay = Effect.gen(function* () {
  const zoneName = yield* Config.string("DEV_RELAY_ZONE");
  const domain = yield* Config.string("DEV_RELAY_DOMAIN");
  const scheme = yield* Config.string("DEV_RELAY_SCHEME").pipe(
    Config.withDefault("https"),
  );
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName }).pipe(
    Effect.orDie,
  );
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
  }
  const worker = yield* DevRelayWorker;
  // Proxied placeholder records so the Worker routes have DNS to attach to.
  const apex = yield* DNS.Record("DevRelayApex", {
    zoneId: zone.id,
    name: domain,
    type: "AAAA",
    content: "100::",
    proxied: true,
  });
  const wildcard = yield* DNS.Record("DevRelayWildcard", {
    zoneId: zone.id,
    name: `*.${domain}`,
    type: "AAAA",
    content: "100::",
    proxied: true,
  });
  return {
    worker,
    apex,
    wildcard,
    /** Base URL to pass to `alchemy dev --relay`. */
    url: `${scheme}://${domain}`,
  };
});
