import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, instanceProps, observeInstance, observeUser, slow } from "./mongodb.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("mongodbflex", "user"),
  timeout: 2_700_000,
} as const;

const DATABASE = "app";

const NewInstance = () => Stackit.MongoDBFlex.Instance("UserInstance", instanceProps());

/** The instance, plus the user when `user` is given. */
const app = (user?: Omit<Stackit.MongoDBFlex.UserProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* NewInstance();
    if (user === undefined) return { instance, user: undefined };
    return {
      instance,
      user: yield* Stackit.MongoDBFlex.User("UserUnderTest", {
        instanceId: instance.instanceId,
        ...user,
      }),
    };
  });

const passwordOf = (user: { readonly password: Redacted.Redacted<string> | undefined }) =>
  Redacted.value(user.password!);

test.provider.skipIf(slow)(
  "create, update, rotate, replace and delete a user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({ database: DATABASE, roles: ["read"] }));
      const instanceId = created.instance.instanceId;
      const user = created.user!;

      expect(user.userId).toEqual(expect.any(String));
      expect(user.instanceId).toEqual(instanceId);
      expect(user.userName).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
      expect(user.database).toEqual(DATABASE);
      expect(user.roles).toEqual(["read"]);
      expect(user.host).toEqual(expect.any(String));
      expect(user.port).toBeGreaterThan(0);

      // The credentials the API returns stay Redacted.
      expect(Redacted.isRedacted(user.password)).toEqual(true);
      expect(Redacted.isRedacted(user.uri)).toEqual(true);
      expect(passwordOf(user).length).toBeGreaterThan(0);
      expect(Redacted.value(user.uri!)).toContain(user.userName);

      // Out of band: the user exists with the desired role and database.
      const { item: fetched } = yield* mongodb.getUser({
        projectId,
        region,
        instanceId,
        userId: user.userId,
      });
      expect(fetched?.username).toEqual(user.userName);
      expect(fetched?.database).toEqual(DATABASE);
      expect(fetched?.roles).toEqual(["read"]);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.MongoDBFlex.User);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.userId === user.userId)?.userName).toEqual(user.userName);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ database: DATABASE, roles: ["read"] }));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      // Update the role in place. The password survives.
      const updated = yield* stack.deploy(app({ database: DATABASE, roles: ["readWrite"] }));
      expect(updated.user!.userId).toEqual(user.userId);
      expect(passwordOf(updated.user!)).toEqual(passwordOf(user));
      const { item: refetched } = yield* mongodb.getUser({
        projectId,
        region,
        instanceId,
        userId: user.userId,
      });
      expect(refetched?.roles).toEqual(["readWrite"]);

      // A new rotation key resets the password, and redeploying it does not.
      const rotated = yield* stack.deploy(
        app({ database: DATABASE, roles: ["readWrite"], rotationKey: "one" }),
      );
      expect(rotated.user!.userId).toEqual(user.userId);
      expect(rotated.user!.rotationKey).toEqual("one");
      expect(passwordOf(rotated.user!)).not.toEqual(passwordOf(user));

      const again = yield* stack.deploy(
        app({ database: DATABASE, roles: ["read"], rotationKey: "one" }),
      );
      expect(passwordOf(again.user!)).toEqual(passwordOf(rotated.user!));

      // Moving it to another database replaces it: the old user goes, a new one has its
      // own password.
      const replaced = yield* stack.deploy(
        app({ database: "other", roles: ["read"], rotationKey: "one" }),
      );
      expect(replaced.user!.userId).not.toEqual(user.userId);
      expect(replaced.user!.database).toEqual("other");
      yield* expectGone(observeUser(projectId, region, instanceId, user.userId));

      // Removing it from the stack deletes the user and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeUser(projectId, region, instanceId, replaced.user!.userId));
      const instance = yield* observeInstance(projectId, region, instanceId);
      expect(instance === "gone" ? "gone" : instance.status).toEqual("READY");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a generated-name user whose password a crash lost gets a new one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({ database: DATABASE, roles: ["read"] }));
      const user = created.user!;

      // What a crash after `createUser` leaves: a row still creating, with its instance
      // id, and no copy of the password anywhere.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "UserUnderTest" };
        const row = yield* state.get(key);
        if (row?.status !== "created") {
          return yield* Effect.fail(new Error("Expected a created row"));
        }
        const { attr: _attr, ...rest } = row;
        yield* state.set({
          ...key,
          value: { ...rest, status: "creating" } satisfies CreatingResourceState,
        });
      }).pipe(Effect.provide(stack.state));

      const recovered = yield* stack.deploy(app({ database: DATABASE, roles: ["read"] }));
      expect(recovered.user!.userId).toEqual(user.userId);
      expect(Redacted.isRedacted(recovered.user!.uri)).toEqual(true);
      expect(passwordOf(recovered.user!)).not.toEqual(passwordOf(user));

      // Settled: the next plan has nothing left to do.
      const plan = yield* stack.plan(app({ database: DATABASE, roles: ["read"] }));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, created.instance.instanceId));
    }).pipe(logLevel),
  options,
);
