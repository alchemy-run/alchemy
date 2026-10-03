import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { DEVTESTLAB_NAMESPACE, diverges, labLocation } from "./Common.ts";

export interface UserProps {
  /** Resource group of the lab. Changing it replaces the user. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the user. */
  lab: string;
  /**
   * Microsoft Entra object ID of the principal. It is also the lab user's
   * name. Changing it replaces the user.
   */
  objectId: string;
  /** Tenant of the principal. Changing it replaces the user. */
  tenantId?: string;
  /** User principal name, e.g. `alice@contoso.com`. Changing it replaces the user. */
  principalName?: string;
  /** Application ID, for service principals. Changing it replaces the user. */
  appId?: string;
  /**
   * Key Vault holding the user's secrets.
   * @default the lab's Key Vault
   */
  secretStore?: {
    /** URI of the Key Vault. */
    keyVaultUri?: string;
    /** ARM ID of the Key Vault. */
    keyVaultId?: string;
  };
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface User extends Resource<
  "Azure.DevTestLabs.User",
  UserProps,
  {
    /** Name of the lab user (the principal's object ID). */
    userName: string;
    /** ARM resource ID of the lab user. */
    userId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Key Vault URI of the user's secret store. */
    keyVaultUri: string | undefined;
    /** Key Vault ARM ID of the user's secret store. */
    keyVaultId: string | undefined;
    /** Creation time of the lab user. */
    createdDate: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs user profile — holds a principal's secrets, disks,
 * environments, and Service Fabric clusters in a lab. Azure creates one
 * when a principal first uses the lab; declare it to manage those
 * children as code. Deleting it deletes the user's lab resources.
 *
 * The principal must be resolvable by DevTest Labs: users and
 * application service principals of the tenant work, while managed
 * identities are rejected with "User was not found in the tenant."
 *
 * @see https://learn.microsoft.com/rest/api/dtl/users
 *
 * ### Registering a User
 * **Example:** Lab profile for a user
 * ```typescript
 * const user = yield* Azure.DevTestLabs.User("alice", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   objectId: "00000000-0000-0000-0000-000000000000", // Entra object ID
 *   principalName: "alice@contoso.com",
 * });
 * ```
 *
 * @resource
 */
export const User = Resource<User>("Azure.DevTestLabs.User");

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

const getUser = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetUser({ subscriptionId, resourceGroupName, labName, name }),
  ).pipe(
    // For the calling principal the lab always answers with a synthesized
    // profile (zero GUID, no provisioning state) — even after a delete.
    Effect.map((u) =>
      u === undefined ||
      (u.properties?.uniqueIdentifier === ZERO_GUID &&
        u.properties?.provisioningState === undefined)
        ? undefined
        : u,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  u: devtestlabs.GetUserResponse,
): User["Attributes"] => ({
  userName: name,
  userId: u.id ?? "",
  resourceGroup,
  lab,
  keyVaultUri: u.properties?.secretStore?.keyVaultUri,
  keyVaultId: u.properties?.secretStore?.keyVaultId,
  createdDate: u.properties?.createdDate,
  uniqueIdentifier: u.properties?.uniqueIdentifier,
  tags: userTags(u.tags),
});

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userName", "userId", "resourceGroup", "lab"],

    // Lab users are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.objectId.toLowerCase() !== output.userName.toLowerCase() ||
        news.tenantId !== olds?.tenantId ||
        news.principalName !== olds?.principalName ||
        news.appId !== olds?.appId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      const name = output?.userName ?? olds?.objectId;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getUser(subscriptionId, resourceGroup, lab, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name = news.objectId;
      const tags = yield* desiredTags(id, news.tags);
      const properties: devtestlabs.UserPropertiesInput = {
        identity: {
          objectId: news.objectId,
          tenantId: news.tenantId,
          principalName: news.principalName,
          appId: news.appId,
        },
        secretStore: news.secretStore,
      };
      const get = getUser(subscriptionId, resourceGroup, lab, name);
      const wait = waitForProvisioned(
        `lab user ${name}`,
        get,
        (u) => u.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync: the PUT is a long-running full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.UsersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties: {
            ...properties,
            // Keep the RP-assigned secret store unless one is given.
            secretStore: news.secretStore ?? observed?.properties?.secretStore,
          },
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteUser({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.userName,
        }),
      );
      yield* waitUntilGone(
        `lab user ${output.userName}`,
        getUser(subscriptionId, output.resourceGroup, output.lab, output.userName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
