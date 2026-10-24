import * as Azure from "@alchemy.run/azure";
import * as advisor from "@distilled.cloud/azure/advisor";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:advisor", "live"];

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * Advisor generates recommendations itself, so the test suppresses two of
 * the subscription-level recommendations every subscription carries (e.g.
 * "create Service Health alerts"), picked in a stable order. Security
 * recommendations cannot be suppressed (Defender for Cloud owns them).
 */
const subscriptionRecommendations = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const scope = `/subscriptions/${subscriptionId}`;
  const page = yield* advisor.ListRecommendations({ subscriptionId });
  const ids = (page.value ?? [])
    .filter(
      (rec) =>
        rec.properties?.resourceMetadata?.resourceId?.toLowerCase() === scope &&
        rec.properties.category !== "Security",
    )
    .flatMap((rec) => (rec.name === undefined ? [] : [rec.name]))
    .sort();
  return { scope, ids };
});

const getSuppression = (resourceUri: string, recommendationId: string, name: string) =>
  advisor.GetSuppression({ resourceUri, recommendationId, name });

const waitGone = <A, R>(get: Effect.Effect<A, advisor.GetSuppressionError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Milliseconds in an Advisor `ttl` (`d.hh:mm:ss[.fffffff]` or `hh:mm:ss[.fffffff]`). */
const ttlMs = (ttl: string | undefined) => {
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(ttl ?? "");
  if (match === null) return Number.NaN;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? "0") * 24 + Number(hours)) * 60 + Number(minutes)) * MINUTE +
    Number(seconds) * 1000
  );
};

const program = (props: { resourceUri: string; recommendationId: string; ttl?: string }) =>
  Effect.gen(function* () {
    const suppression = yield* Azure.Advisor.Suppression("Snooze", {
      resourceUri: props.resourceUri,
      recommendationId: props.recommendationId,
      ttl: props.ttl,
    });
    return { suppression };
  });

// Free: suppressions are metadata on existing recommendations.
test.provider(
  "snooze, extend, dismiss, replace, and delete an Advisor suppression",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { scope, ids } = yield* subscriptionRecommendations;
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const [first, second] = ids as [string, string];

      // Create: snooze for one day.
      const created = yield* stack.deploy(
        program({ resourceUri: scope, recommendationId: first, ttl: "1.00:00:00" }),
      );
      const name = created.suppression.name;
      expect(created.suppression.recommendationId).toEqual(first);
      expect(created.suppression.ttl).toEqual("1.00:00:00");
      const observed = yield* getSuppression(scope, first, name);
      expect(observed.properties?.suppressionId).toEqual(created.suppression.suppressionId);
      // Advisor reports the time left, counting down from the configured ttl.
      const firstLeft = ttlMs(observed.properties?.ttl);
      expect(DAY - firstLeft).toBeGreaterThanOrEqual(0);
      expect(DAY - firstLeft).toBeLessThan(10 * MINUTE);

      // Redeploying the same ttl does not restart the snooze.
      yield* stack.deploy(
        program({ resourceUri: scope, recommendationId: first, ttl: "1.00:00:00" }),
      );
      const unchanged = yield* getSuppression(scope, first, name);
      expect(ttlMs(unchanged.properties?.ttl)).toBeLessThan(firstLeft);

      // In place: extend the snooze.
      const extended = yield* stack.deploy(
        program({ resourceUri: scope, recommendationId: first, ttl: "2.00:00:00" }),
      );
      expect(extended.suppression.suppressionResourceId).toEqual(
        created.suppression.suppressionResourceId,
      );
      expect(extended.suppression.ttl).toEqual("2.00:00:00");
      const reobserved = yield* getSuppression(scope, first, name);
      const secondLeft = ttlMs(reobserved.properties?.ttl);
      expect(2 * DAY - secondLeft).toBeGreaterThanOrEqual(0);
      expect(2 * DAY - secondLeft).toBeLessThan(10 * MINUTE);

      // In place: dismiss with no expiry.
      const dismissed = yield* stack.deploy(program({ resourceUri: scope, recommendationId: first }));
      expect(dismissed.suppression.suppressionResourceId).toEqual(
        created.suppression.suppressionResourceId,
      );
      expect(dismissed.suppression.ttl).toBeUndefined();
      const dismissedObserved = yield* getSuppression(scope, first, name);
      expect(dismissedObserved.properties?.ttl).toEqual("");

      // Replacement: another recommendation; the first is reactivated.
      const replaced = yield* stack.deploy(
        program({ resourceUri: scope, recommendationId: second, ttl: "1.00:00:00" }),
      );
      expect(replaced.suppression.recommendationId).toEqual(second);
      expect(yield* waitGone(getSuppression(scope, first, name))).toEqual("gone");
      const moved = yield* getSuppression(scope, second, replaced.suppression.name);
      expect(moved.properties?.suppressionId).toEqual(replaced.suppression.suppressionId);
      expect(replaced.suppression.suppressionId).not.toEqual(created.suppression.suppressionId);

      yield* stack.destroy();
      expect(yield* waitGone(getSuppression(scope, second, replaced.suppression.name))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
