import * as cdn from "@distilled.cloud/azure/cdn";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AFD_DELETE_BUDGET,
  changedFields,
  createAfdName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

/** Front Door Standard/Premium pricing tier. */
export type FrontDoorSku = "Standard_AzureFrontDoor" | "Premium_AzureFrontDoor";

export interface CdnManagedIdentity {
  /** Identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of user-assigned identities (for `UserAssigned` types). */
  userAssignedIdentities?: string[];
}

export interface ProfileLogScrubbingRule {
  /** Field to scrub: `RequestIPAddress`, `RequestUri`, or `QueryStringArgNames`. */
  matchVariable: "RequestIPAddress" | "RequestUri" | "QueryStringArgNames";
  /** Selector operator; only `EqualsAny` is supported. */
  selectorMatchOperator: "EqualsAny";
  /** Selector for collection variables. */
  selector?: string;
  /** Whether the rule is applied. @default "Enabled" */
  state?: "Enabled" | "Disabled";
}

export interface ProfileLogScrubbing {
  /** Whether log scrubbing is applied. @default "Enabled" */
  state?: "Enabled" | "Disabled";
  /** Scrubbing rules applied to the profile's logs. */
  scrubbingRules?: ProfileLogScrubbingRule[];
}

export interface ProfileProps {
  /**
   * Resource group the profile is created in; Microsoft.Cdn requires its
   * name to be at most 80 characters. Changing it replaces the profile.
   */
  resourceGroup: string;
  /**
   * Profile name: 1-260 letters, digits, and hyphens, unique in the
   * resource group. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the profile.
   */
  name?: string;
  /**
   * Front Door tier. Changing it replaces the profile.
   * @default "Standard_AzureFrontDoor"
   */
  sku?: FrontDoorSku;
  /**
   * Seconds Front Door waits for an origin response (16-240).
   * @default Azure's default (60)
   */
  originResponseTimeoutSeconds?: number;
  /** Rules that scrub sensitive fields from the profile's logs. */
  logScrubbing?: ProfileLogScrubbing;
  /**
   * Managed identity of the profile, e.g. to read Key Vault certificates
   * or authenticate to origins.
   */
  identity?: CdnManagedIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Profile extends Resource<
  "Azure.Cdn.Profile",
  ProfileProps,
  {
    /** Name of the profile. */
    profileName: string;
    /** ARM resource ID of the profile. */
    profileId: string;
    /** Resource group that holds the profile. */
    resourceGroup: string;
    /** Location of the profile (always `global`). */
    location: string;
    /** Front Door tier. */
    sku: string;
    /** Front Door ID, sent to origins in the `X-Azure-FDID` header. */
    frontDoorId: string | undefined;
    /** Origin response timeout in seconds. */
    originResponseTimeoutSeconds: number | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Front Door Standard or Premium profile — the container for
 * endpoints, origin groups, rule sets, custom domains, secrets, and
 * security policies.
 *
 * Azure does not allow Front Door profiles on Free Trial or Azure for
 * Students subscriptions; creating one there fails with
 * `FrontDoorFreeTrialForbidden`.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/front-door-overview
 *
 * ### Creating a Profile
 * **Example:** Standard Front Door profile
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Premium profile with a managed identity
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium_AzureFrontDoor",
 *   identity: { type: "SystemAssigned" },
 *   originResponseTimeoutSeconds: 120,
 * });
 * ```
 *
 * @resource
 */
export const Profile = Resource<Profile>("Azure.Cdn.Profile");

type ObservedProfile = cdn.GetProfileResponse;

const createProfileName = (id: string) => createAfdName(id, 90);

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetProfile({ subscriptionId, resourceGroupName, profileName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  profile: ObservedProfile,
): Profile["Attributes"] => ({
  profileName: name,
  profileId: profile.id ?? "",
  resourceGroup,
  location: profile.location,
  sku: profile.sku?.name ?? "",
  frontDoorId: profile.properties?.frontDoorId,
  originResponseTimeoutSeconds:
    profile.properties?.originResponseTimeoutSeconds,
  principalId: profile.identity?.principalId,
  tags: userTags(profile.tags),
});

const toIdentity = (identity: CdnManagedIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

const identityDiffers = (
  desired: CdnManagedIdentity | undefined,
  observed: ObservedProfile["identity"],
) => {
  if (desired === undefined) return false;
  if ((observed?.type ?? "None").toLowerCase() !== desired.type.toLowerCase()) {
    return true;
  }
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.join() !== have.join();
};

const lower = (value: string | undefined) => value?.toLowerCase();

export const ProfileProvider = () =>
  Provider.succeed(Profile, {
    stables: [
      "profileName",
      "profileId",
      "resourceGroup",
      "location",
      "frontDoorId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cdn
        .ListProfiles({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListProfiles", page)),
        );
      return (page.value ?? []).flatMap((profile) => {
        const group = resourceGroupOf(profile.id);
        return hasAnyAlchemyTag(profile.tags) &&
          group !== undefined &&
          profile.name !== undefined
          ? [toAttrs(group, profile.name, profile)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.profileName)) ||
        (news.sku ?? "Standard_AzureFrontDoor") !== output.sku
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.profileName ?? olds?.name ?? (yield* createProfileName(id));
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.profileName ?? (yield* createProfileName(id));
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentity(news.identity);
      const properties = {
        originResponseTimeoutSeconds: news.originResponseTimeoutSeconds,
        logScrubbing: news.logScrubbing,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: name,
      };
      const get = getProfile(subscriptionId, resourceGroup, name);
      const label = `Front Door profile ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn.CreateProfile({
          ...where,
          location: "global",
          sku: { name: news.sku ?? "Standard_AzureFrontDoor" },
          tags,
          identity,
          properties,
        });
      }
      observed = yield* waitForAfd(
        label,
        get,
        (p) => p.properties?.provisioningState,
      );

      // Sync tags, identity, and properties against observed state.
      const changed = changedFields(properties, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(news.identity, observed.identity);
      if (Object.keys(changed).length > 0 || tagsChanged || identityChanged) {
        yield* cdn
          .UpdateProfile({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? identity : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(
          label,
          get,
          (p) => p.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteProfile({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profileName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door profile ${output.profileName}`,
        getProfile(subscriptionId, output.resourceGroup, output.profileName),
        AFD_DELETE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
