import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:access", "live"];

// The group and token belong to another stack, as a lookup's target always
// should.
const TargetStack = Alchemy.Stack(
  "AccessLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const group = yield* Cloudflare.Access.Group("lookup-group", {
      include: [{ emailDomain: { domain: "example.com" } }],
    });
    const token = yield* Cloudflare.Access.ServiceToken("lookup-token", {});
    return {
      groupId: group.groupId.as<string>(),
      groupName: group.name.as<string>(),
      serviceTokenId: token.serviceTokenId.as<string>(),
      tokenName: token.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "policies reference a looked-up group and service token, which survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { groupId, groupName, serviceTokenId, tokenName } = yield* target;

      const program = Effect.gen(function* () {
        const group = Cloudflare.Access.Group.lookup({ name: groupName });
        const token = Cloudflare.Access.ServiceToken.lookup({ name: tokenName });
        const byId = Cloudflare.Access.ServiceToken.lookup({ serviceTokenId });
        const members = yield* Cloudflare.Access.Policy("lookup-members", {
          decision: "allow",
          include: [{ group: { id: Cloudflare.Access.Group.lookup({ groupId }).groupId } }],
        });
        const machines = yield* Cloudflare.Access.Policy("lookup-machines", {
          decision: "non_identity",
          include: [{ serviceToken: { tokenId: token.serviceTokenId } }],
        });
        return {
          membersId: members.policyId,
          machinesId: machines.policyId,
          groupId: group.groupId,
          clientId: byId.clientId,
          clientSecret: byId.clientSecret,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.groupId).toBe(groupId);
      expect(out.clientId.length).toBeGreaterThan(0);
      expect(out.clientSecret).toBeUndefined();

      // Each policy names the looked-up object.
      const members = yield* zeroTrust.getAccessPolicy({ accountId, policyId: out.membersId });
      expect(JSON.stringify(members.include)).toContain(groupId);
      const machines = yield* zeroTrust.getAccessPolicy({ accountId, policyId: out.machinesId });
      expect(JSON.stringify(machines.include)).toContain(serviceTokenId);

      // Lookups re-resolve to the same objects, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["lookup-members"].action).toBe("noop");
      expect(plan.resources["lookup-machines"].action).toBe("noop");

      // Destroy removes the policies and leaves the group and token alone.
      yield* stack.destroy();
      const group = yield* zeroTrust.getAccessGroupForAccount({ accountId, groupId });
      expect(group.name).toBe(groupName);
      const token = yield* zeroTrust.getAccessServiceTokenForAccount({
        accountId,
        serviceTokenId,
      });
      expect(token.name).toBe(tokenName);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "lookups of a missing group or service token fail the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Access.Policy("lookup-missing-group", {
            decision: "allow",
            include: [{ group: { id: Cloudflare.Access.Group.lookup({ name }).groupId } }],
          }),
        ),
        ["LookupNotFoundError", "Cloudflare.Access.Group", name],
      );
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Access.Policy("lookup-missing-token", {
            decision: "non_identity",
            include: [
              {
                serviceToken: {
                  tokenId: Cloudflare.Access.ServiceToken.lookup({ name }).serviceTokenId,
                },
              },
            ],
          }),
        ),
        ["LookupNotFoundError", "Cloudflare.Access.ServiceToken", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a group this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Access.Group("lookup-managed", {
          include: [{ emailDomain: { domain: "example.com" } }],
        });
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Access.Policy("lookup-managed-policy", {
              decision: "allow",
              include: [{ group: { id: Cloudflare.Access.Group.lookup({ name }).groupId } }],
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
