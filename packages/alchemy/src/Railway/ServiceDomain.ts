import { Retry as RailwayRetry } from "@distilled.cloud/railway";
import type { DomainsResponseServiceDomainsItem } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isRailwayTransient } from "./transient.ts";

/**
 * A Railway-generated `*.up.railway.app` hostname on a Service. Created
 * with `serviceDomainCreate`. Distinct from {@link CustomDomain} (a user
 * hostname).
 */
export type ServiceDomainRecord = {
  id: string;
  domain: string;
  serviceId: string;
  environmentId: string;
  projectId: string | undefined;
  targetPort: number | undefined;
  syncStatus: string;
  url: string;
};

export class ServiceDomainNotCreated extends Data.TaggedError(
  "Railway.ServiceDomainNotCreated",
)<{
  serviceId: string;
  environmentId: string;
}> {}

type CloudDomain = DomainsResponseServiceDomainsItem;

const isGone = (domain: CloudDomain | undefined) =>
  domain === undefined ||
  domain.deletedAt != null ||
  domain.syncStatus === "DELETED" ||
  domain.syncStatus === "DELETING";

const toRecord = (domain: CloudDomain): ServiceDomainRecord => ({
  id: domain.id,
  domain: domain.domain,
  serviceId: domain.serviceId,
  environmentId: domain.environmentId,
  projectId: domain.projectId ?? undefined,
  targetPort: domain.targetPort ?? undefined,
  syncStatus: domain.syncStatus,
  url: `https://${domain.domain}`,
});

const alreadyExists = (message: string) =>
  /already exists|already in use|already taken|duplicate/i.test(message);

export const listServiceDomains = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway.domains({ environmentId, projectId, serviceId }).pipe(
    Effect.map((result) =>
      result.serviceDomains.filter((domain) => !isGone(domain)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as DomainsResponseServiceDomainsItem[]),
    ),
  );

/**
 * Observe-ensure-sync a generated `*.up.railway.app` domain. Creates one
 * when missing, updates `targetPort` in place, and returns the live record.
 */
export const ensureServiceDomain = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  targetPort?: number;
}) {
  let current = (yield* listServiceDomains(
    input.projectId,
    input.environmentId,
    input.serviceId,
  ))[0];

  if (current === undefined) {
    yield* railway
      .serviceDomainCreate({
        input: {
          environmentId: input.environmentId,
          serviceId: input.serviceId,
          ...(input.targetPort !== undefined
            ? { targetPort: input.targetPort }
            : {}),
        },
      })
      .pipe(
        RailwayRetry.none,
        Effect.retry({
          while: isRailwayTransient,
          schedule: Schedule.spaced("15 seconds"),
          times: 10,
        }),
        Effect.catchTag("RailwayValidationError", (e) =>
          alreadyExists(e.message) ? Effect.void : Effect.fail(e),
        ),
        Effect.catchTag("Conflict", () => Effect.void),
      );
    current = (yield* listServiceDomains(
      input.projectId,
      input.environmentId,
      input.serviceId,
    ))[0];
  }

  if (current === undefined || isGone(current)) {
    return yield* new ServiceDomainNotCreated({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    });
  }

  const observedPort = current.targetPort ?? undefined;
  const desiredPort = input.targetPort;
  if (desiredPort !== undefined && desiredPort !== observedPort) {
    yield* railway
      .serviceDomainUpdate({
        input: {
          domain: current.domain,
          environmentId: current.environmentId,
          serviceDomainId: current.id,
          serviceId: current.serviceId,
          targetPort: desiredPort,
        },
      })
      .pipe(
        RailwayRetry.none,
        Effect.retry({
          while: isRailwayTransient,
          schedule: Schedule.spaced("15 seconds"),
          times: 10,
        }),
      );
    current =
      (yield* listServiceDomains(
        input.projectId,
        input.environmentId,
        input.serviceId,
      ))[0] ?? current;
  }

  return toRecord(current);
});
