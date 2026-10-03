import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as mds from "@distilled.cloud/azure/manufacturingplatform";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:manufacturingplatform", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getService = (resourceGroupName: string, mdsResourceName: string) =>
  Effect.gen(function* () {
    return yield* mds.GetManufacturingDataService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      mdsResourceName,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("60 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

// The lifecycle needs a real Entra application (client ID) and admin group.
const aadApplicationId = process.env.AZURE_MDS_AAD_APP_ID ?? "";
const aksAdminGroupId = process.env.AZURE_MDS_AKS_ADMIN_GROUP_ID;

const program = (props: { env: string; enableDiagnosticSettings: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.ManufacturingPlatform.DataService("Service", {
      resourceGroup: group.resourceGroupName,
      aadApplicationId,
      aksAdminGroupId,
      enableDiagnosticSettings: props.enableDiagnosticSettings,
      tags: { env: props.env },
    });
    return { group, service };
  });

// Manufacturing Data Solutions deploys AKS (many vCPUs), Azure Data
// Explorer, Cosmos DB, Event Hubs, Redis, and Azure OpenAI into a managed
// resource group; it needs preview enrollment, gated OpenAI access, and a
// real Entra application. ~1 hour to create and again to delete; roughly
// $30-60 per run. Far beyond the free trial's vCPU quota and credit.
test.provider.skipIf(!runPaidOnly || !aadApplicationId)(
  "create, update in place, and delete a manufacturing data service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({ env: "a", enableDiagnosticSettings: false }),
      );
      const get = () =>
        getService(group.resourceGroupName, service.dataServiceName);
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.aadApplicationId).toEqual(aadApplicationId);
      expect(observed.tags?.env).toEqual("a");
      expect(service.tags).toEqual({ env: "a" });

      // In-place: tags and diagnostic settings are patched.
      const updated = yield* stack.deploy(
        program({ env: "b", enableDiagnosticSettings: true }),
      );
      expect(updated.service.dataServiceId).toEqual(service.dataServiceId);
      const reobserved = yield* get();
      expect(reobserved.tags?.env).toEqual("b");
      expect(reobserved.properties?.enableDiagnosticSettings).toEqual(true);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe (free): `Microsoft.ManufacturingPlatform` is an
// allow-listed namespace that the trial subscription cannot see, so
// registration, GET and list all fail with the typed
// `InvalidResourceNamespace` (HTTP 404, NOT a resource not-found). A probing
// PUT is not attempted: on an enrolled subscription a request that passes
// validation starts a billed ~$30-60 deployment.
test.provider(
  "the trial cannot use the manufacturing platform namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const registerError = yield* ensureRegistered(
        subscriptionId,
        "Microsoft.ManufacturingPlatform",
      ).pipe(Effect.flip);
      expect(registerError._tag).toEqual("InvalidResourceNamespace");
      const getError = yield* mds
        .GetManufacturingDataService({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          mdsResourceName: "probe-missing",
        })
        .pipe(Effect.flip);
      expect(getError._tag).toEqual("InvalidResourceNamespace");

      // The provider's list (used by nuke) treats it as "no services".
      const provider = yield* Provider.findProvider(
        Azure.ManufacturingPlatform.DataService,
      );
      expect(yield* provider.list()).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
