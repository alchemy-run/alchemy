import * as cdn from "@distilled.cloud/azure/cdn";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AFD_DELETE_BUDGET,
  changedFields,
  createAfdName,
  profileOwnedByStack,
  ref,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface AfdSharedPrivateLink {
  /** ARM ID of the private-link target, e.g. a storage account or App Service. */
  privateLink: string;
  /** Location of the private-link target. */
  privateLinkLocation: string;
  /** Sub-resource (group ID) of the target, e.g. `blob` or `sites`. */
  groupId?: string;
  /** Message sent with the private endpoint connection request. */
  requestMessage?: string;
}

export interface AfdOriginProps {
  /** Resource group of the profile. Changing it replaces the origin. */
  resourceGroup: string;
  /** Front Door profile that holds the origin group. Changing it replaces the origin. */
  profile: string;
  /** Origin group the origin belongs to. Changing it replaces the origin. */
  originGroup: string;
  /**
   * Origin name: letters, digits, and hyphens, unique in the profile. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the origin.
   */
  name?: string;
  /** Address of the origin: a domain name, IPv4, or IPv6 address. */
  hostName: string;
  /**
   * Host header sent to the origin. Web Apps and Blob Storage need it to
   * match the origin host name.
   * @default `hostName`
   */
  originHostHeader?: string;
  /** HTTP port (1-65535). @default 80 */
  httpPort?: number;
  /** HTTPS port (1-65535). @default 443 */
  httpsPort?: number;
  /** Priority (1-5); lower priorities are preferred. @default 1 */
  priority?: number;
  /** Load-balancing weight (1-1000). @default 1000 */
  weight?: number;
  /** Whether the origin receives traffic. @default "Enabled" */
  enabledState?: "Enabled" | "Disabled";
  /** Validate the origin certificate's name. @default true */
  enforceCertificateNameCheck?: boolean;
  /** How the origin certificate name is validated. */
  certificateNameCheckValidationMode?:
    | "OriginHostname"
    | "CustomCertificateSubject"
    | "IncomingHostHeader";
  /** Allowed subjects (1-2) for `CustomCertificateSubject` validation. */
  customCertificateSubjects?: string[];
  /** ARM ID of the Azure resource behind the origin (informational). */
  azureOrigin?: string;
  /** Connect to the origin over Private Link (Premium only). */
  sharedPrivateLinkResource?: AfdSharedPrivateLink;
}

export interface AfdOrigin extends Resource<
  "Azure.Cdn.AfdOrigin",
  AfdOriginProps,
  {
    /** Name of the origin. */
    originName: string;
    /** ARM resource ID of the origin. */
    originId: string;
    /** Origin group that holds the origin. */
    originGroup: string;
    /** Front Door profile that holds the origin group. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Address of the origin. */
    hostName: string;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door origin — a backend (App Service, Storage static website,
 * public host, or IP) in an origin group.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/origin
 *
 * ### Creating an Origin
 * **Example:** Storage static website origin
 * ```typescript
 * const origin = yield* Azure.Cdn.AfdOrigin("site", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "mysite.z13.web.core.windows.net",
 * });
 * ```
 *
 * **Example:** Weighted secondary origin
 * ```typescript
 * const backup = yield* Azure.Cdn.AfdOrigin("backup", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "backup.example.com",
 *   priority: 2,
 *   weight: 500,
 * });
 * ```
 *
 * @resource
 */
export const AfdOrigin = Resource<AfdOrigin>("Azure.Cdn.AfdOrigin");

const createOriginName = (id: string) => createAfdName(id, 50);

const getOrigin = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  originGroupName: string,
  originName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetAFDOrigin({
      subscriptionId,
      resourceGroupName,
      profileName,
      originGroupName,
      originName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  originGroup: string,
  name: string,
  origin: cdn.GetAFDOriginResponse,
): AfdOrigin["Attributes"] => ({
  originName: name,
  originId: origin.id ?? "",
  originGroup,
  profile,
  resourceGroup,
  hostName: origin.properties?.hostName ?? "",
  deploymentStatus: origin.properties?.deploymentStatus,
});

const desiredProperties = (news: AfdOriginProps) => ({
  hostName: news.hostName,
  originHostHeader: news.originHostHeader ?? news.hostName,
  httpPort: news.httpPort ?? 80,
  httpsPort: news.httpsPort ?? 443,
  priority: news.priority ?? 1,
  weight: news.weight ?? 1000,
  enabledState: news.enabledState ?? "Enabled",
  enforceCertificateNameCheck: news.enforceCertificateNameCheck ?? true,
  certificateNameCheckValidationMode: news.certificateNameCheckValidationMode,
  customCertificateSubjects: news.customCertificateSubjects,
  azureOrigin: ref(news.azureOrigin),
  sharedPrivateLinkResource:
    news.sharedPrivateLinkResource === undefined
      ? undefined
      : {
          ...news.sharedPrivateLinkResource,
          privateLink: { id: news.sharedPrivateLinkResource.privateLink },
        },
});

export const AfdOriginProvider = () =>
  Provider.succeed(AfdOrigin, {
    stables: [
      "originName",
      "originId",
      "originGroup",
      "profile",
      "resourceGroup",
    ],

    // Origins are deleted with their origin group and profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        !sameName(news.originGroup, output.originGroup) ||
        (news.name !== undefined && !sameName(news.name, output.originName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      const originGroup = output?.originGroup ?? olds?.originGroup;
      if (
        resourceGroup === undefined ||
        profile === undefined ||
        originGroup === undefined
      ) {
        return undefined;
      }
      const name =
        output?.originName ?? olds?.name ?? (yield* createOriginName(id));
      const observed = yield* getOrigin(
        subscriptionId,
        resourceGroup,
        profile,
        originGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        profile,
        originGroup,
        name,
        observed,
      );
      return (yield* profileOwnedByStack(
        subscriptionId,
        resourceGroup,
        profile,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile, originGroup } = news;
      const name =
        news.name ?? output?.originName ?? (yield* createOriginName(id));
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        originGroupName: originGroup,
        originName: name,
      };
      const get = getOrigin(
        subscriptionId,
        resourceGroup,
        profile,
        originGroup,
        name,
      );
      const label = `Front Door origin ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn
          .CreateAFDOrigin({ ...where, properties })
          .pipe(Effect.retry(whileProfileBusy));
      }
      observed = yield* waitForAfd(
        label,
        get,
        (o) => o.properties?.provisioningState,
      );

      // Sync mutable settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateAFDOrigin({ ...where, properties: changed })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(
          label,
          get,
          (o) => o.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, profile, originGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteAFDOrigin({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            originGroupName: output.originGroup,
            originName: output.originName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door origin ${output.originName}`,
        getOrigin(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.originGroup,
          output.originName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
