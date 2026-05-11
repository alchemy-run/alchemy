import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Vultr from "alchemy/Vultr";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { CfApiFromEnv, DnsRecord, DnsRecordProvider } from "./src/DnsRecord.ts";
import { buildUserData } from "./src/userData.ts";

const dnsRecordProviders = Layer.mergeAll(DnsRecordProvider()).pipe(
  Layer.provideMerge(CfApiFromEnv),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.orDie,
);

export default Alchemy.Stack(
  "VultrDemo",
  {
    providers: Layer.mergeAll(
      Vultr.providers(),
      Cloudflare.providers(),
      dnsRecordProviders,
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const tunnelHostname = yield* Config.string("TUNNEL_HOSTNAME");
    const zoneName = yield* Config.string("CLOUDFLARE_ZONE_NAME");

    // 1) Named Cloudflare Tunnel with an ingress rule for our host.
    const tunnel = yield* Cloudflare.Tunnel("HelloTunnel", {
      ingress: [
        { hostname: tunnelHostname, service: "http://localhost:8080" },
        { service: "http_status:404" },
      ],
    });

    // 2) Proxied CNAME on the zone:
    //    vultr-demo.ktarz.com → <tunnel-id>.cfargotunnel.com
    const dns = yield* DnsRecord("HelloDns", {
      zoneName,
      name: tunnelHostname,
      type: "CNAME",
      content: Output.interpolate`${tunnel.tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: "vultr-demo stack — managed by alchemy",
    });

    // 3) Vultr shared-CPU VM. cloud-init installs Caddy (:8080) and
    //    cloudflared bound to the tunnel token.
    const tunnelTokenPlain = Output.map(tunnel.token, Redacted.value);
    const vm = yield* Vultr.Instance("HelloVm", {
      region: "ewr",
      plan: "vc2-1c-1gb",
      osId: 1743, // Ubuntu 22.04 x64 — adjust via Vultr's /v2/os listing if you want a different image
      tags: ["app:vultr-demo"],
      userData: buildUserData({
        hostname: tunnelHostname,
        tunnelToken: tunnelTokenPlain,
      }),
    });

    return {
      url: Output.interpolate`https://${tunnelHostname}`,
      tunnelId: tunnel.tunnelId,
      dnsRecordId: dns.recordId,
      instanceId: vm.instanceId,
      mainIp: vm.mainIp,
    };
  }).pipe(Effect.orDie),
);
