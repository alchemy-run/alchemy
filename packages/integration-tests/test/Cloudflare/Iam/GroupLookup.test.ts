import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/cloudflare/iam";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:iam", "live"];

// A built-in permission group, found by its stable catalog name.
const PERMISSION_GROUP_NAME = "Page Rules Read";

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("group:" + env.GROUP);
  },
};`;

// The targets belong to another stack, as a lookup's target always should.
// The user group is declared without props, which must work: every prop is
// optional.
const TargetStack = Alchemy.Stack(
  "IamGroupLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const resourceGroup = yield* Cloudflare.Iam.ResourceGroup("lookup-target-rg", {
      scope: { key: `com.cloudflare.api.account.${accountId}`, objects: [{ key: "*" }] },
    });
    const userGroup = yield* Cloudflare.Iam.UserGroup("lookup-target-ug");
    return {
      resourceGroupId: resourceGroup.resourceGroupId.as<string>(),
      resourceGroupName: resourceGroup.name.as<string>(),
      userGroupId: userGroup.userGroupId.as<string>(),
      userGroupName: userGroup.name.as<string>(),
    };
  }).pipe(Effect.orDie),
);

// Cloudflare lists a new group by name a moment after creating it, so wait
// for it before a test looks it up by name.
const listedByName = <A, E extends { readonly _tag: string }, R>(names: Stream.Stream<A, E, R>) =>
  names.pipe(
    Stream.runHead,
    Effect.flatMap((found) =>
      found._tag === "Some" ? Effect.void : Effect.fail({ _tag: "NotListedYet" } as const),
    ),
    Effect.retry({
      while: (e) => e._tag === "NotListedYet",
      schedule: Schedule.spaced("2 seconds"),
      times: 20,
    }),
  );

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

const findPermissionGroupId = (accountId: string) =>
  iam.listPermissionGroups.items({ accountId, name: PERMISSION_GROUP_NAME }).pipe(
    Stream.runHead,
    Effect.flatMap((pg) =>
      pg._tag === "Some"
        ? Effect.succeed(pg.value.id)
        : Effect.die(new Error(`permission group "${PERMISSION_GROUP_NAME}" not found`)),
    ),
  );

test.provider(
  "a looked-up resource group backs a new user group's policy, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { resourceGroupId, resourceGroupName } = yield* target;
      yield* listedByName(iam.listResourceGroups.items({ accountId, name: resourceGroupName }));
      const permissionGroupId = yield* findPermissionGroupId(accountId);

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Iam.ResourceGroup.lookup({ name: resourceGroupName });
        const byId = Cloudflare.Iam.ResourceGroup.lookup({ resourceGroupId });
        const group = yield* Cloudflare.Iam.UserGroup("group-lookup-consumer", {
          policies: [
            {
              access: "allow",
              permissionGroups: [permissionGroupId],
              resourceGroups: [byName.resourceGroupId],
            },
          ],
        });
        return { userGroupId: group.userGroupId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(resourceGroupName);

      const live = yield* iam.getUserGroup({ accountId, userGroupId: out.userGroupId });
      expect(live.policies?.[0]?.resourceGroups?.map((rg) => rg.id)).toEqual([resourceGroupId]);

      // A lookup re-resolves to the same resource group, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["group-lookup-consumer"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the resource group alone.
      yield* stack.destroy();
      const survivor = yield* iam.getResourceGroup({ accountId, resourceGroupId });
      expect(survivor.id).toBe(resourceGroupId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a looked-up user group resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { userGroupId, userGroupName } = yield* target;
      yield* listedByName(iam.listUserGroups.items({ accountId, name: userGroupName }));

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Iam.UserGroup.lookup({ name: userGroupName });
        const byId = Cloudflare.Iam.UserGroup.lookup({ userGroupId });
        const caller = yield* Cloudflare.Worker("user-group-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { GROUP: byName.userGroupId },
        });
        return { url: caller.url.as<string>(), byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(userGroupName);

      yield* expectUrlContains(out.url, `group:${userGroupId}`, {
        label: "user group lookup caller",
      });

      const plan = yield* stack.plan(program);
      expect(plan.resources["user-group-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const survivor = yield* iam.getUserGroup({ accountId, userGroupId });
      expect(survivor.name).toBe(userGroupName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing user group or resource group fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-user-group": Cloudflare.Iam.UserGroup.lookup({ name }).userGroupId,
        "missing-resource-group": Cloudflare.Iam.ResourceGroup.lookup({ name }).resourceGroupId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { GROUP: value } })),
          ["LookupNotFoundError", name],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a user group this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Iam.UserGroup("lookup-managed");
      const { userGroupId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("user-group-lookup-managed-caller", {
              script: callerScript,
              env: { GROUP: Cloudflare.Iam.UserGroup.lookup({ userGroupId }).userGroupId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
