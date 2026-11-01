import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as dremio from "@distilled.cloud/stackit/dremio";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  observeInstance,
  observeUser,
  OTHER_TEST_PASSWORD,
  slow,
  TEST_PASSWORD,
  userProps,
} from "./dremio.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("dremio", "user"),
  timeout: 3_600_000,
} as const;

/** The instance, plus the user when `user` is given. */
const app = (user?: Partial<Stackit.Dremio.UserProps>) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Dremio.Instance("UserInstance", { acl: CLOSED_ACL });
    if (user === undefined) return { instance, user: undefined };
    return {
      instance,
      user: yield* Stackit.Dremio.User("UserUnderTest", {
        instanceId: instance.instanceId,
        ...userProps,
        ...user,
      }),
    };
  });

test.provider.skipIf(slow)(
  "create, replace, adopt and delete a user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // A generated name, and the attributes a data plane binding reads.
      const created = yield* stack.deploy(app({}));
      const instanceId = created.instance.instanceId;
      const user = created.user!;
      expect(user.instanceId).toEqual(instanceId);
      expect(user.state).toEqual("active");
      expect(user.email).toEqual(userProps.email);
      expect(user.uiUrl).toEqual(created.instance.endpoints.ui);
      expect(user.catalogUrl).toEqual(created.instance.endpoints.catalog);
      expect(user.arrowFlightUrl).toEqual(created.instance.endpoints.arrowFlight);
      expect(Redacted.isRedacted(user.password)).toEqual(true);
      expect(Redacted.value(user.password!)).toEqual(Redacted.value(TEST_PASSWORD));

      // Out of band: the user exists, and the API returns no password.
      const fetched = yield* dremio.getDremioUser({
        projectId,
        regionId: region,
        dremioId: instanceId,
        dremioUserId: user.userId,
      });
      expect(fetched.name).toEqual(user.userName);
      expect(fetched.firstName).toEqual(userProps.firstName);
      expect(fetched.lastName).toEqual(userProps.lastName);
      expect(JSON.stringify(fetched)).not.toContain(Redacted.value(TEST_PASSWORD));

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Dremio.User);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.userId === user.userId)?.userName).toEqual(user.userName);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({}));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });

      // The API can't update a user: a new email replaces it, and a generated name lets the
      // new user come up first.
      const emailPlan = yield* stack.plan(app({ email: "alchemy-test-2@example.com" }));
      expect(emailPlan.resources.UserUnderTest).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(app({ email: "alchemy-test-2@example.com" }));
      expect(replaced.user!.userId).not.toEqual(user.userId);
      expect(replaced.user!.userName).not.toEqual(user.userName);
      expect(replaced.user!.email).toEqual("alchemy-test-2@example.com");
      yield* expectGone(observeUser(projectId, region, instanceId, user.userId));

      // An explicit name is another identity. The new user replaces the generated one.
      const named = yield* stack.deploy(app({ name: "alchemy-dremio-user" }));
      expect(named.user!.userName).toEqual("alchemy-dremio-user");
      yield* expectGone(observeUser(projectId, region, instanceId, replaced.user!.userId));

      // A new password can't be seen in the API, and still replaces. An explicit name can't
      // exist twice, so the old user goes first and the name survives.
      const repassworded = yield* stack.deploy(
        app({ name: "alchemy-dremio-user", password: OTHER_TEST_PASSWORD }),
      );
      expect(repassworded.user!.userId).not.toEqual(named.user!.userId);
      expect(repassworded.user!.userName).toEqual("alchemy-dremio-user");
      expect(Redacted.value(repassworded.user!.password!)).toEqual(
        Redacted.value(OTHER_TEST_PASSWORD),
      );
      yield* expectGone(observeUser(projectId, region, instanceId, named.user!.userId));

      // A description added later replaces too.
      const described = yield* stack.deploy(
        app({
          name: "alchemy-dremio-user",
          password: OTHER_TEST_PASSWORD,
          description: "With a description",
        }),
      );
      expect(described.user!.description).toEqual("With a description");
      expect(described.user!.userId).not.toEqual(repassworded.user!.userId);

      // Removing it from the stack deletes the user and leaves the instance.
      const removed = yield* stack.deploy(app());
      expect(removed.instance.instanceId).toEqual(instanceId);
      yield* expectGone(observeUser(projectId, region, instanceId, described.user!.userId));

      // A user the stack doesn't know is refused, and only taken over with adopt.
      const foreign = yield* dremio.createDremioUser({
        projectId,
        regionId: region,
        dremioId: instanceId,
        name: "alchemy-dremio-foreign",
        ...userProps,
      });
      const foreignApp = Effect.gen(function* () {
        const { instance } = yield* app();
        return yield* Stackit.Dremio.User("ForeignUser", {
          instanceId: instance.instanceId,
          name: "alchemy-dremio-foreign",
          ...userProps,
        });
      });
      const refused = yield* stack.deploy(foreignApp).pipe(Effect.flip);
      expect(refused._tag).toEqual("OwnedBySomeoneElse");
      const stillThere = yield* observeUser(projectId, region, instanceId, foreign.id);
      expect(stillThere).not.toEqual("gone");

      const adopted = yield* stack.deploy(foreignApp.pipe(adopt(true)));
      expect(adopted.userId).toEqual(foreign.id);

      yield* stack.destroy();
      yield* expectGone(observeUser(projectId, region, instanceId, foreign.id));
      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a generated-name user found after an interrupted create is picked up",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({}));
      const user = created.user!;

      // What a crash after `createDremioUser` leaves: a row still creating, with its
      // generation, and no copy of the id.
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

      const recovered = yield* stack.deploy(app({}));
      expect(recovered.user!.userId).toEqual(user.userId);
      expect(recovered.user!.userName).toEqual(user.userName);
      expect(Redacted.value(recovered.user!.password!)).toEqual(Redacted.value(TEST_PASSWORD));

      const users = yield* dremio.listDremioUsers({
        projectId,
        regionId: region,
        dremioId: created.instance.instanceId,
      });
      expect(users.dremioUsers.filter((entry) => entry.name === user.userName)).toHaveLength(1);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, created.instance.instanceId));
    }).pipe(logLevel),
  options,
);
