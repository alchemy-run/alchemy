import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as git from "@distilled.cloud/stackit/git";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./git.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("git", "instance"), timeout: 1_800_000 } as const;

test.provider.skipIf(slow)(
  "create, update, replace and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        name: "alchemy-git-basic",
        acl: ["203.0.113.0/24"],
        labels: { env: "test", keep: "yes" },
        forceDestroy: true,
      };
      const created = yield* stack.deploy(Stackit.Git.Instance("BasicInstance", props));

      expect(created.name).toEqual("alchemy-git-basic");
      expect(created.projectId).toEqual(projectId);
      expect(created.flavor).toEqual("git-10");
      expect(created.state).toEqual("Ready");
      expect(created.url).toMatch(/^https:\/\//);
      expect(created.labels).toEqual({ env: "test", keep: "yes" });

      // Out of band: the settings, and the ownership labels the create call can't take.
      const fetched = yield* git.getInstance({ projectId, instanceId: created.instanceId });
      expect(fetched.state).toEqual("Ready");
      expect(fetched.acl).toEqual(["203.0.113.0/24"]);
      expect(fetched.labels).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "BasicInstance",
      });

      // The generation is on it too, so a later replacement can't claim this one back.
      expect(fetched.labels?.["alchemy.instance"]).toBeDefined();

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Git.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Every mutable aspect updates in place.
      const updated = yield* stack.deploy(
        Stackit.Git.Instance("BasicInstance", {
          name: "alchemy-git-basic",
          acl: ["203.0.113.0/24", "198.51.100.0/24"],
          adminLogin: true,
          featureToggle: { enableLocalLogin: true, defaultEmailNotifications: "onmention" },
          labels: { env: "stage" },
          forceDestroy: true,
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      const changed = yield* git.getInstance({ projectId, instanceId: created.instanceId });
      expect([...changed.acl].sort()).toEqual(["198.51.100.0/24", "203.0.113.0/24"]);
      expect(changed.admin_login).toEqual(true);
      expect(changed.feature_toggle.enable_local_login).toEqual(true);
      expect(changed.feature_toggle.default_email_notifications).toEqual("onmention");
      expect(changed.labels).toMatchObject({ env: "stage", "alchemy.id": "BasicInstance" });
      // Whether a merge body can drop a label is unknown: the spec also documents a JSON Patch form.
      expect(changed.labels?.keep).toBeUndefined();

      // A prop that is no longer set leaves its neighbours and the live value alone.
      const partial = yield* stack.deploy(
        Stackit.Git.Instance("BasicInstance", {
          name: "alchemy-git-basic",
          adminLogin: false,
          forceDestroy: true,
        }),
      );
      expect(partial.instanceId).toEqual(created.instanceId);
      expect(partial.adminLogin).toEqual(false);
      expect(partial.acl.length).toEqual(2);
      expect(partial.featureToggle.enable_local_login).toEqual(true);

      // A new name is a new instance, and the old one is deleted.
      const replaced = yield* stack.deploy(
        Stackit.Git.Instance("BasicInstance", {
          name: "alchemy-git-renamed",
          forceDestroy: true,
        }),
      );
      expect(replaced.instanceId).not.toEqual(created.instanceId);
      expect(replaced.name).toEqual("alchemy-git-renamed");
      yield* expectGone(observeInstance(projectId, created.instanceId));

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, replaced.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a destroy with no forceDestroy stops before it deletes anything",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.Git.Instance("GuardedInstance", {}));
      // A generated name fits the API's limit.
      expect(created.name.length).toBeLessThanOrEqual(31);

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.Git.InstanceDeleteRefused",
        instanceId: created.instanceId,
      });
      const survivor = yield* git.getInstance({ projectId, instanceId: created.instanceId });
      expect(survivor.state).toEqual("Ready");

      // A change that would replace it fails at plan, and an opt-in set in the same deploy isn't
      // enough: the old instance's delete sees what it was deployed with.
      for (const props of [
        { flavor: "git-100" as const },
        { flavor: "git-100" as const, forceDestroy: true },
      ]) {
        const refusedChange = yield* stack
          .deploy(Stackit.Git.Instance("GuardedInstance", props))
          .pipe(Effect.flip);
        expect(refusedChange).toMatchObject({
          _tag: "Stackit.Git.InstanceDeleteRefused",
          instanceId: created.instanceId,
        });
      }
      const { instances } = yield* git.listInstances({ projectId });
      expect(instances.filter((instance) => instance.name === created.name).length).toEqual(1);

      // Once it opts in, the destroy goes through.
      yield* stack.deploy(Stackit.Git.Instance("GuardedInstance", { forceDestroy: true }));
      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, created.instanceId));
    }).pipe(logLevel),
  options,
);
