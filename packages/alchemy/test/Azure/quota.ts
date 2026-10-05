import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as quota from "@distilled.cloud/azure/quota";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Raise a subscription quota (e.g. `Microsoft.Compute` / `standardDSv5Family`
 * in `eastus`) to at least `minimum` before a test that needs it.
 *
 * New pay-as-you-go subscriptions start with low regional vCPU, VM-family
 * and HDInsight core limits. Most raises are auto-approved by the
 * Microsoft.Quota API within a few minutes; legacy families (DSv3, BS) are
 * capped and fail with a `BadRequest` naming the recommended replacements.
 * A no-op when the limit is already high enough.
 */
export const ensureQuota = (props: {
  provider: string;
  resourceName: string;
  minimum: number;
  location?: string;
}) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* ensureRegistered(subscriptionId, "Microsoft.Quota");
    const scope = `/subscriptions/${subscriptionId}/providers/${props.provider}/locations/${props.location ?? "eastus"}`;
    const limitOf = quota
      .GetQuota({ scope, resourceName: props.resourceName })
      .pipe(Effect.map((q) => q.properties?.limit?.value ?? 0));
    if ((yield* limitOf) >= props.minimum) return;
    yield* quota.QuotaCreateOrUpdate({
      scope,
      resourceName: props.resourceName,
      properties: {
        limit: { limitObjectType: "LimitValue", value: props.minimum },
        name: { value: props.resourceName },
      },
    });
    const limit = yield* limitOf.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (value) => value >= props.minimum,
        times: 40,
      }),
    );
    if (limit < props.minimum) {
      return yield* Effect.fail(
        new Error(
          `${props.provider}/${props.resourceName} quota is still ${limit} (wanted ${props.minimum}) after 10 minutes`,
        ),
      );
    }
  });
