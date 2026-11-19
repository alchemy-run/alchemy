import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Hetzner from "@alchemy.run/hetzner";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as servers from "@distilled.cloud/hetzner/servers";
import * as volumes from "@distilled.cloud/hetzner/volumes";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { doWork, OtelCollector, waitForWorkSpan, withCollectorUrl } from "../Utils/Telemetry.ts";
import Api from "./fixtures/api.ts";
import { Data, MARKER } from "./fixtures/shared.ts";
import TracedApi from "./fixtures/traced.ts";
import Worker from "./fixtures/worker.ts";
import { hetznerPrimaryIps } from "./limit.ts";

const { test } = Test.make({
  limit: hetznerPrimaryIps,
  providers: Layer.mergeAll(Hetzner.providers(), Cloudflare.providers()),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (id: number) =>
  servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "two services on one server share a mounted volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const volume = yield* Data;
          const worker = yield* Worker;
          const api = yield* Api;
          return { volume, worker, api };
        }),
      );

      expect(deployed.api.serverId).toEqual(deployed.worker.serverId);
      expect(deployed.api.ipv4).toEqual(expect.any(String));
      expect(deployed.api.url).toContain(deployed.api.ipv4);
      expect(deployed.api.port).toEqual(3000);
      expect(deployed.api.unitName).toEqual(expect.any(String));
      expect(deployed.api.code.hash).toEqual(expect.any(String));
      expect(deployed.worker.unitName).not.toEqual(deployed.api.unitName);

      const fetched = yield* servers.getServer({
        id: deployed.api.serverId,
      });
      expect(fetched.server?.id).toEqual(deployed.api.serverId);
      expect(fetched.server?.public_net.ipv4?.ip).toEqual(deployed.api.ipv4);

      const liveVolume = yield* volumes.getVolume({
        id: deployed.volume.id,
      });
      expect(liveVolume.volume.server).toEqual(deployed.api.serverId);
      expect(liveVolume.volume.linux_device).toMatch(/^\/dev\//);

      const body = yield* HttpClient.get(deployed.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? res.json : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
        Effect.map((value) => value as { text: string; path: string }),
      );
      expect(body.path).toEqual("/data");
      expect(body.text).toEqual(MARKER);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.api.serverId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:hetzner",
      "provider:hetzner:mountvolume",
      "provider:hetzner:server",
      "provider:hetzner:service",
      "provider:hetzner:volume",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "a Service program exports spans to the bound OTLP destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The traced program binds the collector url at deploy, so it deploys first.
      const collector = yield* stack.deploy(OtelCollector());
      const api = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            return yield* TracedApi;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      expect(yield* doWork(api.url!, "hetzner")).toBe("did work hetzner");
      const traces = yield* waitForWorkSpan(collector.url!, "hetzner");
      expect(traces).toContain("work:hetzner");
      expect(traces).toContain("hetzner-service-e2e");

      yield* stack.destroy();
      expect(yield* waitUntilGone(api.serverId)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:hetzner",
      "provider:hetzner:server",
      "provider:hetzner:service",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 300_000,
  },
);
