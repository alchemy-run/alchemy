import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGone,
  gated,
  instanceProps,
  observeInstance,
  observeUser,
  ROLES,
} from "./sqlserver.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("sqlserverflex", "user"),
  timeout: 2_700_000,
} as const;

const NewInstance = () => Stackit.SQLServerFlex.Instance("UserInstance", instanceProps());

/** The instance, plus the user when `user` is given. */
const app = (user?: Omit<Stackit.SQLServerFlex.UserProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* NewInstance();
    if (user === undefined) return { instance, user: undefined };
    return {
      instance,
      user: yield* Stackit.SQLServerFlex.User("UserUnderTest", {
        instanceId: instance.instanceId,
        ...user,
      }),
    };
  });

const passwordOf = (user: { readonly password: Redacted.Redacted<string> | undefined }) =>
  Redacted.value(user.password!);

// One test on purpose: every instance costs at least an hour's licence.
test.provider.skipIf(gated)(
  "create, recover, rotate, replace and delete a user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({ roles: ROLES }));
      const instanceId = created.instance.instanceId;
      const user = created.user!;

      expect(user.userId).toEqual(expect.any(Number));
      expect(user.instanceId).toEqual(instanceId);
      expect(user.userName).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(user.status).toEqual("PROCESSED");
      expect([...user.roles].sort()).toEqual([...ROLES].sort());
      expect(user.host.length).toBeGreaterThan(0);
      expect(user.port).toBeGreaterThan(0);

      // The credentials the API returns stay Redacted.
      expect(Redacted.isRedacted(user.password)).toEqual(true);
      expect(Redacted.isRedacted(user.uri)).toEqual(true);
      expect(passwordOf(user).length).toBeGreaterThan(0);

      // Out of band: the user exists with the desired roles, and no password.
      const fetched = yield* sqlserver.getUser({
        projectId,
        region,
        instanceId,
        userId: user.userId,
      });
      expect(fetched.username).toEqual(user.userName);
      expect([...fetched.roles].sort()).toEqual([...ROLES].sort());

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.SQLServerFlex.User);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.userId === user.userId)?.userName).toEqual(user.userName);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ roles: ROLES }));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      // What a crash after `createUser` leaves: a row still creating, with its
      // instance id, and no copy of the password anywhere. The next deploy finds the
      // user by its generated name and resets the password.
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
      const recovered = yield* stack.deploy(app({ roles: ROLES }));
      expect(recovered.user!.userId).toEqual(user.userId);
      expect(recovered.user!.uri).toBeDefined();
      expect(passwordOf(recovered.user!)).not.toEqual(passwordOf(user));

      // Settled: the next plan has nothing left to do.
      const settled = yield* stack.plan(app({ roles: ROLES }));
      expect(settled.resources.UserUnderTest).toMatchObject({ action: "noop" });

      // A new rotation key resets the password, and redeploying it does not.
      const rotated = yield* stack.deploy(app({ roles: ROLES, rotationKey: "one" }));
      expect(rotated.user!.userId).toEqual(user.userId);
      expect(rotated.user!.rotationKey).toEqual("one");
      expect(passwordOf(rotated.user!)).not.toEqual(passwordOf(recovered.user!));

      const again = yield* stack.deploy(app({ roles: ROLES, rotationKey: "one" }));
      expect(passwordOf(again.user!)).toEqual(passwordOf(rotated.user!));

      // The API has no user update, so new roles replace the user.
      const fewerRoles = [ROLES[0]!];
      const replacePlan = yield* stack.plan(app({ roles: fewerRoles, rotationKey: "one" }));
      expect(replacePlan.resources.UserUnderTest).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(app({ roles: fewerRoles, rotationKey: "one" }));
      expect(replaced.user!.userId).not.toEqual(user.userId);
      expect(replaced.user!.userName).not.toEqual(user.userName);
      expect(replaced.user!.roles).toEqual(fewerRoles);
      yield* expectGone(observeUser(projectId, region, instanceId, user.userId));

      // An explicit name: changing the roles deletes the old user first, since both
      // would hold the name.
      const named = yield* stack.deploy(app({ userName: "alchemy_user_named", roles: fewerRoles }));
      expect(named.user!.userName).toEqual("alchemy_user_named");
      yield* expectGone(observeUser(projectId, region, instanceId, replaced.user!.userId));
      const renewed = yield* stack.deploy(app({ userName: "alchemy_user_named", roles: ROLES }));
      expect(renewed.user!.userName).toEqual("alchemy_user_named");
      expect(renewed.user!.userId).not.toEqual(named.user!.userId);
      yield* expectGone(observeUser(projectId, region, instanceId, named.user!.userId));

      // Removing it from the stack deletes the user and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeUser(projectId, region, instanceId, renewed.user!.userId));
      const instance = yield* observeInstance(projectId, region, instanceId);
      expect(instance === "gone" ? "gone" : instance.state).toEqual("READY");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);
