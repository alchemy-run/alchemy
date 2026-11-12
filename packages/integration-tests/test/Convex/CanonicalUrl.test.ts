import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deployments from "@distilled.cloud/convex/deployment";
import * as management from "@distilled.cloud/convex/management";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { onDeployment, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });

const app = (name: string, url?: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    if (url !== undefined) {
      yield* Convex.CanonicalUrl("Site", { deployment, requestDestination: "convexSite", url });
    }
    return { deployment };
  });

test.provider(
  "sets, changes and restores the canonical URL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("canonical");
      const { deployment } = yield* stack.deploy(app(name));
      const read = onDeployment(deployment.url, deployments.getCanonicalUrls({}));
      const original = (yield* read).convexSiteUrl;

      yield* stack.deploy(app(name, "https://one.alchemy-convex.invalid"));
      expect((yield* read).convexSiteUrl).toBe("https://one.alchemy-convex.invalid");

      yield* stack.deploy(app(name, "https://two.alchemy-convex.invalid"));
      expect((yield* read).convexSiteUrl).toBe("https://two.alchemy-convex.invalid");

      yield* stack.deploy(app(name));
      expect((yield* read).convexSiteUrl).toBe(original);

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider(
  "delete tolerates a deployment that is already gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("canonical-gone");
      const { deployment } = yield* stack.deploy(app(name, "https://one.alchemy-convex.invalid"));
      yield* management.deleteDeployment({ deploymentName: deployment.deploymentName });

      const destroyed = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isSuccess(destroyed)).toBe(true);
    }),
  { timeout: 180_000 },
);

test.provider(
  "an override never changes the deployment's own URLs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("canonical-own");
      const overridden = (paused: boolean) =>
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          const deployment = yield* Convex.Deployment("Deployment", {
            project,
            type: "preview",
            paused,
          });
          yield* Convex.CanonicalUrl("Site", {
            deployment,
            requestDestination: "convexSite",
            url: "https://own.alchemy-convex.invalid",
          });
          return { deployment };
        });
      const first = yield* stack.deploy(overridden(false));

      // Pausing reconciles the deployment while the override is in place.
      const second = yield* stack.deploy(overridden(true));
      expect(second.deployment.paused).toBe(true);
      expect(second.deployment.url).toBe(first.deployment.url);
      expect(second.deployment.siteUrl).toBe(first.deployment.siteUrl);
      expect(second.deployment.siteUrl).toContain(".convex.site");
      const live = yield* onDeployment(second.deployment.url, deployments.getCanonicalUrls({}));
      expect(live.convexSiteUrl).toBe("https://own.alchemy-convex.invalid");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
