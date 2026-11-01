import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as management from "@distilled.cloud/convex/management";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const pro = !!process.env.CONVEX_TEST_PRO;
const options = { timeout: 180_000 };

const app = (name: string, domain: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    const custom = yield* Convex.CustomDomain("Domain", {
      deployment,
      domain,
      requestDestination: "convexCloud",
    });
    return { deployment, custom };
  });

test.provider.skipIf(pro)(
  "needs the Professional plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("domain-plan");
      const refused = yield* stack
        .deploy(app(name, "probe.alchemy-convex.invalid"))
        .pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect((refused.failure as { _tag: string })._tag).toBe("VanityDomainsDisabled");
      }
      yield* stack.destroy();
    }),
  options,
);

test.provider.skipIf(!pro)(
  "creates, replaces on a new domain, and deletes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("domain-sync");
      const first = yield* stack.deploy(app(name, "one.alchemy-convex.invalid"));
      const list = () =>
        management.listCustomDomains({ deploymentName: first.deployment.deploymentName });
      expect((yield* list()).domains.map((item) => item.domain)).toEqual([
        "one.alchemy-convex.invalid",
      ]);

      yield* stack.deploy(app(name, "two.alchemy-convex.invalid"));
      expect((yield* list()).domains.map((item) => item.domain)).toEqual([
        "two.alchemy-convex.invalid",
      ]);

      yield* stack.destroy();
    }),
  options,
);
