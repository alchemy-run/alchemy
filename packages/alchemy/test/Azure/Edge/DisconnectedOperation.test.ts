import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { ensureFeature } from "../features.ts";
import { runPaidOnly } from "../gates.ts";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDisconnectedOperation = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* edge.GetDisconnectedOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      name,
    });
  });

const program = (props: {
  name?: string;
  connectionIntent: "Connected" | "Disconnected";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const appliance = yield* Azure.Edge.DisconnectedOperation("Appliance", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      connectionIntent: props.connectionIntent,
      billingConfiguration: {
        autoRenew: "Disabled",
        current: { cores: 16, pricingModel: "Trial" },
      },
      tags: props.tags,
    });
    return { group, appliance };
  });

// Needs the `Microsoft.Edge/DisconnectedOperationsAccess` subscription feature,
// which Microsoft approves manually (Azure Local disconnected operations
// application); until then it stays `Pending` and the resource type is hidden.
// Creating one starts capacity billing (Trial pricing model is free for its
// trial window; Annual is billed per core).
// Skipped: failed in the last live run. Error: feature Microsoft.Edge/DisconnectedOperationsAccess
// is still 'Pending' after 15 minutes
test.provider.skip(
  "create, update, replace, and delete a disconnected operation",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureFeature("Microsoft.Edge", "DisconnectedOperationsAccess");
      yield* stack.destroy();

      const { group, appliance } = yield* stack.deploy(
        program({ connectionIntent: "Disconnected", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const name = appliance.disconnectedOperationName;
      const observed = yield* getDisconnectedOperation(rg, name);
      expect(observed.properties?.connectionIntent).toEqual("Disconnected");
      expect(observed.tags?.env).toEqual("test");

      // In-place: connection intent and tags.
      yield* stack.deploy(
        program({ connectionIntent: "Connected", tags: { env: "prod" } }),
      );
      const updated = yield* getDisconnectedOperation(rg, name);
      expect(updated.properties?.connectionIntent).toEqual("Connected");
      expect(updated.tags?.env).toEqual("prod");

      // Replacement: a new name.
      yield* stack.deploy(
        program({
          name: "alchemy-disconnected-renamed",
          connectionIntent: "Connected",
          tags: { env: "prod" },
        }),
      );
      expect(
        (yield* getDisconnectedOperation(rg, "alchemy-disconnected-renamed"))
          .tags?.env,
      ).toEqual("prod");
      expect(yield* waitGone(getDisconnectedOperation(rg, name))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDisconnectedOperation(rg, "alchemy-disconnected-renamed"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe: without an enrollment the subscription is rejected.
test.provider(
  "a disconnected operation without an enrollment fails with InvalidResourceType",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const result = yield* edge
        .DisconnectedOperationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "probe",
          location,
          properties: {
            connectionIntent: "Disconnected",
            registrationStatus: "Unregistered",
          },
        })
        .pipe(Effect.result);
      if (result._tag === "Success") {
        yield* edge.DeleteDisconnectedOperation({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "probe",
        });
      }
      // `disconnectedOperations` is not exposed to subscriptions without an
      // approved enrollment: ARM answers InvalidResourceType.
      expect(
        result._tag === "Failure" ? result.failure._tag : "created",
      ).toEqual("InvalidResourceType");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
