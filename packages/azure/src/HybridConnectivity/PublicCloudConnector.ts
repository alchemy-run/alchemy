import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";

/** The AWS account (or organization) a connector reads from. */
export interface PublicCloudConnectorAwsProfile {
  /**
   * 12-digit AWS account ID. For an organization, the management account.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   */
  accountId: string;
  /**
   * Whether `accountId` is an AWS Organizations management account whose
   * member accounts are all connected.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   * @default false
   */
  isOrganizationalAccount?: boolean;
  /**
   * Member account IDs to leave out of the connector. Azure accepts them
   * only when `isOrganizationalAccount` is `true`.
   * @default []
   */
  excludedAccounts?: string[];
}

/** A single Google Cloud project a connector reads from. */
export interface PublicCloudConnectorGcpProject {
  /** Numeric project number. */
  projectNumber: string;
  /** Project ID (e.g. `my-project`). */
  projectId: string;
}

/** A Google Cloud organization a connector reads from. */
export interface PublicCloudConnectorGcpOrganization {
  /** Numeric organization ID. */
  organizationId: string;
  /** Project number of the organization's management project. */
  managementProjectNumber: string;
  /** Project ID of the organization's management project. */
  managementProjectId: string;
  /**
   * Project numbers to leave out of the connector.
   * @default []
   */
  excludedProjectNumbers?: string[];
  /**
   * Folder IDs to leave out of the connector.
   * @default []
   */
  excludedFolderIds?: string[];
}

/** The Google Cloud project or organization a connector reads from. */
export interface PublicCloudConnectorGcpProfile {
  /**
   * Connect a single project.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   */
  projectProperties?: PublicCloudConnectorGcpProject;
  /**
   * Connect an organization. Only the excluded project and folder lists
   * update in place.
   *
   * :::caution
   * Changing the organization or management project replaces the connector.
   * :::
   */
  organizationProperties?: PublicCloudConnectorGcpOrganization;
}

export interface PublicCloudConnectorProps {
  /**
   * Resource group the connector is created in.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   */
  resourceGroup: string;
  /**
   * Connector name: 3-63 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   */
  name?: string;
  /**
   * Azure location of the connector.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Cloud the connector reads from. Set the matching `awsCloudProfile` or
   * `gcpCloudProfile`.
   *
   * :::caution
   * Changing it replaces the connector.
   * :::
   */
  hostType: "AWS" | "GCP";
  /** AWS account details. Required when `hostType` is `AWS`. */
  awsCloudProfile?: PublicCloudConnectorAwsProfile;
  /** Google Cloud project or organization. Required when `hostType` is `GCP`. */
  gcpCloudProfile?: PublicCloudConnectorGcpProfile;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PublicCloudConnector extends Resource<
  "Azure.HybridConnectivity.PublicCloudConnector",
  PublicCloudConnectorProps,
  {
    /** Name of the connector. */
    publicCloudConnectorName: string;
    /**
     * ARM resource ID of the connector. Pass it as `resourceUri` to
     * `Azure.HybridConnectivity.SolutionConfiguration`.
     */
    publicCloudConnectorId: string;
    /** Resource group that holds the connector. */
    resourceGroup: string;
    /** Location of the connector. */
    location: string;
    /** Cloud the connector reads from (`AWS` or `GCP`). */
    hostType: string;
    /** Identifier the other cloud's onboarding template trusts. */
    connectorPrimaryIdentifier: string | undefined;
    /** AWS account details, for an AWS connector. */
    awsCloudProfile: hybridconnectivity.AwsCloudProfile | undefined;
    /** Google Cloud project or organization, for a GCP connector. */
    gcpCloudProfile: hybridconnectivity.GcpCloudProfile | undefined;
    /** ARM provisioning state of the connector. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc multicloud connector (`Microsoft.HybridConnectivity/publicCloudConnectors`).
 * It links an AWS account or organization, or a Google Cloud project or
 * organization, to Azure so solutions such as inventory and Arc onboarding
 * can read its resources.
 *
 * Creating the connector needs no access to the other cloud. Its solution
 * configurations stay `AuthorizationFailed` until you deploy the onboarding
 * template Azure generates for the connector into that cloud.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/multicloud-connector/overview
 *
 * ### Connecting an AWS account
 * **Example:** Single AWS account
 * ```typescript
 * const connector = yield* Azure.HybridConnectivity.PublicCloudConnector("Aws", {
 *   hostType: "AWS",
 *   awsCloudProfile: { accountId: "123456789012" },
 * });
 * ```
 *
 * **Example:** AWS organization with excluded accounts
 * ```typescript
 * const connector = yield* Azure.HybridConnectivity.PublicCloudConnector("AwsOrg", {
 *   hostType: "AWS",
 *   awsCloudProfile: {
 *     accountId: "123456789012",
 *     isOrganizationalAccount: true,
 *     excludedAccounts: ["210987654321"],
 *   },
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Connecting Google Cloud
 * **Example:** Single GCP project
 * ```typescript
 * const connector = yield* Azure.HybridConnectivity.PublicCloudConnector("Gcp", {
 *   hostType: "GCP",
 *   gcpCloudProfile: {
 *     projectProperties: { projectNumber: "123456789012", projectId: "my-project" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const PublicCloudConnector = GroupedResource<PublicCloudConnector>(
  "Azure.HybridConnectivity.PublicCloudConnector",
);

type ObservedConnector =
  | hybridconnectivity.GetPublicCloudConnectorResponse
  | hybridconnectivity.PublicCloudConnector;

/** 3-63 letters, digits, and hyphens. */
const createConnectorName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  publicCloudConnector: string,
) =>
  orUndefinedIfNotFound(
    hybridconnectivity.GetPublicCloudConnector({
      subscriptionId,
      resourceGroupName,
      publicCloudConnector,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedConnector,
): PublicCloudConnector["Attributes"] => ({
  publicCloudConnectorName: name,
  publicCloudConnectorId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  hostType: observed.properties?.hostType ?? observed.kind ?? "",
  connectorPrimaryIdentifier: observed.properties?.connectorPrimaryIdentifier,
  awsCloudProfile: observed.properties?.awsCloudProfile,
  gcpCloudProfile: observed.properties?.gcpCloudProfile,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();
const sameLocation = (a: string | undefined, b: string | undefined) =>
  lower(a)?.replace(/\s/g, "") === lower(b)?.replace(/\s/g, "");
/** Order-insensitive comparison of string lists (`undefined` = empty). */
const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined) => {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((value) => right.has(value));
};

/** Whether the create-only cloud identity differs from the observed one. */
const identityChanged = (
  news: PublicCloudConnectorProps,
  output: PublicCloudConnector["Attributes"],
) => {
  if (lower(news.hostType) !== lower(output.hostType)) return true;
  const aws = news.awsCloudProfile;
  const observedAws = output.awsCloudProfile;
  if (
    aws !== undefined &&
    (aws.accountId !== observedAws?.accountId ||
      (aws.isOrganizationalAccount ?? false) !== (observedAws?.isOrganizationalAccount ?? false))
  ) {
    return true;
  }
  const project = news.gcpCloudProfile?.projectProperties;
  const observedProject = output.gcpCloudProfile?.projectProperties;
  if (
    project !== undefined &&
    (project.projectId !== observedProject?.projectId ||
      project.projectNumber !== observedProject?.projectNumber)
  ) {
    return true;
  }
  const org = news.gcpCloudProfile?.organizationProperties;
  const observedOrg = output.gcpCloudProfile?.organizationProperties;
  return (
    org !== undefined &&
    (org.organizationId !== observedOrg?.organizationId ||
      org.managementProjectId !== observedOrg?.managementProjectId ||
      org.managementProjectNumber !== observedOrg?.managementProjectNumber)
  );
};

export const PublicCloudConnectorProvider = () =>
  Provider.succeed(PublicCloudConnector, {
    stables: ["publicCloudConnectorName", "publicCloudConnectorId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridconnectivity
        .ListPublicCloudConnectorBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublicCloudConnectorBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((connector) => {
        const group = resourceGroupOf(connector.id);
        return hasAnyAlchemyTag(connector.tags) &&
          group !== undefined &&
          connector.name !== undefined
          ? [toAttrs(group, connector.name, connector)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.publicCloudConnectorName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      // A user-chosen name keeps the same ARM id, so the old connector must
      // go first; a generated name moves to a fresh one.
      if (identityChanged(news, output)) {
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const generated = yield* createConnectorName(id);
      const name = output?.publicCloudConnectorName ?? olds?.name ?? generated;
      const observed = yield* getConnector(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      const owned = yield* isOwned(id, observed.tags);
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridConnectivity");
      const resourceGroup = news.resourceGroup;
      const generated = yield* createConnectorName(id);
      const name = news.name ?? output?.publicCloudConnectorName ?? generated;
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publicCloudConnector: name,
      };
      const get = getConnector(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `public cloud connector ${name}`,
        get,
        (connector) => connector.properties?.provisioningState,
        { interval: "5 seconds", times: 36 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* hybridconnectivity.PublicCloudConnectorsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            hostType: news.hostType,
            awsCloudProfile: news.awsCloudProfile,
            gcpCloudProfile: news.gcpCloudProfile,
          },
        });
      }
      observed = yield* waitReady;

      // Sync the mutable aspects (exclusion lists, tags) against observed
      // state with one PATCH.
      const aws = news.awsCloudProfile;
      const org = news.gcpCloudProfile?.organizationProperties;
      const observedAws = observed.properties?.awsCloudProfile;
      const observedOrg = observed.properties?.gcpCloudProfile?.organizationProperties;
      const awsDrift =
        aws !== undefined && !sameSet(observedAws?.excludedAccounts, aws.excludedAccounts);
      const orgDrift =
        org !== undefined &&
        (!sameSet(observedOrg?.excludedProjectNumbers, org.excludedProjectNumbers) ||
          !sameSet(observedOrg?.excludedFolderIds, org.excludedFolderIds));
      if (awsDrift || orgDrift || tagsDiffer(observed.tags, tags)) {
        yield* hybridconnectivity.UpdatePublicCloudConnector({
          ...where,
          tags,
          properties: {
            awsCloudProfile: awsDrift
              ? { excludedAccounts: aws.excludedAccounts ?? [] }
              : undefined,
            gcpCloudProfile: orgDrift
              ? {
                  organizationProperties: {
                    excludedProjectNumbers: org.excludedProjectNumbers ?? [],
                    excludedFolderIds: org.excludedFolderIds ?? [],
                  },
                }
              : undefined,
          },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridconnectivity.DeletePublicCloudConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          publicCloudConnector: output.publicCloudConnectorName,
        }),
      );
      yield* waitUntilGone(
        `public cloud connector ${output.publicCloudConnectorName}`,
        getConnector(subscriptionId, output.resourceGroup, output.publicCloudConnectorName),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
