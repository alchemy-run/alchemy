import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as ACME from "../../ACME/index.ts";
import * as Cloudflare from "../../Cloudflare/index.ts";
import * as Fly from "../../Fly/index.ts";
import DevRelayService, {
  RelayApp,
  RelayCertificateAccount,
  RelayZone,
} from "./RelayService.ts";

/**
 * Deploys an Alchemy dev relay on Fly: the {@link DevRelayService}, its
 * App, public IPs and session directory, the apex certificate, and the DNS
 * records (`<domain>` and `*.<domain>`, DNS-only) in the Cloudflare zone —
 * so `alchemy dev --relay https://<domain>` gives every local resource a
 * stable `https://<name>.<namespace>.<domain>` URL over one WebSocket from
 * the dev sidecar. Per-namespace wildcard certificates are issued by the
 * running service itself.
 *
 * Configured through `Config` (env vars / `.env`):
 *
 * - `DEV_RELAY_ZONE` — Cloudflare zone name (`example.com`)
 * - `DEV_RELAY_DOMAIN` — relay domain inside it (`dev.example.com`)
 * - `DEV_RELAY_SCHEME` — `https` (default) or `http`
 * - `DEV_RELAY_TOKEN` — optional shared bearer token
 * - `ZERO_SSL_KEY` — ZeroSSL REST key (certificates)
 *
 * ### Deploying a relay
 * **Example:** In a stack
 * ```typescript
 * const relay = yield* DevRelay;
 * return { url: relay.url }; // alchemy dev --relay <url>
 * ```
 *
 * Put `<domain>` on the Public Suffix List so browsers treat each
 * namespace as its own site (cookies never cross namespaces).
 */
export const DevRelay = Effect.gen(function* () {
  const domain = yield* Config.string("DEV_RELAY_DOMAIN").pipe(
    Config.map((value) => value.toLowerCase()),
  );
  const scheme = yield* Config.string("DEV_RELAY_SCHEME").pipe(
    Config.withDefault("https"),
  );
  const zone = yield* RelayZone;
  const app = yield* RelayApp;
  const v4 = yield* Fly.IpAssignment("DevRelayV4", {
    app,
    type: "shared_v4",
  });
  const v6 = yield* Fly.IpAssignment("DevRelayV6", {
    app,
    type: "v6",
  });
  const account = yield* RelayCertificateAccount;

  // The connect endpoint and the index page live on the apex, whose
  // certificate is issued at deploy time and uploaded to the App.
  if (scheme === "https") {
    const apex = yield* ACME.Certificate("DevRelayApexCert", {
      account,
      identifiers: [domain],
      solver: Cloudflare.DNS.acmeSolver(zone),
    });
    yield* Fly.Certificate("DevRelayApex", {
      app,
      hostname: domain,
      kind: "custom",
      fullchain: apex.chain,
      privateKey: apex.privateKey,
    });
  }

  // DNS-only records: TLS terminates at Fly, not Cloudflare. The wildcard
  // matches every depth (`api.sam.<domain>`) because no closer name exists.
  const records = [
    ["DevRelayApexA", domain, "A", v4.ip],
    ["DevRelayApexAAAA", domain, "AAAA", v6.ip],
    ["DevRelayWildcardA", `*.${domain}`, "A", v4.ip],
    ["DevRelayWildcardAAAA", `*.${domain}`, "AAAA", v6.ip],
  ] as const;
  for (const [id, name, type, content] of records) {
    yield* Cloudflare.DNS.Record(id, {
      zoneId: zone.zoneId,
      name,
      type,
      content,
      ttl: 60,
      proxied: false,
    });
  }

  const service = yield* DevRelayService;
  return {
    app,
    service,
    /** Base URL to pass to `alchemy dev --relay`. */
    url: `${scheme}://${domain}`,
  };
});
