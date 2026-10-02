import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * ARM ID of an existing custom location (an Arc-enabled Kubernetes cluster
 * with the workload orchestration extension). The test subscription has
 * none.
 */
const customLocationId = process.env.AZURE_TEST_EDGE_CUSTOM_LOCATION_ID ?? "";

const getDiagnostic = (resourceGroupName: string, diagnosticName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetDiagnostic({
      subscriptionId: yield* subscription,
      resourceGroupName,
      diagnosticName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const diagnostic = yield* Azure.Edge.Diagnostic("Diagnostic", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      customLocationId,
      tags: props.tags,
    });
    return { group, diagnostic };
  });

// Needs an Arc-enabled Kubernetes cluster with a custom location
// (AZURE_TEST_EDGE_CUSTOM_LOCATION_ID), which the free trial does not have.
// The diagnostic itself is free.
test.provider.skipIf(!runPaidOnly || !customLocationId)(
  "create, update, replace, and delete a diagnostic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, diagnostic } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(diagnostic.customLocationId).toEqual(customLocationId);
      const observed = yield* getDiagnostic(rg, diagnostic.diagnosticName);
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(
        (yield* getDiagnostic(rg, diagnostic.diagnosticName)).tags?.env,
      ).toEqual("prod");

      // Replacement: a new name.
      yield* stack.deploy(
        program({ name: "alchemy-diagnostic-renamed", tags: { env: "prod" } }),
      );
      expect(
        (yield* getDiagnostic(rg, "alchemy-diagnostic-renamed")).tags?.env,
      ).toEqual("prod");
      expect(
        yield* waitGone(getDiagnostic(rg, diagnostic.diagnosticName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getDiagnostic(rg, "alchemy-diagnostic-renamed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: without a custom location the trial gets the typed error.
test.provider(
  "a diagnostic without a custom location fails with CustomLocationNotFound",
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
      const error = yield* edge
        .DiagnosticsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          diagnosticName: "probe",
          location,
          extendedLocation: {
            name: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`,
            type: "CustomLocation",
          },
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
