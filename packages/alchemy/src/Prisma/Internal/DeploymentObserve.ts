import * as Effect from "effect/Effect";
import { getV1DeploymentsByDeploymentId } from "@distilled.cloud/prisma-postgres/management";

export const observeDeployment = (deploymentId: string) =>
  getV1DeploymentsByDeploymentId({ deploymentId }).pipe(
    Effect.map((response) => response.data),
  );
