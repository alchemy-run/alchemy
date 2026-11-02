import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as logs from "@distilled.cloud/stackit/logs";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLOSED_ACL, expectGone, observeInstance, observePolicy } from "./logs.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("logs", "accesspolicy"), timeout: 900_000 } as const;

/** A subject has to exist in IAM: two service accounts, which cost nothing. */
const app = (
  subject: "first" | "second",
  props: Omit<Stackit.Logs.AccessPolicyProps, "instanceId" | "email">,
) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Logs.Instance("PolicyLogs", {
      retentionDays: 1,
      acl: [CLOSED_ACL],
    });
    const first = yield* Stackit.IAM.ServiceAccount("PolicyFirst", {});
    const second = yield* Stackit.IAM.ServiceAccount("PolicySecond", {});
    const policy = yield* Stackit.Logs.AccessPolicy("AppPolicy", {
      instanceId: instance.instanceId,
      email: subject === "first" ? first.email : second.email,
      ...props,
    });
    return { instance, first, second, policy };
  });

test.provider(
  "create, update, replace and delete a policy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        permissions: ["read"],
        description: "alchemy test policy",
        labels: { env: "test" },
      } satisfies Omit<Stackit.Logs.AccessPolicyProps, "instanceId" | "email">;
      const { instance, first, second, policy } = yield* stack.deploy(app("first", props));
      expect(policy.accessPolicyId).toEqual(expect.any(String));
      expect(policy.email).toEqual(first.email);
      expect(policy.permissions).toEqual(["read"]);
      expect(policy.labels).toEqual({ env: "test" });

      // Out of band: the policy exists, with Alchemy's ownership labels.
      const fetched = yield* logs.getAccessPolicy({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        pId: policy.accessPolicyId,
      });
      expect(fetched.email).toEqual(first.email);
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "AppPolicy" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app("first", props));
      expect(plan.resources.AppPolicy).toMatchObject({ action: "noop" });

      // Permissions, description and labels update in place.
      const { policy: updated } = yield* stack.deploy(
        app("first", {
          permissions: ["read", "write"],
          description: "alchemy test policy, updated",
          labels: { env: "prod" },
        }),
      );
      expect(updated.accessPolicyId).toEqual(policy.accessPolicyId);
      expect([...updated.permissions].sort()).toEqual(["read", "write"]);
      expect(updated.description).toEqual("alchemy test policy, updated");
      expect(updated.labels).toEqual({ env: "prod" });

      const refetched = yield* logs.getAccessPolicy({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        pId: policy.accessPolicyId,
      });
      expect([...refetched.permissions].sort()).toEqual(["read", "write"]);
      expect(refetched.labels).toMatchObject({ env: "prod", "alchemy.id": "AppPolicy" });

      // The API can't change the email: a new policy, the old one gone.
      const { policy: replaced } = yield* stack.deploy(
        app("second", { permissions: ["read", "write"] }),
      );
      expect(replaced.accessPolicyId).not.toEqual(policy.accessPolicyId);
      expect(replaced.email).toEqual(second.email);
      yield* expectGone(
        observePolicy(projectId, region, instance.instanceId, policy.accessPolicyId),
      );

      yield* stack.destroy();
      yield* expectGone(
        observePolicy(projectId, region, instance.instanceId, replaced.accessPolicyId),
      );
      yield* expectGone(observeInstance(projectId, region, instance.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a policy for the same email and no labels is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance, first } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* Stackit.Logs.Instance("PolicyLogs", {
            retentionDays: 1,
            acl: [CLOSED_ACL],
          });
          const first = yield* Stackit.IAM.ServiceAccount("PolicyFirst", {});
          return { instance, first };
        }),
      );
      const foreign = yield* logs.createAccessPolicy({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        email: first.email,
        permissions: ["read"],
      });

      const error = yield* stack
        .deploy(app("first", { permissions: ["read", "write"] }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const fetched = yield* logs.getAccessPolicy({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        pId: foreign.id,
      });
      expect(fetched.permissions).toEqual(["read"]);

      yield* logs.deleteAccessPolicy({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
        pId: foreign.id,
      });
      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, instance.instanceId));
    }).pipe(logLevel),
  options,
);
