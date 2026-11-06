import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:access", "live"];

// Self-hosted Access applications need a domain on an active zone in the
// account; the shared standing zone is the only one tests can use.
const zoneName = "alchemy-test-2.us";

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("aud:" + env.ACCESS_AUD);
  },
};`;

// The targets belong to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AccessApplicationLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const tag = yield* Cloudflare.Access.Tag("lookup-target-tag");
    const policy = yield* Cloudflare.Access.Policy("lookup-target-policy", {
      decision: "allow",
      include: [{ emailDomain: { domain: "example.com" } }],
    });
    const app = yield* Cloudflare.Access.Application("lookup-target-app", {
      type: "self_hosted",
      domain: `${testName("alchemy-lookup-app")}.${zoneName}`,
      policies: [policy.policyId],
    });
    return {
      tag: tag.name.as<string>(),
      policyId: policy.policyId.as<string>(),
      policyName: policy.name.as<string>(),
      applicationId: app.applicationId.as<string>(),
      aud: app.aud.as<string>(),
      domain: app.domain.as<string>(),
      appName: app.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "looked-up policies and tags gate a new application, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { tag, policyId, policyName } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Access.Policy.lookup({ name: policyName });
        const byId = Cloudflare.Access.Policy.lookup({ policyId });
        const app = yield* Cloudflare.Access.Application("policy-lookup-app", {
          type: "self_hosted",
          domain: `${testName("alchemy-lookup-consumer")}.${zoneName}`,
          policies: [byName.policyId],
          tags: [Cloudflare.Access.Tag.lookup({ name: tag }).name],
        });
        return { applicationId: app.applicationId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(policyName);

      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: out.applicationId,
      });
      const live2 = live as { policies?: ReadonlyArray<{ id?: string }>; tags?: string[] };
      expect(live2.policies?.map((p) => p.id)).toEqual([policyId]);
      expect(live2.tags).toEqual([tag]);

      // A lookup re-resolves to the same policy and tag, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["policy-lookup-app"].action).toBe("noop");

      // Destroying the stack that looked them up leaves both alone.
      yield* stack.destroy();
      const policy = yield* zeroTrust.getAccessPolicy({ accountId, policyId });
      expect(policy.name).toBe(policyName);
      const survivingTag = yield* zeroTrust.getAccessTag({ accountId, tagName: tag });
      expect(survivingTag.name).toBe(tag);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a looked-up application hands its aud to a Worker, by id, domain and name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { applicationId, aud, domain, appName } = yield* target;

      const program = Effect.gen(function* () {
        const byDomain = Cloudflare.Access.Application.lookup({ domain });
        const byId = Cloudflare.Access.Application.lookup({ applicationId });
        const byName = Cloudflare.Access.Application.lookup({ name: appName });
        const caller = yield* Cloudflare.Worker("application-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { ACCESS_AUD: byDomain.aud },
        });
        return {
          url: caller.url.as<string>(),
          byId: byId.aud,
          byName: byName.applicationId,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.byId).toBe(aud);
      expect(out.byName).toBe(applicationId);

      yield* expectUrlContains(out.url, `aud:${aud}`, { label: "application lookup caller" });

      const plan = yield* stack.plan(program);
      expect(plan.resources["application-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const survivor = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: applicationId,
      });
      expect((survivor as { aud?: string }).aud).toBe(aud);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing application, policy or tag fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const missingId = "00000000-0000-4000-8000-000000000000";
      const lookups = {
        "missing-app-by-name": Cloudflare.Access.Application.lookup({ name }).aud,
        "missing-app-by-id": Cloudflare.Access.Application.lookup({ applicationId: missingId }).aud,
        "missing-policy-by-name": Cloudflare.Access.Policy.lookup({ name }).policyId,
        "missing-policy-by-id": Cloudflare.Access.Policy.lookup({ policyId: missingId }).policyId,
        "missing-tag": Cloudflare.Access.Tag.lookup({ name }).name,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { ACCESS_AUD: value } })),
          ["LookupNotFoundError"],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a policy or tag this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = Effect.gen(function* () {
        const tag = yield* Cloudflare.Access.Tag("lookup-managed-tag");
        const policy = yield* Cloudflare.Access.Policy("lookup-managed-policy", {
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
        return { tag: tag.name, policyId: policy.policyId };
      });
      const { tag, policyId } = yield* stack.deploy(managed);
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed;
            yield* Cloudflare.Worker("access-lookup-managed-caller", {
              script: callerScript,
              env: { ACCESS_AUD: Cloudflare.Access.Policy.lookup({ policyId }).policyId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed-policy"],
      );
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed;
            yield* Cloudflare.Worker("access-lookup-managed-caller", {
              script: callerScript,
              env: { ACCESS_AUD: Cloudflare.Access.Tag.lookup({ name: tag }).name },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed-tag"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
