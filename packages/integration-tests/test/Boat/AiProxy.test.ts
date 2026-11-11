import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import { PERSONAL, TEST_ORG } from "./fixtures/org.ts";

const { test } = Test.make({ providers: Boat.providers({ org: PERSONAL }) });
const team = Test.make({ providers: Boat.providers({ org: TEST_ORG }) });

const tags = ["provider:boat", "provider:boat:ai-proxy", "live"];

// The proxy is billed while it is on ($1 a day, and per request), so these
// cases only ever ask for it off, which is how the testing account keeps it.
// One switch per account: cases on the same account take turns.
const observe = (org: string) => boat.getAiProxy({ org });

const environmentOf = (environmentId: string) =>
  boat
    .listEnvironments({})
    .pipe(
      Effect.map((r) => r.environments.find((environment) => environment.id === environmentId)),
    );

test.provider(
  "keep your own proxy off, and an environment that takes the proxy follows it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* observe(PERSONAL);
      expect(before.enabled).toBe(false);

      const program = Effect.gen(function* () {
        const Proxy = Boat.AiProxy("Proxy", { enabled: false });
        const Tenants = Boat.Environment("Tenants", {
          safeForThirdParties: true,
          proxyAiCredentials: Proxy,
        });
        return { proxy: yield* Proxy, environment: yield* Tenants };
      });

      const { proxy, environment } = yield* stack.deploy(program);
      expect(proxy.accountId).toBe(before.accountId);
      expect(proxy.org).toBeUndefined();
      expect(proxy.enabled).toBe(false);
      expect(proxy.initialEnabled).toBe(false);
      expect(proxy.proxyUrl).toBe(before.proxyUrl);
      expect((yield* environmentOf(environment.environmentId))?.proxyAiCredentials).toBe(false);

      const plan = yield* stack.plan(program);
      expect(plan.resources.Proxy.action).toBe("noop");
      expect(plan.resources.Tenants.action).toBe("noop");

      // Destroy puts the switch back the way it was found: still off.
      yield* stack.destroy();
      expect((yield* observe(PERSONAL)).enabled).toBe(false);
    }),
  { tags, timeout: 120_000, exclusive: "boat:ai-proxy:personal" },
);

team.test.provider(
  "with an org, the switch is the org's",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* observe(TEST_ORG);
      expect(before.enabled).toBe(false);
      const own = yield* observe(PERSONAL);
      expect(before.accountId).not.toBe(own.accountId);

      const program = Boat.AiProxy("TeamProxy", { enabled: false });

      const proxy = yield* stack.deploy(program);
      expect(proxy.accountId).toBe(before.accountId);
      expect(proxy.org).toBe(TEST_ORG);
      expect(proxy.enabled).toBe(false);
      expect(proxy.initialEnabled).toBe(false);

      const plan = yield* stack.plan(program);
      expect(plan.resources.TeamProxy.action).toBe("noop");

      yield* stack.destroy();
      expect((yield* observe(TEST_ORG)).enabled).toBe(false);
    }),
  { tags, timeout: 120_000, exclusive: "boat:ai-proxy:org" },
);
