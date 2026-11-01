import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as git from "@distilled.cloud/stackit/git";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow, TEST_PASSWORD } from "./git.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("git", "user"), timeout: 1_800_000 } as const;

const app = (user: Omit<Stackit.Git.UserProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Git.Instance("UserInstance", {
      featureToggle: { enableLocalLogin: true },
      forceDestroy: true,
    });
    return {
      instance,
      user: yield* Stackit.Git.User("UserUnderTest", { instanceId: instance.instanceId, ...user }),
    };
  });

const props = {
  username: "alchemy-test-user",
  email: "alchemy-test-user@example.com",
  name: "Alchemy test user",
  password: Redacted.make(TEST_PASSWORD),
};

test.provider.skipIf(slow)(
  "create, update, replace and delete a user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance, user: created } = yield* stack.deploy(app(props));
      expect(created.username).toEqual(props.username);
      expect(created.email).toEqual(props.email);
      // The password isn't in the attributes.
      expect(JSON.stringify(created)).not.toContain(TEST_PASSWORD);

      // Out of band: `getUser` reads the body the spec documents under a 302.
      const scope = { projectId, instanceId: instance.instanceId };
      const fetched = yield* git.getUser({ ...scope, username: props.username });
      expect(fetched.email).toEqual(props.email);
      expect(fetched.name).toEqual(props.name);

      // Redeploying unchanged is a no-op, even with a `Redacted` prop.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      // A new password is seen, though it can't be compared with the cloud.
      const rotate = yield* stack.plan(
        app({ ...props, password: Redacted.make(`${TEST_PASSWORD}-next`) }),
      );
      expect(rotate.resources.UserUnderTest).toMatchObject({ action: "update" });

      // E-mail and display name update in place.
      const { user: updated } = yield* stack.deploy(
        app({ ...props, email: "changed@example.com", name: "Changed" }),
      );
      expect(updated.username).toEqual(props.username);
      const changed = yield* git.getUser({ ...scope, username: props.username });
      expect(changed.email).toEqual("changed@example.com");
      expect(changed.name).toEqual("Changed");

      // A new username is a new user, and the old one is deleted.
      yield* stack.deploy(app({ ...props, username: "alchemy-test-user-2" }));
      const renamed = yield* git.getUser({ ...scope, username: "alchemy-test-user-2" });
      expect(renamed.email).toEqual(props.email);
      const old = yield* git.getUser({ ...scope, username: props.username }).pipe(Effect.flip);
      expect(old._tag).toEqual("NotFound");

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);
