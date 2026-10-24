import * as Azure from "@alchemy.run/azure";
import * as trafficmanager from "@distilled.cloud/azure/trafficmanager";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

/** The subscription's key, or `""` when it has none. */
const observedKey = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const observed = yield* trafficmanager
    .GetTrafficManagerUserMetricsKey({ subscriptionId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  return observed?.properties?.key ?? "";
});

const keyGone = observedKey.pipe(
  Effect.repeat({
    schedule: Schedule.spaced("3 seconds"),
    until: (key) => key === "",
    times: 10,
  }),
);

const program = Effect.gen(function* () {
  return yield* Azure.TrafficManager.UserMetricsKey("RumKey", {});
});

// The key is free.
// Skipped: every GET/PUT/DELETE on
// /subscriptions/{id}/providers/Microsoft.Network/trafficManagerUserMetricsKeys/default
// answers 401 with an HTML "Request Error" page ("The server encountered an
// error processing the request"), for api-versions 2018-04-01, 2022-04-01,
// 2024-04-01-preview and 2026-09-01, with and without a profile in the
// subscription, while other Traffic Manager calls on the same token succeed.
test.provider.skip(
  "create, redeploy, and delete the traffic manager user metrics key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      expect(created.userMetricsKeyId.toLowerCase()).toEqual(
        `/subscriptions/${subscriptionId}/providers/microsoft.network/trafficmanagerusermetricskeys/default`,
      );
      const key = Redacted.value(created.key);
      expect(key.length).toBeGreaterThan(0);
      expect(yield* observedKey).toEqual(key);

      // A redeploy keeps the existing key instead of regenerating it.
      const redeployed = yield* stack.deploy(program);
      expect(Redacted.value(redeployed.key)).toEqual(key);
      expect(yield* observedKey).toEqual(key);

      yield* stack.destroy();
      expect(yield* keyGone).toEqual("");
    }),
  {
    tags: ["provider:azure", "provider:azure:trafficmanager", "live"],
    timeout: 300_000,
  },
);
