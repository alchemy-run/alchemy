import * as cdn from "@distilled.cloud/azure/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Identity type. `SystemAssigned` gives the profile its own identity;
   * its object ID is the `principalId` attribute.
   */
  type: "None" | "SystemAssigned" | "UserAssigned" | "SystemAssigned,UserAssigned";
  /**
   * ARM IDs of user-assigned identities (`UserAssignedIdentity.identityId`),
   * for the `UserAssigned` types.
   * @default []
   */
  userAssignedIdentities?: string[];
}

export interface ProfileLogScrubbingRule {
  /** Field to scrub: `RequestIPAddress`, `RequestUri`, or `QueryStringArgNames`. */
  matchVariable: "RequestIPAddress" | "RequestUri" | "QueryStringArgNames";
  /** Selector operator; only `EqualsAny` is supported. */
  selectorMatchOperator: "EqualsAny";
  /** Selector for collection variables (`QueryStringArgNames`). */
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
   * Front Door tier. `Premium_AzureFrontDoor` adds managed WAF rule sets,
   * bot protection, and Private Link origins. Changing it replaces the
   * profile.
   * @default "Standard_AzureFrontDoor"
   */
  sku?: FrontDoorSku;
  /**
   * Seconds Front Door waits for an origin response (16-240).
   * @default Azure's default (60)
   */
  originResponseTimeoutSeconds?: number;
  /**
   * Rules that scrub sensitive fields from the profile's logs.
   * @default no scrubbing
   */
  logScrubbing?: ProfileLogScrubbing;
  /**
   * Managed identity of the profile, e.g. to read Key Vault certificates
   * or authenticate to origins. If omitted, Alchemy leaves the profile's
   * identity as it is.
   * @default no identity
   */
  identity?: CdnManagedIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically. Origin groups, origins,
   * routes, and custom domains carry no tags; Alchemy treats them as owned
   * through these profile tags.
   * @default {}
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
 * An Azure Front Door Standard or Premium profile (`Microsoft.Cdn/profiles`):
 * Azure's global CDN and HTTP load balancer, the counterpart to a
 * CloudFront distribution. The profile holds endpoints, origin groups,
 * origins, routes, rule sets, custom domains, secrets, and security
 * policies.
 *
 * A profile is global (`location` is always `global`). Alchemy registers
 * the `Microsoft.Cdn` resource provider for you. Every write to a profile
 * or its children deploys to the edge, so each one takes minutes; Alchemy
 * waits up to 10 minutes for each and retries while another write on the
 * same profile is still deploying.
 *
 * :::caution[Changing `name`, `sku`, or `resourceGroup` replaces the profile]
 * Alchemy creates a new profile and deletes the old one with every
 * endpoint, route, and custom domain in it. The new endpoints get new
 * `*.azurefd.net` host names and the profile a new `frontDoorId`, custom
 * domains must validate again, and the profile delete takes 5-15 minutes
 * or more.
 * :::
 *
 * :::caution[Free Trial and Azure for Students subscriptions cannot create profiles]
 * Azure does not allow Front Door profiles on those subscriptions;
 * creating one fails with `FrontDoorFreeTrialForbidden`. Use a
 * pay-as-you-go or enterprise subscription.
 * :::
 *
 * @see https://learn.microsoft.com/azure/frontdoor/front-door-overview
 *
 * ### Creating a Profile
 * **Example:** Standard Front Door profile
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * ```
 *
 * **Example:** Profile with a fixed name and tags
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   name: "contoso-edge",
 *   tags: { team: "web" },
 * });
 * ```
 *
 * **Example:** Premium profile with a managed identity
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   sku: "Premium_AzureFrontDoor",
 *   identity: { type: "SystemAssigned" },
 *   originResponseTimeoutSeconds: 120,
 * });
 * ```
 *
 * ### Serving an App
 * A profile serves traffic through an endpoint. A route on the endpoint
 * sends requests to an origin group, and the group holds the origins.
 *
 * **Example:** Front Door in front of a Web App
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", { main: "./src/api.ts" });
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * const origins = yield* Azure.Cdn.AfdOriginGroup("api", {
 *   profile: profile.profileName,
 *   healthProbeSettings: { probePath: "/", probeProtocol: "Https", probeRequestType: "HEAD" },
 * });
 * yield* Azure.Cdn.AfdOrigin("api", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: api.defaultHostName,
 * });
 * yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   forwardingProtocol: "HttpsOnly",
 * });
 * // https://{endpoint.hostName}/
 * ```
 *
 * ### Static Sites
 * `Azure.Website.StaticSite` and `Azure.Website.Vite` create their own
 * Front Door setup. Pass `frontDoor: { profile }` to share one profile
 * across sites.
 *
 * **Example:** Two sites on one profile
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const web = yield* Azure.Website.Vite("Web", { frontDoor: { profile } });
 * const docs = yield* Azure.Website.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Managed Identity
 * Give the profile an identity to read your own TLS certificates from Key
 * Vault or to authenticate to origins. Grant the identity a role on the
 * resource it reads.
 *
 * **Example:** Read certificates from Key Vault
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("certs");
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("cdn-reads-certs", {
 *   scope: vault.vaultId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.KeyVaultSecretsUser,
 *   principalId: profile.principalId.as<string>(),
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * **Example:** User-assigned identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("cdn");
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   identity: { type: "UserAssigned", userAssignedIdentities: [identity.identityId] },
 * });
 * ```
 *
 * ### Locking Origins to Front Door
 * Front Door sends `frontDoorId` in the `X-Azure-FDID` header on every
 * request to an origin. Allow only the `AzureFrontDoor.Backend` service
 * tag with that header so clients cannot skip Front Door.
 *
 * **Example:** Web App that accepts only this profile's traffic
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   siteConfig: {
 *     ipSecurityRestrictions: [
 *       {
 *         name: "front-door",
 *         tag: "ServiceTag",
 *         ipAddress: "AzureFrontDoor.Backend",
 *         headers: { "x-azure-fdid": [profile.frontDoorId.as<string>()] },
 *         action: "Allow",
 *         priority: 100,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Origin Timeout
 * `originResponseTimeoutSeconds` (16-240) sets how long Front Door waits
 * for an origin to respond before it returns an error. It applies to
 * every route in the profile.
 *
 * **Example:** Allow slow reports to finish
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   originResponseTimeoutSeconds: 240,
 * });
 * ```
 *
 * ### Log Scrubbing
 * Remove client IPs, URIs, or query arguments from the profile's access
 * logs.
 *
 * **Example:** Scrub client IPs and a token query argument
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn", {
 *   logScrubbing: {
 *     state: "Enabled",
 *     scrubbingRules: [
 *       { matchVariable: "RequestIPAddress", selectorMatchOperator: "EqualsAny" },
 *       {
 *         matchVariable: "QueryStringArgNames",
 *         selectorMatchOperator: "EqualsAny",
 *         selector: "token",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Web Application Firewall
 * Create an `Azure.FrontDoor.WebApplicationFirewallPolicy` with the same
 * tier as the profile and attach it with `Azure.Cdn.SecurityPolicy`.
 *
 * **Example:** Protect an endpoint
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   policySettings: { mode: "Prevention" },
 * });
 * yield* Azure.Cdn.SecurityPolicy("waf", {
 *   profile: profile.profileName,
 *   wafPolicyId: waf.policyId,
 *   associations: [{ domainIds: [endpoint.endpointId] }],
 * });
 * ```
 *
 * ### Deleting a Profile
 * Deleting a profile deletes everything in it. Profile deletes take 5-15
 * minutes and sometimes more; Alchemy waits up to 30 minutes. If a delete
 * from an earlier run is still in progress, Alchemy waits for it instead
 * of sending a second one.
 *
 * **Example:** Remove the profile from the stack
 * ```diff
 * -const profile = yield* Azure.Cdn.Profile("cdn");
 * ```
 *
 * @resource
 */
export const Profile = GroupedResource<Profile>("Azure.Cdn.Profile");

type ObservedProfile = cdn.GetProfileResponse;

const createProfileName = (id: string) => createAfdName(id, 90);

const getProfile = (subscriptionId: string, resourceGroupName: string, profileName: string) =>
  orUndefinedIfNotFound(cdn.GetProfile({ subscriptionId, resourceGroupName, profileName }));

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
  originResponseTimeoutSeconds: profile.properties?.originResponseTimeoutSeconds,
  principalId: profile.identity?.principalId,
  tags: userTags(profile.tags),
});

const toIdentity = (identity: CdnManagedIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
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
  const want = (desired.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.join() !== have.join();
};

const lower = (value: string | undefined) => value?.toLowerCase();

export const ProfileProvider = () =>
  Provider.succeed(Profile, {
    stables: ["profileName", "profileId", "resourceGroup", "location", "frontDoorId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(cdn.ListProfiles, { subscriptionId });
      return (page.value ?? []).flatMap((profile) => {
        const group = resourceGroupOf(profile.id);
        return hasAnyAlchemyTag(profile.tags) && group !== undefined && profile.name !== undefined
          ? [toAttrs(group, profile.name, profile)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.profileName)) ||
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
      const name = output?.profileName ?? olds?.name ?? (yield* createProfileName(id));
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.profileName ?? (yield* createProfileName(id));
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
      observed = yield* waitForAfd(label, get, (p) => p.properties?.provisioningState);

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
        observed = yield* waitForAfd(label, get, (p) => p.properties?.provisioningState);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getProfile(subscriptionId, output.resourceGroup, output.profileName);
      if (observed === undefined) return;
      // A delete already in flight (e.g. from an interrupted run) rejects a
      // second DELETE with `ResourceConflict` for its whole duration; wait
      // for it instead.
      if (observed.properties?.resourceState !== "Deleting") {
        yield* ignoreNotFound(
          cdn
            .DeleteProfile({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              profileName: output.profileName,
            })
            .pipe(Effect.retry(whileProfileBusy)),
        );
      }
      yield* waitUntilGone(
        `Front Door profile ${output.profileName}`,
        getProfile(subscriptionId, output.resourceGroup, output.profileName),
        AFD_DELETE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
