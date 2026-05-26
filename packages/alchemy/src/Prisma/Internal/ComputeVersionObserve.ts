import * as Effect from "effect/Effect";
import { isNotFound, type PrismaManagementClient } from "../Client.ts";

export const observeComputeVersion = (
  client: PrismaManagementClient,
  versionId: string,
) =>
  (typeof client.getComputeServiceVersion === "function"
    ? client.getComputeServiceVersion(versionId)
    : client.getComputeVersion(versionId)
  ).pipe(
    Effect.catch((primaryError) =>
      typeof client.getComputeVersion === "function"
        ? client
            .getComputeVersion(versionId)
            .pipe(
              Effect.catch((fallbackError) =>
                isNotFound(primaryError)
                  ? Effect.fail(fallbackError)
                  : Effect.fail(primaryError),
              ),
            )
        : Effect.fail(primaryError),
    ),
  );
