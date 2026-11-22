import * as Hetzner from "@alchemy.run/hetzner";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as firewalls from "@distilled.cloud/hetzner/firewalls";
import * as loadBalancers from "@distilled.cloud/hetzner/load_balancers";
import * as servers from "@distilled.cloud/hetzner/servers";
import * as volumes from "@distilled.cloud/hetzner/volumes";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as Alchemy from "alchemy";
import { Stack as StackService } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import Api from "./fixtures/app/api.ts";
import {
  API_PORT,
  AppRecord,
  Box,
  Data as Volume,
  DnsZone,
  Edge,
  MARKER,
  VOLUME_PATH,
  Wall,
} from "./fixtures/app/shared.ts";
import Worker from "./fixtures/app/worker.ts";
import { hetznerLoadBalancers, hetznerPrimaryIps } from "./limit.ts";

const { test, deploy, destroy } = Test.make({
  limit: hetznerPrimaryIps,
  providers: Hetzner.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Out-of-band verification resolves Hetzner credentials the same way the
// stack does, through the Alchemy profile via `Hetzner.providers()`, not
// from `HCLOUD_TOKEN`, which a laptop running off a profile does not have.
const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Hetzner.providers().pipe(
        Layer.provideMerge(
          Layer.succeed(StackService, {
            name: "HetznerAppFixtureVerify",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
        ),
        Layer.provideMerge(Layer.succeed(Stage, "test")),
      ),
    ),
  );

class ApiNotReady extends Data.TaggedError("ApiNotReady")<{ status: number }> {}

const Stack = Alchemy.Stack(
  "HetznerAppFixture",
  { providers: Hetzner.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const server = yield* Box;
    const volume = yield* Volume;
    const firewall = yield* Wall;
    const lb = yield* Edge;
    const zone = yield* DnsZone;
    const records = yield* AppRecord;
    const worker = yield* Worker;
    const api = yield* Api;
    return {
      serverId: server.serverId,
      serverIpv4: server.ipv4,
      volumeId: volume.id,
      firewallId: firewall.id,
      lbId: lb.id,
      lbIpv4: lb.ipv4,
      zoneId: zone.zoneId,
      zoneName: zone.name,
      recordName: records.name,
      recordType: records.type,
      apiUrl: api.url,
      apiPort: api.port,
      apiUnit: api.unitName,
      workerUnit: worker.unitName,
    };
  }),
);

// The deploy runs inside the test, not in `beforeAll`: the stack's Server and
// Load Balancer hold primary IPs for as long as it is up, so it must stay up
// only while the test holds its `hetznerPrimaryIps` permit.
test(
  "deploys an effectful app and serves the mounted volume over HTTP",
  Effect.gen(function* () {
    const out = yield* deploy(Stack);

    expect(out.serverId).toEqual(expect.any(Number));
    expect(out.serverIpv4).toEqual(expect.any(String));
    expect(out.volumeId).toEqual(expect.any(Number));
    expect(out.firewallId).toEqual(expect.any(Number));
    expect(out.lbId).toEqual(expect.any(Number));
    expect(out.lbIpv4).toEqual(expect.any(String));
    expect(out.zoneId).toEqual(expect.any(Number));
    expect(out.recordName).toEqual("app");
    expect(out.recordType).toEqual("A");
    expect(out.apiPort).toEqual(API_PORT);
    expect(out.apiUnit).not.toEqual(out.workerUnit);
    expect(out.apiUrl).toContain(out.serverIpv4);

    const liveServer = yield* distilled(servers.getServer({ id: out.serverId }));
    expect(liveServer.server?.id).toEqual(out.serverId);
    expect(liveServer.server?.public_net.ipv4?.ip).toEqual(out.serverIpv4);

    const liveVolume = yield* distilled(volumes.getVolume({ id: out.volumeId }));
    expect(liveVolume.volume.server).toEqual(out.serverId);
    expect(liveVolume.volume.linux_device).toMatch(/^\/dev\//);

    const liveFirewall = yield* distilled(firewalls.getFirewall({ id: out.firewallId }));
    expect(liveFirewall.firewall.applied_to).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "server",
          server: expect.objectContaining({ id: out.serverId }),
        }),
      ]),
    );
    expect(liveFirewall.firewall.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: "in", protocol: "tcp", port: "22" }),
        expect.objectContaining({ direction: "in", protocol: "tcp", port: String(API_PORT) }),
      ]),
    );

    const liveLb = yield* distilled(loadBalancers.getLoadBalancer({ id: out.lbId }));
    expect(liveLb.load_balancer.public_net.ipv4.ip).toEqual(out.lbIpv4);
    expect(liveLb.load_balancer.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "server",
          server: expect.objectContaining({ id: out.serverId }),
        }),
      ]),
    );

    const liveRecord = yield* distilled(
      zoneRrsets.getZoneRrset({
        id_or_name: String(out.zoneId),
        rr_name: out.recordName,
        rr_type: out.recordType,
      }),
    );
    expect(liveRecord.rrset.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: out.lbIpv4 })]),
    );

    const client = yield* HttpClient.HttpClient;
    const url = out.apiUrl ?? `http://${out.serverIpv4}:${out.apiPort}`;

    const body = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json.pipe(Effect.mapError(() => new ApiNotReady({ status: res.status })))
          : Effect.fail(new ApiNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e._tag === "ApiNotReady",
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
      Effect.map((value) => value as { text: string; path: string }),
    );
    expect(body.path).toEqual(VOLUME_PATH);
    expect(body.text).toEqual(MARKER);
  }).pipe(
    Effect.ensuring(process.env.NO_DESTROY ? Effect.void : destroy(Stack).pipe(Effect.orDie)),
    logLevel,
  ),
  {
    tags: [
      "provider:hetzner",
      "provider:hetzner:firewall",
      "provider:hetzner:loadbalancer",
      "provider:hetzner:mountvolume",
      "provider:hetzner:recordset",
      "provider:hetzner:server",
      "provider:hetzner:service",
      "provider:hetzner:volume",
      "provider:hetzner:zone",
      "live",
    ],
    timeout: 300_000,
    exclusive: hetznerLoadBalancers,
  },
);
