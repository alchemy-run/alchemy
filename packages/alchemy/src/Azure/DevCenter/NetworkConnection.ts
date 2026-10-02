import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDevCenterName, sameArm } from "./Common.ts";

export type NetworkConnectionDomainJoinType =
  | "AzureADJoin"
  | "HybridAzureADJoin"
  | "None";

export interface NetworkConnectionProps {
  /** Resource group the network connection is created in. Changing it replaces the connection. */
  resourceGroup: string;
  /**
   * Network connection name. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * Azure location of the network connection; it must match the subnet's
   * virtual network. Changing it replaces the connection.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the subnet dev boxes join. Changing it replaces the
   * connection.
   */
  subnetId: string;
  /**
   * How dev boxes join a domain. `HybridAzureADJoin` also needs the
   * on-premises Active Directory settings below. Changing it replaces the
   * connection.
   * @default "AzureADJoin"
   */
  domainJoinType?: NetworkConnectionDomainJoinType;
  /**
   * Resource group Azure creates to hold the dev boxes' network
   * interfaces. Changing it replaces the connection.
   * @default `NI_{name}_{location}`
   */
  networkingResourceGroupName?: string;
  /** Active Directory domain name (hybrid join only), e.g. `corp.contoso.com`. */
  domainName?: string;
  /** Organizational unit dev box computer accounts are created in (hybrid join only). */
  organizationUnit?: string;
  /** User principal name of the account that joins dev boxes to the domain (hybrid join only). */
  domainUsername?: string;
  /**
   * Password of `domainUsername` (hybrid join only). Azure never returns
   * it, so it is re-sent whenever it changes from the previous deploy.
   */
  domainPassword?: Redacted.Redacted<string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkConnection extends Resource<
  "Azure.DevCenter.NetworkConnection",
  NetworkConnectionProps,
  {
    /** Name of the network connection. */
    networkConnectionName: string;
    /** ARM resource ID of the network connection; pass it to `AttachedNetwork`. */
    networkConnectionId: string;
    /** Resource group that holds the network connection. */
    resourceGroup: string;
    /** Location of the network connection. */
    location: string;
    /** ARM resource ID of the subnet. */
    subnetId: string;
    /** Domain join type. */
    domainJoinType: string;
    /** Resource group holding the dev boxes' network interfaces. */
    networkingResourceGroupName: string | undefined;
    /** Status of the latest health check (`Pending`, `Running`, `Passed`, `Failed`, `Warning`). */
    healthCheckStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Dev Box network connection — connects dev boxes to a subnet of your
 * own virtual network, either Microsoft Entra joined or hybrid joined to
 * an on-premises Active Directory. Attach it to a dev center with an
 * `AttachedNetwork` to use it from pools. Azure runs health checks after
 * every change; the connection itself is free.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-configure-network-connections
 *
 * ### Creating a Network Connection
 * **Example:** Microsoft Entra joined dev boxes in a subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("devboxes", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/24",
 * });
 * const connection = yield* Azure.DevCenter.NetworkConnection("connection", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * ### Hybrid Join
 * **Example:** Hybrid Microsoft Entra joined dev boxes
 * ```typescript
 * const connection = yield* Azure.DevCenter.NetworkConnection("connection", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   domainJoinType: "HybridAzureADJoin",
 *   domainName: "corp.contoso.com",
 *   domainUsername: "joiner@corp.contoso.com",
 *   domainPassword: yield* Config.redacted("DOMAIN_PASSWORD"),
 * });
 * ```
 *
 * @resource
 */
export const NetworkConnection = Resource<NetworkConnection>(
  "Azure.DevCenter.NetworkConnection",
);

type Observed = devcenter.GetNetworkConnectionResponse;

const getNetworkConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  networkConnectionName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetNetworkConnection({
      subscriptionId,
      resourceGroupName,
      networkConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkConnection["Attributes"] => ({
  networkConnectionName: name,
  networkConnectionId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  subnetId: observed.properties?.subnetId ?? "",
  domainJoinType: observed.properties?.domainJoinType ?? "",
  networkingResourceGroupName: observed.properties?.networkingResourceGroupName,
  healthCheckStatus: observed.properties?.healthCheckStatus,
  tags: userTags(observed.tags),
});

const secret = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

/** Deleting a connection still attached to a dev center fails with a conflict. */
const whileAttached = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const NetworkConnectionProvider = () =>
  Provider.succeed(NetworkConnection, {
    stables: [
      "networkConnectionName",
      "networkConnectionId",
      "resourceGroup",
      "location",
      "subnetId",
      "domainJoinType",
      "networkingResourceGroupName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* devcenter
        .ListNetworkConnectionBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkConnectionBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((connection) => {
        const group = resourceGroupOf(connection.id);
        return hasAnyAlchemyTag(connection.tags) &&
          group !== undefined &&
          connection.name !== undefined
          ? [toAttrs(group, connection.name, connection)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.networkConnectionName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.subnetId, output.subnetId) ||
        !sameArm(news.domainJoinType ?? "AzureADJoin", output.domainJoinType) ||
        (news.networkingResourceGroupName !== undefined &&
          !sameArm(
            news.networkingResourceGroupName,
            output.networkingResourceGroupName,
          ))
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
        output?.networkConnectionName ??
        olds?.name ??
        (yield* createDevCenterName(id));
      const observed = yield* getNetworkConnection(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.networkConnectionName ??
        (yield* createDevCenterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkConnectionName: name,
      };
      const label = `network connection ${name}`;
      const get = getNetworkConnection(subscriptionId, resourceGroup, name);
      const stateOf = (observed: Observed) =>
        observed.properties?.provisioningState;
      const password = secret(news.domainPassword);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* devcenter.NetworkConnectionsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            subnetId: news.subnetId,
            domainJoinType: news.domainJoinType ?? "AzureADJoin",
            networkingResourceGroupName: news.networkingResourceGroupName,
            domainName: news.domainName,
            organizationUnit: news.organizationUnit,
            domainUsername: news.domainUsername,
            domainPassword: password,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 72,
      });

      // Sync the hybrid-join settings and tags against observed state. The
      // password is write-only, so the previous props are the only hint.
      const props = observed.properties;
      const changed: devcenter.NetworkConnectionUpdateProperties = {};
      if (
        news.domainName !== undefined &&
        props?.domainName !== news.domainName
      ) {
        changed.domainName = news.domainName;
      }
      if (
        news.organizationUnit !== undefined &&
        props?.organizationUnit !== news.organizationUnit
      ) {
        changed.organizationUnit = news.organizationUnit;
      }
      if (
        news.domainUsername !== undefined &&
        props?.domainUsername !== news.domainUsername
      ) {
        changed.domainUsername = news.domainUsername;
      }
      if (
        password !== undefined &&
        olds !== undefined &&
        secret(olds.domainPassword) !== password
      ) {
        changed.domainPassword = password;
      }
      const propsChanged = Object.keys(changed).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* devcenter.UpdateNetworkConnection({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 72,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter
          .DeleteNetworkConnection({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            networkConnectionName: output.networkConnectionName,
          })
          .pipe(Effect.retry(whileAttached)),
      );
      // Deleting also removes the networking resource group (2-5 minutes).
      yield* waitUntilGone(
        `network connection ${output.networkConnectionName}`,
        getNetworkConnection(
          subscriptionId,
          output.resourceGroup,
          output.networkConnectionName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
