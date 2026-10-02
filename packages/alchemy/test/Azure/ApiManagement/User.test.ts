import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  basicV2Service,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getUser = (
  resourceGroupName: string,
  serviceName: string,
  userId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetUser({ subscriptionId, resourceGroupName, serviceName, userId }),
  );

const program = (user?: {
  name: string;
  state: Azure.ApiManagement.UserState;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = user
      ? yield* Azure.ApiManagement.User("Jane", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: user.name,
          email: `${user.name}@example.com`,
          firstName: "Jane",
          lastName: "Doe",
          state: user.state,
        })
      : undefined;
    return { group, service, user: created };
  });

// Users are not available on Consumption ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-jane", state: "active" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.user?.userName).toEqual("alchemy-jane");
      const observed = yield* getUser(rg, svc, "alchemy-jane");
      expect(observed.properties?.email).toEqual("alchemy-jane@example.com");
      expect(observed.properties?.state).toEqual("active");

      // In-place update of the account state.
      yield* stack.deploy(program({ name: "alchemy-jane", state: "blocked" }));
      expect(
        (yield* getUser(rg, svc, "alchemy-jane")).properties?.state,
      ).toEqual("blocked");

      // Replacement: a new identifier creates a new user, deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-jane-v2", state: "active" }),
      );
      expect(replaced.user?.userName).toEqual("alchemy-jane-v2");
      expect(yield* untilGone(getUser(rg, svc, "alchemy-jane"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the user.
      yield* stack.deploy(program());
      expect(yield* untilGone(getUser(rg, svc, "alchemy-jane-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
