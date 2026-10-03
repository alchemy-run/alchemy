import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags, waitForProvisioned } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower, ref, sameId, sameSet, whileNetworkBusy } from "./common.ts";
import { idsOf, type NetworkPath, networkProvider } from "./generic.ts";

export interface CustomIpPrefixProps {
  /** Resource group of the prefix. Changing it replaces the prefix. */
  resourceGroup: string;
  /**
   * Name of the prefix: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the prefix.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the prefix.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones. Changing them replaces the prefix. */
  zones?: string[];
  /**
   * The public range you own, in CIDR notation (IPv4 /21-/24, IPv6 /48 or
   * a /64 child). Changing it replaces the prefix.
   */
  cidr: string;
  /**
   * Prefix type: `Singular` (regional IPv4), `Parent` (global IPv6 /48),
   * or `Child` (regional IPv6 /64 under a parent). Changing it replaces
   * the prefix.
   */
  prefixType?: "Singular" | "Parent" | "Child";
  /**
   * ARM ID of the parent prefix (for `Child` prefixes). Changing it
   * replaces the prefix.
   */
  parentId?: string;
  /**
   * Signed message proving ownership of the range (signature of the
   * authorization message by the range's registry certificate). Changing
   * it replaces the prefix.
   */
  signedMessage?: string;
  /**
   * Authorization message `subscriptionId|cidr|yyyymmdd`, matching the ROA
   * registered with the RIR. Changing it replaces the prefix.
   */
  authorizationMessage?: string;
  /** ASN advertising the range (bring-your-own ASN). Changing it replaces the prefix. */
  asn?: string;
  /** Geo of the advertisement, e.g. `"US"`. Changing it replaces the prefix. */
  geo?: string;
  /**
   * Whether Azure should advertise the range to the internet once
   * commissioned (`false` keeps it private). Changing it replaces the
   * prefix.
   * @default false
   */
  noInternetAdvertise?: boolean;
  /**
   * Whether the range is commissioned (advertised by Microsoft). Ranges
   * provision first (validation, hours); flipping this to `true` starts
   * commissioning, `false` decommissions.
   * @default false
   */
  commissioned?: boolean;
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CustomIpPrefix extends Resource<
  "Azure.Network.CustomIpPrefix",
  CustomIpPrefixProps,
  {
    /** Name of the prefix. */
    customIpPrefixName: string;
    /** ARM resource ID of the prefix. */
    customIpPrefixId: string;
    /** Resource group of the prefix. */
    resourceGroup: string;
    /** Location of the prefix. */
    location: string;
    /** Availability zones. */
    zones: string[];
    /** The range in CIDR notation. */
    cidr: string | undefined;
    /** Prefix type. */
    prefixType: string | undefined;
    /** ARM ID of the parent prefix. */
    parentId: string | undefined;
    /** ASN advertising the range. */
    asn: string | undefined;
    /** Geo of the advertisement. */
    geo: string | undefined;
    /**
     * Commissioned state (`Provisioning`, `Provisioned`, `Commissioning`,
     * `Commissioned`, `Decommissioning`, `Deprovisioning`, `Deprovisioned`,
     * `ValidationFailed`).
     */
    commissionedState: string | undefined;
    /** Why validation failed, when it did. */
    failedReason: string | undefined;
    /** IDs of the public IP prefixes carved from this range. */
    publicIpPrefixIds: string[];
    /** IDs of the child prefixes (IPv6 parents). */
    childCustomIpPrefixIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure custom IP prefix (BYOIP) — a public IP range you own, brought
 * to Azure so public IP prefixes and addresses can be allocated from it.
 * Azure validates ownership against the RIR (a ROA authorizing ASN 8075
 * plus a signed authorization message), which takes hours; the range is
 * then commissioned so Microsoft advertises it.
 *
 * Destroying the prefix decommissions and deprovisions the range first.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/ip-services/custom-ip-address-prefix
 *
 * ### Bringing a Range
 * **Example:** Provision an IPv4 /24
 * ```typescript
 * const prefix = yield* Azure.Network.CustomIpPrefix("byoip", {
 *   resourceGroup: group.resourceGroupName,
 *   cidr: "1.2.3.0/24",
 *   authorizationMessage: `${subscriptionId}|1.2.3.0/24|20301231`,
 *   signedMessage: "<base64 signature>",
 *   zones: ["1", "2", "3"],
 * });
 * ```
 *
 * **Example:** Commission once provisioned
 * ```typescript
 * const prefix = yield* Azure.Network.CustomIpPrefix("byoip", {
 *   resourceGroup: group.resourceGroupName,
 *   cidr: "1.2.3.0/24",
 *   authorizationMessage: `${subscriptionId}|1.2.3.0/24|20301231`,
 *   signedMessage: "<base64 signature>",
 *   commissioned: true,
 * });
 * ```
 *
 * @resource
 */
export const CustomIpPrefix = Resource<CustomIpPrefix>(
  "Azure.Network.CustomIpPrefix",
);

const COMMISSIONED = new Set([
  "commissioned",
  "commissionednointernetadvertise",
]);

const getPrefix = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetCustomIPPrefix({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      customIpPrefixName: path.name,
    }),
  );

/** Re-PUT the observed prefix with a new commissioned state. */
const setCommissionedState = (
  subscriptionId: string,
  path: NetworkPath,
  observed: network.GetCustomIPPrefixResponse,
  commissionedState: string,
) => {
  const p = observed.properties;
  return network
    .CustomIPPrefixesCreateOrUpdate({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      customIpPrefixName: path.name,
      location: observed.location,
      tags: observed.tags,
      zones: observed.zones,
      properties: {
        cidr: p?.cidr,
        asn: p?.asn,
        geo: p?.geo,
        prefixType: p?.prefixType,
        customIpPrefixParent: ref(p?.customIpPrefixParent?.id),
        signedMessage: p?.signedMessage,
        authorizationMessage: p?.authorizationMessage,
        noInternetAdvertise: p?.noInternetAdvertise,
        expressRouteAdvertise: p?.expressRouteAdvertise,
        commissionedState,
      },
    })
    .pipe(Effect.retry(whileNetworkBusy));
};

/** Wait until the commissioned state is one of `states` (≤ ~40 min). */
const waitCommissionedState = (
  subscriptionId: string,
  path: NetworkPath,
  states: ReadonlyArray<string>,
) =>
  waitForProvisioned(
    `custom IP prefix ${path.name}`,
    getPrefix(subscriptionId, path),
    (value) => {
      const state = value.properties?.commissionedState;
      return state !== undefined &&
        states.some((s) => s.toLowerCase() === state.toLowerCase())
        ? "Succeeded"
        : (state ?? "Pending");
    },
    { interval: "15 seconds", times: 160 },
  );

export const CustomIpPrefixProvider = () =>
  Provider.succeed(
    CustomIpPrefix,
    networkProvider<CustomIpPrefix>()({
      label: "custom IP prefix",
      nameAttr: "customIpPrefixName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        lower(news.cidr) !== lower(output.cidr) ||
        !sameSet(news.zones, output.zones) ||
        (news.parentId !== undefined &&
          !sameId(news.parentId, output.parentId)) ||
        (news.prefixType !== undefined &&
          lower(news.prefixType) !== lower(output.prefixType)) ||
        (news.asn !== undefined && news.asn !== output.asn) ||
        (news.geo !== undefined && lower(news.geo) !== lower(output.geo)),
      get: getPrefix,
      body: (news, { location, tags, observed }) => {
        const state = lower(observed?.properties?.commissionedState);
        const commissioned = state !== undefined && COMMISSIONED.has(state);
        // Only request a transition from a settled state.
        const commissionedState =
          news.commissioned === true && state === "provisioned"
            ? "Commissioning"
            : news.commissioned !== true && commissioned
              ? "Decommissioning"
              : undefined;
        return {
          location,
          tags,
          zones: news.zones,
          properties: {
            cidr: news.cidr,
            prefixType: news.prefixType,
            customIpPrefixParent: ref(news.parentId),
            signedMessage: news.signedMessage,
            authorizationMessage: news.authorizationMessage,
            asn: news.asn,
            geo: news.geo,
            noInternetAdvertise: news.noInternetAdvertise ?? false,
            commissionedState,
          },
        };
      },
      put: (subscriptionId, path, body) =>
        network.CustomIPPrefixesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          customIpPrefixName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteCustomIPPrefix({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          customIpPrefixName: path.name,
        }),
      // A provisioned range must be decommissioned and deprovisioned
      // before Azure deletes it.
      beforeDelete: (subscriptionId, path) =>
        Effect.gen(function* () {
          const current = yield* getPrefix(subscriptionId, path);
          if (current?.properties?.commissionedState === undefined) return;
          // Let an in-flight transition (e.g. validation) settle first.
          let observed = yield* waitCommissionedState(subscriptionId, path, [
            "Provisioned",
            "Commissioned",
            "CommissionedNoInternetAdvertise",
            "Deprovisioned",
            "ValidationFailed",
          ]);
          if (
            COMMISSIONED.has(lower(observed.properties?.commissionedState)!)
          ) {
            yield* setCommissionedState(
              subscriptionId,
              path,
              observed,
              "Decommissioning",
            );
            observed = yield* waitCommissionedState(subscriptionId, path, [
              "Provisioned",
            ]);
          }
          if (lower(observed.properties?.commissionedState) === "provisioned") {
            yield* setCommissionedState(
              subscriptionId,
              path,
              observed,
              "Deprovisioning",
            );
            yield* waitCommissionedState(subscriptionId, path, [
              "Deprovisioned",
            ]);
          }
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateCustomIPPrefixTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          customIpPrefixName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListCustomIPPrefixAll({ subscriptionId }),
      drifted: (_observed, body) =>
        body.properties.commissionedState !== undefined,
      toAttrs: (path, observed) => ({
        customIpPrefixName: path.name,
        customIpPrefixId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        zones: [...(observed.zones ?? [])],
        cidr: observed.properties?.cidr,
        prefixType: observed.properties?.prefixType,
        parentId: observed.properties?.customIpPrefixParent?.id,
        asn: observed.properties?.asn,
        geo: observed.properties?.geo,
        commissionedState: observed.properties?.commissionedState,
        failedReason: observed.properties?.failedReason,
        publicIpPrefixIds: idsOf(observed.properties?.publicIpPrefixes),
        childCustomIpPrefixIds: idsOf(
          observed.properties?.childCustomIpPrefixes,
        ),
        tags: userTags(observed.tags),
      }),
    }),
  );
