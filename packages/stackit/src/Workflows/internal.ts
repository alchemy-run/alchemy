/**
 * Shared scaffolding of the STACKIT Workflows resources. Not exported from the namespace
 * barrel.
 *
 * This API has no labels. A generated name holds the generation's instance id, so it proves
 * ownership; an explicit name proves nothing without state.
 */
import * as workflows from "@distilled.cloud/stackit/workflows";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ProjectScope } from "../IaaS/internal.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";

/**
 * Create, update and delete budget. STACKIT documents no provisioning time for an instance, so
 * this is what comparable managed services here need.
 */
export const INSTANCE_TIMEOUT = "30 minutes";

const POLL = { interval: "10 seconds", maxInterval: "30 seconds" } as const;

/** The spec limits a display name to 25 characters. */
const MAX_DISPLAY_NAME_LENGTH = 25;

/**
 * The spec's 409 on an instance says "if two requests try to update the resource at the same
 * time one will succeed", and STACKIT's docs say an instance only takes changes while `active`.
 * Bounded to about a minute: an update that stays refused fails with the operation's `Conflict`.
 */
export const conflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 6,
} as const;

/** No version in this region to create an instance on. */
export class NoSupportedVersion extends Data.TaggedError("Stackit.Workflows.NoSupportedVersion")<{
  readonly region: string;
  readonly message: string;
}> {}

/**
 * `dagBundles` on Airflow 2, or `dagsRepository` on Airflow 3: the API only reads each on one
 * major version, so the prop would do nothing.
 */
export class DagSourceNotSupported extends Data.TaggedError(
  "Stackit.Workflows.DagSourceNotSupported",
)<{
  readonly version: string;
  readonly message: string;
}> {}

/**
 * A bundle changing between Git and S3 under its name, with no other bundle to keep the instance
 * valid in between: the API can't change a bundle's type, and refuses to delete the last one.
 */
export class DagBundleTypeChange extends Data.TaggedError("Stackit.Workflows.DagBundleTypeChange")<{
  readonly bundleName: string;
  readonly message: string;
}> {}

/** The `projectId` and `regionId` every operation on an instance takes. */
export const requestScope = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/** The generated display name of a generation. */
export const generatedDisplayName = (id: string) =>
  createPhysicalName({ id, maxLength: MAX_DISPLAY_NAME_LENGTH, lowercase: true });

/**
 * Whether a display name has the shape of a generated one. A shape match, not proof of ownership:
 * see `internal/names.ts`.
 */
export const isGeneratedDisplayName = (name: string): boolean =>
  isGeneratedPhysicalName(name, MAX_DISPLAY_NAME_LENGTH);

/**
 * The Airflow major version a STACKIT version names: `workflows-3.0-airflow-3.1` is 3. Docs name
 * versions this way; `undefined` for any other shape, such as the spec's example `2.9`, which
 * leaves the decision to the API.
 */
export const airflowMajorVersion = (version: string): number | undefined => {
  const major = /airflow-(\d+)/.exec(version)?.[1];
  return major === undefined ? undefined : Number(major);
};

/** The numbers in a version, compared in order: newer sorts higher. */
const versionParts = (version: string): number[] => (version.match(/\d+/g) ?? []).map(Number);

const compareVersions = (a: string, b: string): number => {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The newest version this region offers as `supported`, the only state the spec's example shows.
 * If the region reports none in that state, the newest of any state, which the API then accepts or
 * refuses.
 */
export const latestVersion = (region: string) =>
  Effect.gen(function* () {
    const { versions } = yield* workflows.getProviderOptions({ regionId: region });
    const supported = versions.filter((entry) => entry.state === "supported");
    const candidates = supported.length > 0 ? supported : versions;
    const newest = candidates
      .map((entry) => entry.version)
      .sort(compareVersions)
      .at(-1);
    if (newest === undefined) {
      return yield* new NoSupportedVersion({
        region,
        message: `STACKIT Workflows offers no version in region ${region}`,
      });
    }
    return newest;
  });

export const getInstanceOrUndefined = (scope: ProjectScope, instanceId: string) =>
  workflows
    .getInstance({ ...requestScope(scope), instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** The whole list: the operation has no paging parameters. */
export const listInstances = (scope: ProjectScope) =>
  workflows.listInstances(requestScope(scope)).pipe(Effect.map(({ instances }) => instances));

export const findInstanceByName = (scope: ProjectScope, displayName: string) =>
  listInstances(scope).pipe(
    Effect.map((instances) => instances.find((instance) => instance.displayName === displayName)),
  );

/** The instances `alchemy unsafe nuke` may delete: those with a generated name. */
export const listOwnedInstances = (scope: ProjectScope) =>
  listInstances(scope).pipe(
    Effect.map((instances) =>
      instances.filter((instance) => isGeneratedDisplayName(instance.displayName)),
    ),
  );

const instanceResource = (instanceId: string) => `STACKIT Workflows instance ${instanceId}`;

const instanceFailure = (instance: workflows.Instance) =>
  instance.statusMessage === undefined || instance.statusMessage === ""
    ? "status failed"
    : instance.statusMessage;

/**
 * Wait for an instance to be `active`. `failed` fails it with the API's `statusMessage`, except
 * for `failed` left over from before a repairing update, which `staleFailure` holds until the
 * instance reports any other status.
 */
export const waitForInstance = (
  scope: ProjectScope,
  instanceId: string,
  options: { readonly staleFailure?: boolean } = {},
) => {
  let stale = options.staleFailure ?? false;
  return waitFor({
    resource: instanceResource(instanceId),
    read: workflows.getInstance({ ...requestScope(scope), instanceId }),
    ready: (instance) => instance.status === "active",
    failed: (instance) => {
      if (instance.status !== "failed") stale = false;
      return instance.status === "failed" && !stale ? instanceFailure(instance) : undefined;
    },
    state: (instance) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });
};

/** Wait for an instance's change in flight to finish, however it ends. */
export const settleInstance = (scope: ProjectScope, instanceId: string) =>
  waitFor({
    resource: instanceResource(instanceId),
    read: workflows.getInstance({ ...requestScope(scope), instanceId }),
    ready: (instance) => instance.status === "active" || instance.status === "failed",
    state: (instance) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });

/**
 * Wait for an instance to be gone. An instance that was `failed` before the delete can stay so
 * until it's gone, so `staleFailure` leaves that case to the budget.
 */
export const waitForInstanceGone = (
  scope: ProjectScope,
  instanceId: string,
  options: { readonly staleFailure?: boolean } = {},
) => {
  let stale = options.staleFailure ?? false;
  return waitUntilGone({
    resource: instanceResource(instanceId),
    read: getInstanceOrUndefined(scope, instanceId),
    state: (instance) => instance.status,
    failed: (instance) => {
      if (instance.status !== "failed") stale = false;
      return instance.status === "failed" && !stale ? instanceFailure(instance) : undefined;
    },
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });
};
