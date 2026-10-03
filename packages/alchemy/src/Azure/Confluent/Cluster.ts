import * as confluent from "@distilled.cloud/azure/confluent";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  isOrganizationOwnedByStack,
  type OrganizationChildProps,
  sameName,
} from "./common.ts";

export type ClusterAvailability = "SINGLE_ZONE" | "MULTI_ZONE";

export type ClusterKind = "Basic" | "Standard" | "Enterprise" | "Dedicated";

export interface ClusterProps extends OrganizationChildProps {
  /** Environment ID that holds the cluster. Changing it replaces the cluster. */
  environment: string;
  /**
   * Cluster ID (the ARM resource name), 1-64 letters, digits, `-`, and `_`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Display name of the cluster in Confluent Cloud.
   * @default the cluster ID
   */
  displayName?: string;
  /**
   * Zone redundancy of the cluster. Changing it replaces the cluster.
   * @default "SINGLE_ZONE"
   */
  availability?: ClusterAvailability;
  /**
   * Cluster type. `Basic` and `Standard` are serverless; `Dedicated` bills
   * per CKU. Changing it replaces the cluster.
   * @default "Basic"
   */
  kind?: ClusterKind;
  /**
   * Azure region the cluster runs in, e.g. `eastus`. Changing it replaces
   * the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  region?: string;
  /** Availability zone of a single-zone cluster. Changing it replaces the cluster. */
  zone?: string;
  /**
   * Confluent network ID for a private-networking (Dedicated) cluster.
   * Changing it replaces the cluster.
   */
  networkId?: string;
  /**
   * Confluent BYOK key ID for a customer-managed-key (Dedicated) cluster.
   * Changing it replaces the cluster.
   */
  byokId?: string;
}

export interface Cluster extends Resource<
  "Azure.Confluent.Cluster",
  ClusterProps,
  {
    /** Cluster ID (ARM resource name). */
    clusterId: string;
    /** Environment ID that holds the cluster. */
    environment: string;
    /** Name of the Confluent organization. */
    organization: string;
    /** Resource group of the organization. */
    resourceGroup: string;
    /** ARM resource ID of the cluster. */
    clusterResourceId: string;
    /** Confluent resource name (CRN) of the cluster. */
    resourceName: string | undefined;
    /** Display name of the cluster. */
    displayName: string | undefined;
    /** Zone redundancy of the cluster. */
    availability: string | undefined;
    /** Cluster type, e.g. `Basic`. */
    kind: string | undefined;
    /** Azure region the cluster runs in. */
    region: string | undefined;
    /** Bootstrap endpoint Kafka clients connect to. */
    kafkaBootstrapEndpoint: string | undefined;
    /** HTTP (REST) endpoint of the cluster. */
    httpEndpoint: string | undefined;
    /** Kafka API endpoint of the cluster. */
    apiEndpoint: string | undefined;
    /** Lifecycle phase of the cluster, e.g. `PROVISIONED`. */
    phase: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Confluent Cloud Kafka cluster inside a Confluent environment of an
 * Azure-managed Confluent organization.
 *
 * Clusters carry no tags, so Alchemy ownership is inherited from the
 * organization's tags. Reconcile waits until the cluster reaches the
 * `PROVISIONED` phase.
 *
 * @see https://docs.confluent.io/cloud/current/clusters/cluster-types.html
 *
 * ### Creating a Cluster
 * **Example:** Basic single-zone cluster
 * ```typescript
 * const cluster = yield* Azure.Confluent.Cluster("events", {
 *   resourceGroup: org.resourceGroup,
 *   organization: org.organizationName,
 *   environment: environment.environmentId,
 *   kind: "Basic",
 *   region: "eastus",
 * });
 * ```
 *
 * **Example:** Multi-zone Standard cluster
 * ```typescript
 * const cluster = yield* Azure.Confluent.Cluster("events", {
 *   resourceGroup: org.resourceGroup,
 *   organization: org.organizationName,
 *   environment: environment.environmentId,
 *   kind: "Standard",
 *   availability: "MULTI_ZONE",
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.Confluent.Cluster");

type ObservedCluster = confluent.GetOrganizationClusterByIdResponse;

const createClusterName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  organizationName: string,
  environmentId: string,
  clusterId: string,
) =>
  orUndefinedIfNotFound(
    confluent.GetOrganizationClusterById({
      subscriptionId,
      resourceGroupName,
      organizationName,
      environmentId,
      clusterId,
    }),
  );

const toAttrs = (
  props: { resourceGroup: string; organization: string; environment: string },
  name: string,
  observed: ObservedCluster,
): Cluster["Attributes"] => {
  const spec = observed.properties?.spec;
  return {
    clusterId: name,
    environment: props.environment,
    organization: props.organization,
    resourceGroup: props.resourceGroup,
    clusterResourceId: observed.id ?? "",
    resourceName: observed.properties?.metadata?.resourceName,
    displayName: spec?.name,
    availability: spec?.availability,
    kind: spec?.config?.kind ?? observed.kind,
    region: spec?.region,
    kafkaBootstrapEndpoint: spec?.kafkaBootstrapEndpoint,
    httpEndpoint: spec?.httpEndpoint,
    apiEndpoint: spec?.apiEndpoint,
    phase: observed.properties?.status?.phase,
  };
};

/** Map the Confluent lifecycle phase onto ARM provisioning states. */
const phaseState = (cluster: ObservedCluster) => {
  const phase = cluster.properties?.status?.phase?.toUpperCase();
  if (phase === undefined || phase === "PROVISIONED") return "Succeeded";
  if (phase === "FAILED") return "Failed";
  return phase;
};

const waitForCluster = (
  subscriptionId: string,
  resourceGroup: string,
  organization: string,
  environment: string,
  name: string,
) =>
  waitForProvisioned(
    `Confluent cluster ${name}`,
    getCluster(subscriptionId, resourceGroup, organization, environment, name),
    phaseState,
    { interval: "10 seconds", times: 60 },
  );

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "clusterId",
      "environment",
      "organization",
      "resourceGroup",
      "clusterResourceId",
      "resourceName",
    ],

    // Clusters are deleted with their organization; ownership lives on the
    // organization, which `list` already covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const changed = (
        desired: string | undefined,
        observed: string | undefined,
      ) =>
        desired !== undefined &&
        observed !== undefined &&
        !sameName(desired, observed);
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.organization, output.organization) ||
        !sameName(news.environment, output.environment) ||
        changed(news.name, output.clusterId) ||
        changed(news.availability, output.availability) ||
        changed(news.kind, output.kind) ||
        changed(news.region, output.region)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const organization = output?.organization ?? olds?.organization;
      const environment = output?.environment ?? olds?.environment;
      if (
        resourceGroup === undefined ||
        organization === undefined ||
        environment === undefined
      ) {
        return undefined;
      }
      const name =
        output?.clusterId ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(
        subscriptionId,
        resourceGroup,
        organization,
        environment,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        { resourceGroup, organization, environment },
        name,
        observed,
      );
      return (yield* isOrganizationOwnedByStack(
        subscriptionId,
        resourceGroup,
        organization,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Confluent");
      const { resourceGroup, organization, environment } = news;
      const name =
        news.name ?? output?.clusterId ?? (yield* createClusterName(id));
      const displayName = news.displayName ?? name;

      // Observe.
      const observed = yield* getCluster(
        subscriptionId,
        resourceGroup,
        organization,
        environment,
        name,
      );

      // Ensure + sync: the PUT is an upsert; the display name is the only
      // mutable aspect of the spec.
      if (
        observed === undefined ||
        observed.properties?.spec?.name !== displayName
      ) {
        const spec = observed?.properties?.spec;
        yield* confluent.ClusterCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          organizationName: organization,
          environmentId: environment,
          clusterId: name,
          properties: {
            spec: {
              name: displayName,
              availability:
                spec?.availability ?? news.availability ?? "SINGLE_ZONE",
              cloud: spec?.cloud ?? "AZURE",
              region: spec?.region ?? news.region ?? env.location,
              zone: spec?.zone ?? news.zone,
              config: { kind: spec?.config?.kind ?? news.kind ?? "Basic" },
              environment: { id: environment },
              network:
                news.networkId === undefined
                  ? undefined
                  : { id: news.networkId },
              byok: news.byokId === undefined ? undefined : { id: news.byokId },
            },
          },
        });
      }

      const ready = yield* waitForCluster(
        subscriptionId,
        resourceGroup,
        organization,
        environment,
        name,
      );
      return toAttrs({ resourceGroup, organization, environment }, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        confluent.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          organizationName: output.organization,
          environmentId: output.environment,
          clusterId: output.clusterId,
        }),
      );
      yield* waitUntilGone(
        `Confluent cluster ${output.clusterId}`,
        getCluster(
          subscriptionId,
          output.resourceGroup,
          output.organization,
          output.environment,
          output.clusterId,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Confluent.Environment"] },
  });
