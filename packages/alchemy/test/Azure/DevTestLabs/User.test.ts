import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getUser = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetUser({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: {
  principal: "First" | "Second";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    // Both principals stay deployed across the replacement step.
    const first = yield* Azure.ManagedIdentity.UserAssignedIdentity("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.ManagedIdentity.UserAssignedIdentity("Second", {
      resourceGroup: group.resourceGroupName,
    });
    const principal = props.principal === "First" ? first : second;
    const user = yield* Azure.DevTestLabs.User("LabUser", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      objectId: principal.principalId,
      tenantId: principal.tenantId,
      tags: props.tags,
    });
    return { group, lab, principal, user };
  });

// Free lab + identities; ~5 minutes for the lab.
test.provider(
  "create, update, replace, and delete a lab user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, principal, user } = yield* stack.deploy(
        program({ principal: "First", tags: { env: "test" } }),
      );
      expect(user.userName).toEqual(principal.principalId);
      const get = (name: string) =>
        getUser(group.resourceGroupName, lab.labName, name);
      const observed = yield* get(user.userName);
      expect(observed.properties?.identity?.objectId).toEqual(
        principal.principalId,
      );
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ principal: "First", tags: { env: "prod" } }),
      );
      expect(updated.user.userId).toEqual(user.userId);
      expect((yield* get(user.userName)).tags?.env).toEqual("prod");

      // Replacement: a different principal.
      const replaced = yield* stack.deploy(
        program({ principal: "Second", tags: { env: "prod" } }),
      );
      expect(replaced.user.userName).toEqual(replaced.principal.principalId);
      expect(yield* waitGone(get(user.userName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.user.userName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
