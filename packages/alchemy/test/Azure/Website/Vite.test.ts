import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "../../../src/Azure/Arm.ts";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Express environment: provisions in seconds, outside the trial's
// one-standard-environment quota.
const LOCATION = "eastus";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/vite-spa-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "src"];

const groupExists = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const group = yield* orUndefinedIfNotFound(
      resources.GetResourceGroup({ subscriptionId, resourceGroupName }),
    );
    return group !== undefined;
  });

// Skipped: needs a running local Docker daemon to build the image. The live
// run on 2026-10-05 provisioned ResourceGroup/Registry/Environment, then
// `docker image build` failed with "Cannot connect to the Docker daemon at
// unix:///var/run/docker.sock" (daemon inactive on the test host); destroy
// cleaned every resource. Unskip on a host with Docker running.
test.provider.skip(
  "Vite SPA: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-azure-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Azure.Website.Vite("Web", {
            rootDir,
            location: LOCATION,
            memo: {
              include: ["index.html", "src/**", "package.json"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.app).toBeDefined();
      expect(deployed.site.registry).toBeDefined();

      yield* expectUrlContains(`${url!}/`, "Vite SPA fixture", {
        timeout: "60 seconds",
        label: "vite spa index",
      });
      yield* expectUrlContains(
        `${url!}/missing-client-route`,
        "Vite SPA fixture",
        { timeout: "15 seconds", label: "vite spa fallback" },
      );

      const client = yield* HttpClient.HttpClient;
      const health = yield* client.get(`${url!}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`health returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(health).toContain("ok");

      const groupName = deployed.site.resourceGroup!.resourceGroupName;
      yield* stack.destroy();
      expect(yield* groupExists(groupName)).toBe(false);
    }).pipe(logLevel, Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: ["provider:azure", "provider:azure:website", "live"],
    timeout: 900_000,
  },
);
