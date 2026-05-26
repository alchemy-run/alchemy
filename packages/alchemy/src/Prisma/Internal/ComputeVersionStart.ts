import * as Effect from "effect/Effect";
import {
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "../Client.ts";

export const startComputeServiceVersionWithFallback = (
  client: PrismaManagementClient,
  versionId: string,
) =>
  client.startComputeServiceVersion(versionId).pipe(
    Effect.catchIf(isConflict, () => Effect.succeed(undefined)),
    Effect.catch((primaryError) =>
      isNotFound(primaryError)
        ? client.startComputeVersion(versionId).pipe(
            Effect.catchIf(
              (fallbackError) =>
                isNotFound(fallbackError) || isConflict(fallbackError),
              () => Effect.succeed(undefined),
            ),
          )
        : Effect.fail(primaryError),
    ),
  );
