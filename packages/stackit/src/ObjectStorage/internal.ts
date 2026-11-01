import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Idempotently enable Object Storage for a project in a region.
 *
 * Object Storage does not use the Service Enablement API: a project is
 * "created" in the Object Storage service itself (`POST
 * /v2/project/{projectId}/regions/{region}`, distilled `enableService`),
 * which provisions the project's tenant and its `default` credentials
 * group. The STACKIT API documents the call as idempotent ("will also be
 * successful if the project already exists"); this helper still observes
 * first so an already-enabled project costs one GET.
 *
 * Never disabled by Alchemy: `disableService` deletes the project's whole
 * Object Storage tenant, including buckets Alchemy does not manage.
 */
export const ensureObjectStorageEnabled = Effect.fn("Stackit.ObjectStorage.ensureEnabled")(
  function* (input: { readonly projectId: string; readonly region: string }) {
    const status = yield* objectStorage
      .getServiceStatus({ projectId: input.projectId, region: input.region })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
    if (status !== undefined) return status;
    return yield* objectStorage.enableService({
      projectId: input.projectId,
      region: input.region,
    });
  },
);

/** Normalize a distilled sensitive value (`string | Redacted<string>`) to `Redacted`. */
export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;
