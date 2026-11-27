import { getDeployment } from "@distilled.cloud/prisma/unstable/management";
import * as Effect from "effect/Effect";

export const observeDeployment = (deploymentId: string) =>
  getDeployment({ deploymentId }).pipe(Effect.map((response) => response.data));
