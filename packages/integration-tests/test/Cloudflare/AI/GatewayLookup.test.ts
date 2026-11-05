import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:ai", "live"];

// A gateway binds as the Workers AI binding; the gateway id comes from the
// lookup's attributes.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response(await env.AI.gateway(env.GATEWAY_ID).getUrl());
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AIGatewayLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const gateway = yield* Cloudflare.AI.Gateway("lookup-target");
    return { id: gateway.gatewayId.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up gateway binds by id and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { id } = yield* target;

      const program = Effect.gen(function* () {
        const gateway = Cloudflare.AI.Gateway.lookup({ id });
        const caller = yield* Cloudflare.Worker("ai-gateway-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { AI: gateway, GATEWAY_ID: gateway.gatewayId },
        });
        return { url: caller.url.as<string>(), gatewayId: gateway.gatewayId };
      });
      const out = yield* stack.deploy(program);
      expect(out.gatewayId).toBe(id);

      yield* expectUrlContains(out.url, `/${id}`, { label: "ai gateway lookup caller" });

      // A lookup re-resolves to the same gateway, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["ai-gateway-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the gateway alone.
      yield* stack.destroy();
      const survivor = yield* aiGateway.getAiGateway({ accountId, id });
      expect(survivor.id).toBe(id);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing gateway fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const id = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("ai-gateway-lookup-missing", {
            script: callerScript,
            env: { AI: Cloudflare.AI.Gateway.lookup({ id }) },
          }),
        ),
        ["LookupNotFoundError", id],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a gateway this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.AI.Gateway("lookup-managed");
      const { gatewayId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("ai-gateway-lookup-managed", {
              script: callerScript,
              env: { AI: Cloudflare.AI.Gateway.lookup({ id: gatewayId }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
