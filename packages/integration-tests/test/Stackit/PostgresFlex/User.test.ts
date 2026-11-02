import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, instanceProps, observeInstance, observeUser, slow } from "./postgres.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("postgresflex", "user"),
  timeout: 2_700_000,
} as const;

const NewInstance = () => Stackit.PostgresFlex.Instance("UserInstance", instanceProps());

/** The instance, plus the user when `user` is given. */
const app = (user?: Omit<Stackit.PostgresFlex.UserProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* NewInstance();
    if (user === undefined) return { instance, user: undefined };
    return {
      instance,
      user: yield* Stackit.PostgresFlex.User("UserUnderTest", {
        instanceId: instance.instanceId,
        ...user,
      }),
    };
  });

const passwordOf = (user: { readonly password: Redacted.Redacted<string> | undefined }) =>
  Redacted.value(user.password!);

test.provider.skipIf(slow)(
  "create, update, rotate and delete a user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({ roles: ["login"] }));
      const instanceId = created.instance.instanceId;
      const user = created.user!;

      expect(user.userId).toEqual(expect.any(Number));
      expect(user.instanceId).toEqual(instanceId);
      expect(user.userName).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(user.state).toEqual("PROCESSED");
      expect(user.roles).toEqual(["login"]);
      expect(user.host).toEqual(created.instance.host);
      expect(user.port).toEqual(created.instance.port);

      // The credentials the API returns stay Redacted.
      expect(Redacted.isRedacted(user.password)).toEqual(true);
      expect(Redacted.isRedacted(user.uri)).toEqual(true);
      expect(passwordOf(user).length).toBeGreaterThan(0);
      expect(new URL(Redacted.value(user.uri!)).hostname).toEqual(created.instance.host);

      // Out of band: the user exists with the desired roles.
      const fetched = yield* postgres.getUser({
        projectId,
        region,
        instanceId,
        userId: user.userId,
      });
      expect(fetched.name).toEqual(user.userName);
      expect(fetched.roles).toEqual(["login"]);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.PostgresFlex.User);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.userId === user.userId)?.userName).toEqual(user.userName);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ roles: ["login"] }));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      // Update roles and name in place. The password survives.
      const updated = yield* stack.deploy(
        app({ name: "alchemy_user_renamed", roles: ["login", "createdb"] }),
      );
      expect(updated.user!.userId).toEqual(user.userId);
      expect(updated.user!.userName).toEqual("alchemy_user_renamed");
      expect(passwordOf(updated.user!)).toEqual(passwordOf(user));
      const refetched = yield* postgres.getUser({
        projectId,
        region,
        instanceId,
        userId: user.userId,
      });
      expect(refetched.name).toEqual("alchemy_user_renamed");
      expect([...refetched.roles].sort()).toEqual(["createdb", "login"]);

      // A new rotation key resets the password, and redeploying it does not.
      const rotated = yield* stack.deploy(
        app({ name: "alchemy_user_renamed", roles: ["login", "createdb"], rotationKey: "one" }),
      );
      expect(rotated.user!.userId).toEqual(user.userId);
      expect(rotated.user!.rotationKey).toEqual("one");
      expect(passwordOf(rotated.user!)).not.toEqual(passwordOf(user));

      const again = yield* stack.deploy(
        app({ name: "alchemy_user_renamed", roles: ["login"], rotationKey: "one" }),
      );
      expect(passwordOf(again.user!)).toEqual(passwordOf(rotated.user!));

      // Removing it from the stack deletes the user and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeUser(projectId, region, instanceId, user.userId));
      const instance = yield* observeInstance(projectId, region, instanceId);
      expect(instance === "gone" ? "gone" : instance.state).toEqual("READY");

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

      const created = yield* stack.deploy(app({ roles: ["login"] }));
      const user = created.user!;

      // What a crash after `createUser` leaves: a row still creating, with its
      // instance id, and no copy of the password anywhere.
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

      const recovered = yield* stack.deploy(app({ roles: ["login"] }));
      expect(recovered.user!.userId).toEqual(user.userId);
      expect(recovered.user!.uri).toBeDefined();
      expect(passwordOf(recovered.user!)).not.toEqual(passwordOf(user));

      // Settled: the next plan has nothing left to do.
      const plan = yield* stack.plan(app({ roles: ["login"] }));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, created.instance.instanceId));
    }).pipe(logLevel),
  options,
);
