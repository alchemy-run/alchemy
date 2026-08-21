import * as Effect from "effect/Effect";
import type { Conflict } from "@distilled.cloud/prisma-postgres";
import {
  postV1DeploymentsByDeploymentIdStart,
  postV1DeploymentsByDeploymentIdStop,
} from "@distilled.cloud/prisma-postgres/management";
import { observeDeployment } from "./DeploymentObserve.ts";

const startConflictIsIdempotent = (deploymentId: string, error: Conflict) =>
  observeDeployment(deploymentId).pipe(
    Effect.flatMap((deployment) =>
      deployment.status === "running" || deployment.status === "provisioning"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
    Effect.catchTag("NotFound", () => Effect.fail(error)),
  );

const stopConflictIsIdempotent = (deploymentId: string, error: Conflict) =>
  observeDeployment(deploymentId).pipe(
    Effect.flatMap((deployment) =>
      deployment.status === "stopped" || deployment.status === "stopping"
        ? Effect.void
        : Effect.fail(error),
    ),
    Effect.catchTag("NotFound", () => Effect.fail(error)),
  );

export const startDeploymentIdempotent = (deploymentId: string) =>
  postV1DeploymentsByDeploymentIdStart({ deploymentId }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("Conflict", (error) =>
      startConflictIsIdempotent(deploymentId, error),
    ),
  );

export const stopDeploymentIdempotent = (deploymentId: string) =>
  postV1DeploymentsByDeploymentIdStop({ deploymentId }).pipe(
    Effect.asVoid,
    Effect.catchTag("Conflict", (error) =>
      stopConflictIsIdempotent(deploymentId, error),
    ),
  );
