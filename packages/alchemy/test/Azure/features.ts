import * as Azure from "@/Azure";
import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Register a subscription preview feature (e.g. `Microsoft.Network` /
 * `AllowServiceGateways`) before a test that needs it, then re-register
 * the resource provider so the feature flag propagates to it.
 *
 * Auto-approved features reach `Registered` within a few minutes. Features
 * that need Microsoft approval stay `Pending`; this fails with that state so
 * the test reports the real blocker. A no-op when already registered.
 */
export const ensureFeature = (namespace: string, featureName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const request = {
      subscriptionId,
      resourceProviderNamespace: namespace,
      featureName,
    };
    const stateOf = resources
      .GetFeature(request)
      .pipe(Effect.map((f) => f.properties?.state ?? "NotRegistered"));
    if ((yield* stateOf) === "Registered") return;
    yield* resources.RegisterFeature(request);
    const state = yield* stateOf.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("20 seconds"),
        until: (s) => s === "Registered",
        times: 45,
      }),
    );
    if (state !== "Registered") {
      return yield* Effect.fail(
        new Error(
          `feature ${namespace}/${featureName} is still '${state}' after 15 minutes`,
        ),
      );
    }
    yield* resources.RegisterProvider({
      subscriptionId,
      resourceProviderNamespace: namespace,
    });
  });
