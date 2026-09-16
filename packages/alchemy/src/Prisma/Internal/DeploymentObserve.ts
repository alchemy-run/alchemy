import * as Effect from "effect/Effect";
import { getDeployment } from "@distilled.cloud/prisma-postgres/management";

export const observeDeployment = (deploymentId: string) =>
  getDeployment({ deploymentId }).pipe(Effect.map((response) => response.data));
