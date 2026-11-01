import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { ensureObjectStorageEnabled } from "./internal.ts";

export interface CredentialsGroupProps {
  /**
   * Display name of the credentials group. If omitted, a unique name is
   * generated from the stack, stage and logical id. STACKIT has no rename
   * API, so changing it replaces the group.
   */
  displayName?: string;
  /**
   * Project to create the group in. Defaults to the profile's project.
   * Changing it replaces the group.
   */
  projectId?: string;
  /**
   * Region of the group. Defaults to the profile's region (`eu01`).
   * Changing it replaces the group.
   */
  region?: string;
}

export type CredentialsGroup = Resource<
  "Stackit.ObjectStorage.CredentialsGroup",
  CredentialsGroupProps,
  {
    /** Id of the credentials group; pass it to {@link AccessKey}. */
    credentialsGroupId: string;
    /** Display name of the credentials group. */
    displayName: string;
    /** Credentials group URN. */
    urn: string;
    /**
     * URN of the group's StorageGRID user. Use it as the principal in S3
     * bucket policies to grant this group's access keys access to a bucket.
     */
    userUrn: string;
    /** Project the group belongs to. */
    projectId: string;
    /** Region of the group. */
    region: string;
  },
  never,
  Providers
>;

/**
 * A STACKIT Object Storage credentials group: a named set of S3 access
 * keys that share one identity (the group's `userUrn`). Bucket policies
 * grant access to a group; {@link AccessKey}s are created inside it.
 *
 * Every project also has a `default` credentials group created by STACKIT;
 * Alchemy never manages or deletes it.
 *
 * Ownership: credentials groups have no labels. A group is Alchemy's when it
 * is in the stack's state or carries the generated display name (which
 * embeds the resource's instance id); an existing group with an explicit
 * `displayName` and no state is reported as unowned. `alchemy unsafe nuke`
 * lists only groups with generated names in the profile's project and region.
 *
 * ### Creating a Credentials Group
 * **Example:** Group with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const writers = yield* Stackit.ObjectStorage.CredentialsGroup("Writers", {});
 * ```
 *
 * **Example:** Group with an explicit display name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const writers = yield* Stackit.ObjectStorage.CredentialsGroup("Writers", {
 *   displayName: "assets-writers",
 * });
 * ```
 *
 * ### Issuing access keys
 * **Example:** Access key in a dedicated group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const writers = yield* Stackit.ObjectStorage.CredentialsGroup("Writers", {});
 * const key = yield* Stackit.ObjectStorage.AccessKey("WriterKey", {
 *   credentialsGroupId: writers.credentialsGroupId,
 * });
 * ```
 *
 * ### Replacement cautions <!-- api-prose -->
 * Changing `displayName`, `projectId` or `region` replaces the group, and
 * with it every access key created in it (their ids change). STACKIT only
 * deletes a group with no valid access keys left; Alchemy deletes the
 * group's `AccessKey` resources first.
 *
 * @resource
 * @product STACKIT Object Storage
 * @category Storage
 */
export const CredentialsGroup = Resource<CredentialsGroup>(
  "Stackit.ObjectStorage.CredentialsGroup",
);

/** The credentials group could not be found after creating it. */
export class CredentialsGroupNotResolved extends Data.TaggedError(
  "Stackit.ObjectStorage.CredentialsGroupNotResolved",
)<{ readonly displayName: string; readonly message: string }> {}

type Attributes = CredentialsGroup["Attributes"];

const groupPhysicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true });

const getGroup = (projectId: string, region: string, groupId: string) =>
  objectStorage.getCredentialsGroup({ projectId, region, groupId }).pipe(
    Effect.map((response) => response.credentialsGroup),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const listGroups = (projectId: string, region: string) =>
  objectStorage.listCredentialsGroups({ projectId, region }).pipe(
    Effect.map((response) => response.credentialsGroups),
    // The project was never enabled for Object Storage: no groups.
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const findByName = (projectId: string, region: string, displayName: string) =>
  listGroups(projectId, region).pipe(
    Effect.map((groups) => groups.find((group) => group.displayName === displayName)),
  );

const toAttrs = (
  projectId: string,
  region: string,
  group: objectStorage.CredentialsGroupExtended,
): Attributes => ({
  credentialsGroupId: group.credentialsGroupId,
  displayName: group.displayName,
  urn: group.urn,
  userUrn: group.userUrn,
  projectId,
  region,
});

/** Observe by cached id first, then by display name. */
const observe = Effect.fn(function* (input: {
  projectId: string;
  region: string;
  displayName: string;
  groupId: string | undefined;
}) {
  if (input.groupId !== undefined) {
    const byId = yield* getGroup(input.projectId, input.region, input.groupId);
    if (byId !== undefined) return byId;
  }
  const listed = yield* findByName(input.projectId, input.region, input.displayName);
  if (listed === undefined) return undefined;
  return yield* getGroup(input.projectId, input.region, listed.credentialsGroupId);
});

const describeGroup = (displayName: string, projectId: string, region: string) =>
  `STACKIT credentials group ${displayName} in project ${projectId} (${region})`;

export const CredentialsGroupProvider = () =>
  Provider.succeed(CredentialsGroup, {
    stables: ["credentialsGroupId", "displayName", "urn", "userUrn", "projectId", "region"],
    // A group can't be deleted while it still holds valid access keys;
    // `AccessKey` declares `nuke.dependsOn` on this type so nuke deletes
    // the keys first.

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const nameChanged =
        news.displayName !== undefined
          ? news.displayName !== output.displayName
          : olds?.displayName !== undefined;
      if (
        nameChanged ||
        (news.projectId ?? env.projectId) !== output.projectId ||
        (news.region ?? env.region) !== output.region
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      const explicitName = output?.displayName ?? olds?.displayName;
      const displayName = explicitName ?? (yield* groupPhysicalName(id));
      const group = yield* observe({
        projectId,
        region,
        displayName,
        groupId: output?.credentialsGroupId,
      });
      if (group === undefined) return undefined;
      const attrs = toAttrs(projectId, region, group);
      const owned =
        output !== undefined ||
        explicitName === undefined ||
        previous?.credentialsGroupId === group.credentialsGroupId;
      return owned ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const groups = yield* listGroups(env.projectId, env.region);
      const owned = yield* Effect.forEach(
        groups.filter((group) => isGeneratedPhysicalName(group.displayName)),
        (group) => getGroup(env.projectId, env.region, group.credentialsGroupId),
        { concurrency: 4 },
      );
      return owned.flatMap((group) =>
        group === undefined ? [] : [toAttrs(env.projectId, env.region, group)],
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      const displayName = news.displayName ?? output?.displayName ?? (yield* groupPhysicalName(id));
      const resource = describeGroup(displayName, projectId, region);

      yield* ensureObjectStorageEnabled({ projectId, region });

      // 1. Observe.
      const input = {
        projectId,
        region,
        displayName,
        groupId:
          output?.projectId === projectId && output.region === region
            ? output.credentialsGroupId
            : undefined,
      };
      let group = yield* observe(input);

      // 2. Ensure. A conflict is a concurrent create of the same name.
      if (group === undefined) {
        const created = yield* objectStorage
          .createCredentialsGroup({ projectId, region, displayName })
          .pipe(
            Effect.map((response) => response.credentialsGroup.credentialsGroupId),
            Effect.catchTag("Conflict", () => Effect.undefined),
          );
        group = yield* waitFor({
          resource,
          read: observe({ ...input, groupId: created }),
          ready: (observed) => observed !== undefined,
          state: (observed) => (observed === undefined ? "creating" : "ready"),
          timeout: "1 minute",
        });
      }
      if (group === undefined) {
        return yield* new CredentialsGroupNotResolved({
          displayName,
          message: `${resource} was not visible after creating it.`,
        });
      }

      // 3. Sync: nothing is mutable (no update API).
      return toAttrs(projectId, region, group);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, region, credentialsGroupId, displayName } = output;
      yield* objectStorage
        .deleteCredentialsGroup({ projectId, region, groupId: credentialsGroupId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: describeGroup(displayName, projectId, region),
        read: getGroup(projectId, region, credentialsGroupId),
        timeout: "1 minute",
      });
    }),
  });
