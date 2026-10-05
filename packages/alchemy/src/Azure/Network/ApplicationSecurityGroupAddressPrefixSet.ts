import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import * as Effect from "effect/Effect";

export interface ApplicationSecurityGroupAddressPrefixSetProps {
  /** Resource group of the application security group. Changing it replaces the address prefix set. */
  resourceGroup: string;
  /** Name of the parent application security group. Changing it replaces the address prefix set. */
  applicationSecurityGroup: string;
  /**
   * Name of the address prefix set. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the address prefix set.
   */
  name?: string;
  /** CIDRs added to the application security group, e.g. `["10.0.5.0/24"]`. */
  addressPrefixes: string[];
}

export interface ApplicationSecurityGroupAddressPrefixSet extends Resource<
  "Azure.Network.ApplicationSecurityGroupAddressPrefixSet",
  ApplicationSecurityGroupAddressPrefixSetProps,
  {
    /** Name of the address prefix set. */
    addressPrefixSetName: string;
    /** ARM resource ID of the address prefix set. */
    addressPrefixSetId: string;
    /** Name of the parent application security group. */
    applicationSecurityGroup: string;
    /** Resource group of the application security group. */
    resourceGroup: string;
    /** CIDRs in the set. */
    addressPrefixes: string[];
  },
  never,
  Providers
> {}

/**
 * An address prefix set on an Azure application security group — adds
 * CIDR ranges (not only NICs) to the group so NSG rules targeting the ASG
 * also match those addresses. This is a preview API. It carries no tags:
 * ownership follows the application security group.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/application-security-groups
 *
 * ### Adding Prefixes
 * **Example:** Add an on-premises range to an ASG
 * ```typescript
 * yield* Azure.Network.ApplicationSecurityGroupAddressPrefixSet("on-prem", {
 *   resourceGroup: group.resourceGroupName,
 *   applicationSecurityGroup: asg.applicationSecurityGroupName,
 *   addressPrefixes: ["192.168.0.0/24"],
 * });
 * ```
 *
 * @resource
 */
export const ApplicationSecurityGroupAddressPrefixSet =
  Resource<ApplicationSecurityGroupAddressPrefixSet>(
    "Azure.Network.ApplicationSecurityGroupAddressPrefixSet",
  );

export const ApplicationSecurityGroupAddressPrefixSetProvider = () =>
  Provider.succeed(
    ApplicationSecurityGroupAddressPrefixSet,
    networkProvider<ApplicationSecurityGroupAddressPrefixSet>()({
      label: "address prefix set",
      nameAttr: "addressPrefixSetName",
      parents: ["applicationSecurityGroup"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetAddressPrefixSet({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            applicationSecurityGroupName: path.applicationSecurityGroup!,
            addressPrefixSetName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.AddressPrefixSetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          applicationSecurityGroupName: path.applicationSecurityGroup!,
          addressPrefixSetName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteAddressPrefixSet({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          applicationSecurityGroupName: path.applicationSecurityGroup!,
          addressPrefixSetName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetApplicationSecurityGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            applicationSecurityGroupName: path.applicationSecurityGroup!,
          }),
        ).pipe(Effect.map((asg) => asg?.tags)),
      body: (news) => ({
        properties: { addressPrefixes: news.addressPrefixes },
      }),
      drifted: (observed, _body, news) =>
        !sameSet(observed.properties?.addressPrefixes, news.addressPrefixes),
      toAttrs: (path, observed) => ({
        addressPrefixSetName: path.name,
        addressPrefixSetId: observed.id ?? "",
        applicationSecurityGroup: path.applicationSecurityGroup!,
        resourceGroup: path.resourceGroup,
        addressPrefixes: [...(observed.properties?.addressPrefixes ?? [])],
      }),
      dependsOn: ["Azure.Network.ApplicationSecurityGroup"],
    }),
  );
