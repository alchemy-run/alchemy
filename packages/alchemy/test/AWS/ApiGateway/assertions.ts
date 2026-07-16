import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Post-destroy "assert gone" helpers shared by the ApiGateway suite.
 *
 * Each helper reads the resource out-of-band via distilled and succeeds only
 * once the API answers with the typed `NotFoundException`. A resource that is
 * still visible after the bounded retry window fails the test with
 * `ResourceStillExists` — proving the trailing `stack.destroy()` actually
 * deleted everything (zero orphans).
 */
export class ResourceStillExists extends Data.TaggedError(
  "ResourceStillExists",
)<{
  readonly resource: string;
}> {}

// Deletion is effectively read-your-write for API Gateway, but reads are
// also subject to the account-wide throttle during a busy suite — retry
// both "still visible" and `TooManyRequestsException` briefly.
const goneSchedule = Schedule.max([
  Schedule.exponential(500),
  Schedule.recurs(8),
]);

export const assertRestApiDeleted = Effect.fn(function* (restApiId: string) {
  yield* ag.getRestApi({ restApiId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(
        new ResourceStillExists({ resource: `RestApi ${restApiId}` }),
      ),
    ),
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ResourceStillExists" ||
        e._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});

export const assertApiKeyDeleted = Effect.fn(function* (apiKeyId: string) {
  yield* ag.getApiKey({ apiKey: apiKeyId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ResourceStillExists({ resource: `ApiKey ${apiKeyId}` })),
    ),
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ResourceStillExists" ||
        e._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});

export const assertUsagePlanDeleted = Effect.fn(function* (
  usagePlanId: string,
) {
  yield* ag.getUsagePlan({ usagePlanId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(
        new ResourceStillExists({ resource: `UsagePlan ${usagePlanId}` }),
      ),
    ),
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ResourceStillExists" ||
        e._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});

export const assertDomainNameDeleted = Effect.fn(function* (
  domainName: string,
) {
  yield* ag.getDomainName({ domainName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(
        new ResourceStillExists({ resource: `DomainName ${domainName}` }),
      ),
    ),
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ResourceStillExists" ||
        e._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});

export const assertVpcLinkDeleted = Effect.fn(function* (vpcLinkId: string) {
  // A VPC link lingers in DELETING for several minutes after deleteVpcLink;
  // reaching that status is the terminal signal deletion was accepted.
  yield* ag.getVpcLink({ vpcLinkId }).pipe(
    Effect.flatMap((link) =>
      link.status === "DELETING"
        ? Effect.void
        : Effect.fail(
            new ResourceStillExists({ resource: `VpcLink ${vpcLinkId}` }),
          ),
    ),
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ResourceStillExists" ||
        e._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});
