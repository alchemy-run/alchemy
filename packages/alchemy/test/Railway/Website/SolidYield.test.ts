import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";
import { suitePartition } from "../suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const readService = Query.fn((id: string) => ({ deletedAt: RailwayApi.service({ id }).deletedAt }));

const waitUntilGone = (serviceId: string) =>
  readService(serviceId).pipe(
    Effect.map((service) => (service.deletedAt != null ? ("gone" as const) : ("found" as const))),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "SolidYield: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-railway-");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const site = yield* Railway.Website.SolidYield("Web", {
            project,
            environment,
            rootDir,
            memo: { include: solidYieldMemoInclude },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.project).toBeDefined();

      yield* expectSolidYieldBuild(url!, {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/todos/42`, solidYieldPageMarker, {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const serviceId = deployed.site.service!.serviceId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:website",
      "live",
    ],
    timeout: 120_000,
  },
);
