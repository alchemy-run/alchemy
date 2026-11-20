import {
  type GetServiceDeploymentsResponse,
  getServiceDeployments,
} from "@distilled.cloud/prisma/management";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { PrismaPaginationError } from "./Pagination.ts";

export class ComputeVersionIdentityConflict extends Data.TaggedError(
  "ComputeVersionIdentityConflict",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Prove that a version belongs to a Compute service before mutating or deleting it. */
/** Every version of a service, across pages. */
export const listServiceVersions = Effect.fn(function* (serviceId: string) {
  // Distilled emits the cursor-paginated list operations as plain ops, so
  // callers walk `pagination` themselves (see `src/Neon/Project.ts`).
  const deployments: GetServiceDeploymentsResponse["data"][number][] = [];
  let cursor: string | undefined;
  while (true) {
    const page = yield* getServiceDeployments(
      cursor === undefined ? { serviceId } : { serviceId, cursor },
    );
    deployments.push(...page.data);
    const nextCursor = page.pagination.nextCursor;
    if (!page.pagination.hasMore) break;
    if (nextCursor === null) {
      return yield* new PrismaPaginationError({
        message:
          "Invalid Prisma Management API pagination response from getServiceDeployments: hasMore was true without a non-empty nextCursor",
      });
    }
    cursor = nextCursor;
  }
  return deployments;
});

export const ensureVersionMembership = Effect.fn(function* (
  appId: string,
  deployment: { id: string; foundryVersionId: string },
  knownLatestDeploymentId?: string | null,
) {
  if (knownLatestDeploymentId === deployment.id) return;
  const deployments = yield* listServiceVersions(appId);
  const matches = deployments.filter((candidate) => candidate.id === deployment.id);
  if (matches.length !== 1 || matches[0]?.foundryVersionId !== deployment.foundryVersionId) {
    return yield* new ComputeVersionIdentityConflict({
      message: `Prisma deployment '${deployment.id}' with Foundry version '${deployment.foundryVersionId}' is not uniquely owned by Compute service '${appId}'. Refusing to start, promote, or delete a mismatched deployment.`,
    });
  }
});
