/** Out-of-band reads of what the Rivet GCP hosts deployed, through distilled. */
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { sanitizeLabelValue } from "@alchemy.run/gcp/Labels";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** The labels every resource of a stack's stage carries. */
const ownedBy = (stack: { readonly name: string; readonly stage: string }) => ({
  "alchemy-stack": sanitizeLabelValue(stack.name),
  "alchemy-stage": sanitizeLabelValue(stack.stage),
});

const owns = (
  stack: { readonly name: string; readonly stage: string },
  labels: Record<string, string | undefined> | undefined,
) => Object.entries(ownedBy(stack)).every(([key, value]) => labels?.[key] === value);

/** The stack's Compute Engine instances whose logical id ends with `suffix`, by id. */
export const instances = Effect.fn(function* (
  stack: { readonly name: string; readonly stage: string },
  suffix: RegExp,
) {
  const { project } = yield* GcpEnvironment.current;
  const pages = yield* compute.aggregatedListInstances
    .pages({ project, filter: "labels.alchemy-stack:*", returnPartialSuccess: true })
    .pipe(Stream.runCollect);
  return Array.from(pages)
    .flatMap((page) => Object.values(page.items ?? {}).flatMap((zone) => zone?.instances ?? []))
    .filter(
      (instance) =>
        owns(stack, instance.labels) && suffix.test(instance.labels?.["alchemy-id"] ?? ""),
    )
    .sort((a, b) => (a.labels?.["alchemy-id"] ?? "").localeCompare(b.labels?.["alchemy-id"] ?? ""));
});

/** An instance's metadata as a record. */
export const metadataOf = (instance: compute.Instance) =>
  Object.fromEntries(
    (instance.metadata?.items ?? []).map((item) => [item.key ?? "", item.value ?? ""]),
  );

/** The stack's Cloud Run worker pools whose logical id ends with `suffix`. */
export const workerPools = Effect.fn(function* (
  stack: { readonly name: string; readonly stage: string },
  suffix: RegExp,
) {
  const { project, region } = yield* GcpEnvironment.current;
  const pages = yield* run.listProjectsLocationsWorkerPools
    .pages({ parent: `projects/${project}/locations/${region}` })
    .pipe(Stream.runCollect);
  return Array.from(pages)
    .flatMap((page) => page.workerPools ?? [])
    .filter((pool) => owns(stack, pool.labels) && suffix.test(pool.labels?.["alchemy-id"] ?? ""));
});

/** Members granted `role` on a Secret Manager secret. */
export const secretMembers = Effect.fn(function* (secret: string, role: string) {
  const policy = yield* secretmanager.getIamPolicyProjectsSecrets({ resource: secret });
  return (policy.bindings ?? []).find((binding) => binding.role === role)?.members ?? [];
});

/** The rollout markers nodes wrote to a pool's program bucket. */
export const rolloutMarkers = Effect.fn(function* (bucket: string, rollout: string) {
  const pages = yield* storage.listObjects
    .pages({ bucket, prefix: `rollout/${rollout}/` })
    .pipe(Stream.runCollect);
  return Array.from(pages)
    .flatMap((page) => page.items ?? [])
    .map((object) => ({ name: object.name ?? "", created: object.timeCreated ?? "" }));
});
