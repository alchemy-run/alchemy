import * as railway from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { canPushRailwayImage, railwayRegistry } from "../fixtures/registry.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const waitUntilGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!canPushRailwayImage)(
  "StaticSite: build command + outdir, GET index",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-staticsite-railway-",
        tempRoot,
        entries: ["src", "build.sh"],
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Railway.Website.StaticSite("Blog", {
            cwd,
            command: "bash build.sh",
            shell: true,
            outdir: "dist",
            registry: railwayRegistry!,
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.service).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "StaticSite fixture v1", {
        timeout: "90 seconds",
        label: "staticsite index",
      });

      const serviceId = deployed.site.service!.serviceId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
