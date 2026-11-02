import * as sfs from "@distilled.cloud/stackit/sfs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type FileStorageScope,
  generatedName,
  getPoolOrUndefined,
  getShareOrUndefined,
  listAllPools,
  listPoolShares,
  type ObservedShare,
  requireShare,
  SHARE_TIMEOUT,
} from "./internal.ts";

export interface ShareProps {
  /**
   * Resource pool holding the share. Changing it replaces the share, and **the share's
   * data is lost**. A pool that is itself replaced replaces its shares.
   */
  resourcePoolId: string;
  /**
   * Name of the share, and the last part of its mount path. STACKIT can't rename a
   * share, so changing it replaces the share, and **the share's data is lost**. Removing
   * an explicit name keeps the share under the name it has.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Most space the share can use, in GB. `0` gives it all the space of its pool. Updates
   * in place.
   */
  spaceHardLimitGigabytes: number;
  /**
   * Name of the {@link ShareExportPolicy} deciding who can mount the share and how.
   * Without one, clients in the pool's `ipAcl` can mount it read-only, and nobody can
   * write to it. Updates in place. Removing the prop removes the policy from the share;
   * a share that never set it keeps what it has.
   */
  exportPolicyName?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the share. Changing it replaces the share, and **the share's data
   * is lost**.
   *
   * @default the profile's project
   */
  projectId?: string;
  /**
   * Region of the share. Changing it replaces the share, and **the share's data is
   * lost**.
   *
   * @default the profile's region
   */
  region?: string;
}

export interface ShareAttributes {
  /** STACKIT share id. Stable across updates. */
  shareId: string;
  /** Resource pool holding the share. */
  resourcePoolId: string;
  /** Project that owns the share. */
  projectId: string;
  /** Region of the share. */
  region: string;
  /** Name of the share. */
  name: string;
  /** Address to mount the share from, such as `10.2.1.1:/rp_VKL20Ub/my-share`. */
  mountPath: string | undefined;
  /** Most space the share can use in GB; `0` is all of its pool. */
  spaceHardLimitGigabytes: number | undefined;
  /** Name of the share's export policy, if any. */
  exportPolicy: string | undefined;
  /** Share state; `created` after a deploy. */
  state: string | undefined;
  /** When the share was created. */
  createdAt: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Share = Resource<
  "Stackit.FileStorage.Share",
  ShareProps,
  ShareAttributes,
  never,
  Providers
>;

/**
 * A STACKIT File Storage share: an NFS export in a {@link ResourcePool} that clients
 * mount through `mountPath`.
 *
 * The space limit, export policy and labels update in place. **The name, pool, project
 * and region replace the share, and a replacement starts empty: the share's data is
 * lost**, so copy it out first. Replacing the pool replaces its shares too. An explicit
 * name deletes the old share before the new one exists; a generated name creates the new
 * one first. Destroying a share deletes its data.
 *
 * Without an export policy the share mounts read-only for the pool's `ipAcl`: read-write
 * access takes a {@link ShareExportPolicy}, and its rules can only narrow the pool's
 * ACL. Clients mount it over NFS, so use {@link MountShare} for a `Stackit.IaaS.Server`.
 *
 * A share has no charge of its own: the pool's size is what is billed.
 *
 * Ownership is tracked with labels. A share with the same name that lacks them is
 * reported as unowned and only taken over with `--adopt`.
 *
 * See [STACKIT's File Storage docs](https://docs.stackit.cloud/products/storage/file-storage/).
 *
 * :::caution[Changing `resourcePoolId`, `name`, `projectId` or `region` replaces the Share]
 * A replacement starts empty: the share's data is lost, so copy it out first.
 * Replacing the pool replaces its shares too.
 * :::
 *
 * ### Creating a Share
 * **Example:** A read-only share using all of its pool
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   spaceHardLimitGigabytes: 0,
 * });
 * ```
 *
 * **Example:** A read-write share limited to 100 GB
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   rules: [{ order: 1, ipAcl: ["10.0.0.0/24"] }],
 * });
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   spaceHardLimitGigabytes: 100,
 *   exportPolicyName: policy.name,
 *   labels: { env: "production" },
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a share loses its data
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * // A new, empty share, and the old one and its data are deleted first. Take a
 * // `ResourcePoolSnapshot` and copy what you need before you deploy this.
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   name: "assets-v2",
 *   spaceHardLimitGigabytes: 100,
 * });
 * ```
 *
 * @resource
 * @product STACKIT File Storage
 * @category FileStorage
 */
export const Share = Resource<Share>("Stackit.FileStorage.Share");

const toAttrs = (
  scope: FileStorageScope,
  resourcePoolId: string,
  share: ObservedShare,
): ShareAttributes => ({
  shareId: share.id,
  resourcePoolId,
  projectId: scope.projectId,
  region: scope.region,
  name: share.name ?? "",
  mountPath: share.mountPath,
  spaceHardLimitGigabytes: share.spaceHardLimitGigabytes,
  exportPolicy: share.exportPolicy?.name,
  state: share.state,
  createdAt: share.createdAt,
  labels: stripInternalLabels(share.labels),
});

type SharePatch = Omit<
  sfs.UpdateShareRequest,
  "projectId" | "region" | "resourcePoolId" | "shareId"
>;

/** The delta between an observed share and the desired props (empty when in sync). */
const shareDelta = (
  share: ObservedShare,
  news: ShareProps,
  olds: ShareProps | undefined,
  labels: Record<string, string>,
): SharePatch => {
  const patch: SharePatch = {};
  if (share.spaceHardLimitGigabytes !== news.spaceHardLimitGigabytes) {
    patch.spaceHardLimitGigabytes = news.spaceHardLimitGigabytes;
  }
  // `""` is how the API removes a policy, and null keeps it. Unset leaves it, so a share
  // that never set this prop (an adopted one) doesn't lose its clients.
  const policy = news.exportPolicyName ?? (olds?.exportPolicyName !== undefined ? "" : undefined);
  if (policy !== undefined && (share.exportPolicy?.name ?? "") !== policy) {
    patch.exportPolicyName = policy;
  }
  if (labelsChanged(share.labels, labels)) patch.labels = labels;
  return patch;
};

/** Wait until a share is `created` and `applied` holds, for a change just sent. */
const waitForShare = (
  scope: FileStorageScope,
  resourcePoolId: string,
  shareId: string,
  applied: (share: ObservedShare) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT File Storage share ${shareId}`,
    read: sfs.getShare({ ...scope, resourcePoolId, shareId }).pipe(Effect.flatMap(requireShare)),
    ready: (share) => share.state === "created" && applied(share),
    failed: (share) =>
      share.state === "error"
        ? "error"
        : share.state === "deleting"
          ? "it is being deleted"
          : undefined,
    state: (share) => share.state,
    timeout: SHARE_TIMEOUT,
  });

const waitForShareGone = (
  scope: FileStorageScope,
  resourcePoolId: string,
  shareId: string,
  failed: (state: string | undefined) => boolean,
) =>
  waitUntilGone({
    resource: `STACKIT File Storage share ${shareId}`,
    read: getShareOrUndefined(scope, resourcePoolId, shareId),
    state: (share) => share.state,
    failed: (share) => (failed(share.state) ? share.state : undefined),
    timeout: SHARE_TIMEOUT,
  });

/**
 * The share with this name in a pool. A pool that is gone has none: checked first,
 * because no source says what `listShares` answers for a missing pool.
 */
const findShareByName = (scope: FileStorageScope, resourcePoolId: string, name: string) =>
  Effect.gen(function* () {
    const pool = yield* getPoolOrUndefined(scope, resourcePoolId);
    if (pool === undefined) return undefined;
    const shares = yield* listPoolShares(scope, resourcePoolId);
    return shares.find((share) => share.name === name);
  });

export const ShareProvider = () =>
  Provider.succeed(Share, {
    // `mountPath` is part of a server's `userData` through `MountShare`, which replaces
    // the server when it changes. The Terraform provider keeps it through updates too.
    stables: ["shareId", "resourcePoolId", "projectId", "region", "name", "mountPath"],
    // A share has to go before its pool and the policy it uses.
    nuke: {
      dependsOn: ["Stackit.FileStorage.ResourcePool", "Stackit.FileStorage.ShareExportPolicy"],
    },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const pools = yield* listAllPools(scope);
      const attrs: ShareAttributes[] = [];
      for (const pool of pools) {
        const shares = yield* listPoolShares(scope, pool.id);
        for (const share of shares) {
          if (isAlchemyOwned(share.labels)) attrs.push(toAttrs(scope, pool.id, share));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the one the share has, and a name can't exist
      // twice in a pool: the old share goes first. A generated name carries the
      // generation, so the new share can come up first.
      if (
        hasUnresolvedTrigger<ShareProps>(news, ["resourcePoolId", "name", "projectId", "region"])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ShareProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ShareProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const poolChanged = resolved.resourcePoolId !== output.resourcePoolId;
      const nameChanged = resolved.name !== undefined && resolved.name !== output.name;
      if (scopeChanged || poolChanged || nameChanged) {
        return {
          action: "replace",
          deleteFirst: resolved.name !== undefined && !scopeChanged && !poolChanged && !nameChanged,
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const resourcePoolId = output?.resourcePoolId ?? olds?.resourcePoolId;
      if (resourcePoolId === undefined) return undefined;
      if (output?.shareId !== undefined) {
        const byId = yield* getShareOrUndefined(scope, resourcePoolId, output.shareId);
        if (byId !== undefined && byId.state !== "deleting") {
          return toAttrs(scope, resourcePoolId, byId);
        }
      }
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* findShareByName(scope, resourcePoolId, name);
      if (found === undefined || found.state === "deleting") return undefined;
      const attrs = toAttrs(scope, resourcePoolId, found);
      // The generation being replaced, matched by id: a name only means something
      // within one pool.
      if (previous?.shareId === found.id) return attrs;
      // A generated name holds this generation's instance id.
      if (name === generated) return attrs;
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned =
        (yield* hasAlchemyLabels(id, found.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, found.labels));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const resourcePoolId = news.resourcePoolId;
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const isThisGeneration = (found: ObservedShare) =>
        Effect.gen(function* () {
          if (name === generated) return true;
          return (
            (yield* hasAlchemyLabels(id, found.labels)) &&
            hasInstanceLabel(instanceId, found.labels)
          );
        });

      // 1. Observe — `output` is a cache for the id, and only names the desired share
      // while it sits in the same pool, project and region. Without it, only this
      // generation's share can be claimed.
      let current: ObservedShare | undefined;
      if (
        output?.shareId !== undefined &&
        output.resourcePoolId === resourcePoolId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getShareOrUndefined(scope, resourcePoolId, output.shareId);
      }
      if (current === undefined) {
        const named = yield* findShareByName(scope, resourcePoolId, name);
        if (named !== undefined && (yield* isThisGeneration(named))) current = named;
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForShareGone(scope, resourcePoolId, current.id, (state) => state === "error");
        current = undefined;
      }

      // 2. Ensure
      if (current === undefined) {
        const created = yield* sfs
          .createShare({
            ...scope,
            resourcePoolId,
            name,
            spaceHardLimitGigabytes: news.spaceHardLimitGigabytes,
            labels,
            ...(news.exportPolicyName !== undefined
              ? { exportPolicyName: news.exportPolicyName }
              : {}),
          })
          .pipe(
            Effect.flatMap(requireShare),
            // Lost a race against our own create: observe it. Anything else holding
            // the name is not ours, and still fails.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found = yield* findShareByName(scope, resourcePoolId, name);
                return found !== undefined && (yield* isThisGeneration(found))
                  ? found
                  : yield* Effect.fail(error);
              }),
            ),
          );
        current = yield* waitForShare(scope, resourcePoolId, created.id);
      } else if (current.state !== "created") {
        current = yield* waitForShare(scope, resourcePoolId, current.id);
      }
      const liveId = current.id;

      // 3. Sync — one PATCH with every drifted aspect, diffed against the observed
      // share. Waiting for the new values too means a read from before the PATCH can't
      // pass. Label removals aren't awaited: whether a PATCH replaces or merges the map
      // is undocumented, and a merge must not stall the deploy.
      const delta = shareDelta(current, news, olds, labels);
      if (Object.keys(delta).length > 0) {
        yield* sfs.updateShare({ ...scope, resourcePoolId, shareId: liveId, ...delta });
        current = yield* waitForShare(scope, resourcePoolId, liveId, (observed) => {
          const { labels: _labels, ...rest } = shareDelta(observed, news, olds, labels);
          return Object.keys(rest).length === 0;
        });
      }

      // 4. Return
      return toAttrs(scope, resourcePoolId, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { resourcePoolId, shareId } = output;
      const current = yield* getShareOrUndefined(scope, resourcePoolId, shareId);
      if (current === undefined) return;
      if (current.state === "deleting") {
        return yield* waitForShareGone(scope, resourcePoolId, shareId, (s) => s === "error");
      }
      const alreadyFailed = current.state === "error";
      yield* sfs
        .deleteShare({ ...scope, resourcePoolId, shareId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // The SDK's delete handler fails on `error`. A share that was in it before the
      // delete can sit there until it's gone, so the budget decides.
      yield* waitForShareGone(
        scope,
        resourcePoolId,
        shareId,
        (state) => state === "error" && !alreadyFailed,
      );
    }),
  });
