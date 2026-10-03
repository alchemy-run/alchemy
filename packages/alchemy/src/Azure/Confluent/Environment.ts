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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  isOrganizationOwnedByStack,
  type OrganizationChildProps,
  sameName,
} from "./common.ts";

export type StreamGovernancePackage = "ESSENTIALS" | "ADVANCED";

export interface EnvironmentProps extends OrganizationChildProps {
  /**
   * Environment ID (the ARM resource name), 1-64 letters, digits, `-`, and
   * `_`. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the environment.
   */
  name?: string;
  /**
   * Stream Governance package of the environment.
   * @default the Confluent Cloud default (`ESSENTIALS`)
   */
  streamGovernancePackage?: StreamGovernancePackage;
}

export interface Environment extends Resource<
  "Azure.Confluent.Environment",
  EnvironmentProps,
  {
    /** Environment ID (ARM resource name). */
    environmentId: string;
    /** Name of the Confluent organization. */
    organization: string;
    /** Resource group of the organization. */
    resourceGroup: string;
    /** ARM resource ID of the environment. */
    environmentResourceId: string;
    /** Confluent resource name (CRN) of the environment. */
    resourceName: string | undefined;
    /** Confluent Cloud API URL of the environment. */
    self: string | undefined;
    /** Stream Governance package of the environment. */
    streamGovernancePackage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Confluent Cloud environment inside an Azure-managed Confluent
 * organization. Environments group Kafka clusters and share a Stream
 * Governance (Schema Registry) package.
 *
 * Environments carry no tags, so Alchemy ownership is inherited from the
 * organization's tags.
 *
 * @see https://docs.confluent.io/cloud/current/access-management/hierarchy/cloud-environments.html
 *
 * ### Creating an Environment
 * **Example:** Environment with the Essentials governance package
 * ```typescript
 * const environment = yield* Azure.Confluent.Environment("dev", {
 *   resourceGroup: org.resourceGroup,
 *   organization: org.organizationName,
 *   streamGovernancePackage: "ESSENTIALS",
 * });
 * ```
 *
 * @resource
 */
export const Environment = Resource<Environment>("Azure.Confluent.Environment");

type ObservedEnvironment = confluent.GetOrganizationEnvironmentByIdResponse;

const createEnvironmentName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

const getEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  organizationName: string,
  environmentId: string,
) =>
  orUndefinedIfNotFound(
    confluent.GetOrganizationEnvironmentById({
      subscriptionId,
      resourceGroupName,
      organizationName,
      environmentId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  organization: string,
  name: string,
  observed: ObservedEnvironment,
): Environment["Attributes"] => ({
  environmentId: name,
  organization,
  resourceGroup,
  environmentResourceId: observed.id ?? "",
  resourceName: observed.properties?.metadata?.resourceName,
  self: observed.properties?.metadata?.self,
  streamGovernancePackage: observed.properties?.streamGovernanceConfig?.package,
});

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: ["environmentId", "organization", "resourceGroup"],

    // Environments are deleted with their organization; ownership lives on
    // the organization, which `list` already covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.organization, output.organization) ||
        (news.name !== undefined && !sameName(news.name, output.environmentId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const organization = output?.organization ?? olds?.organization;
      if (resourceGroup === undefined || organization === undefined) {
        return undefined;
      }
      const name =
        output?.environmentId ??
        olds?.name ??
        (yield* createEnvironmentName(id));
      const observed = yield* getEnvironment(
        subscriptionId,
        resourceGroup,
        organization,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, organization, name, observed);
      return (yield* isOrganizationOwnedByStack(
        subscriptionId,
        resourceGroup,
        organization,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Confluent");
      const { resourceGroup, organization } = news;
      const name =
        news.name ??
        output?.environmentId ??
        (yield* createEnvironmentName(id));

      // Observe.
      let observed = yield* getEnvironment(
        subscriptionId,
        resourceGroup,
        organization,
        name,
      );

      // Ensure + sync: the PUT is a synchronous upsert and the governance
      // package is the only mutable aspect.
      const packageDrifted =
        news.streamGovernancePackage !== undefined &&
        observed?.properties?.streamGovernanceConfig?.package !==
          news.streamGovernancePackage;
      if (observed === undefined || packageDrifted) {
        const written = yield* confluent.EnvironmentCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          organizationName: organization,
          environmentId: name,
          properties:
            news.streamGovernancePackage === undefined
              ? {}
              : {
                  streamGovernanceConfig: {
                    package: news.streamGovernancePackage,
                  },
                },
        });
        observed =
          (yield* getEnvironment(
            subscriptionId,
            resourceGroup,
            organization,
            name,
          )) ?? written;
      }

      return toAttrs(resourceGroup, organization, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        confluent.DeleteEnvironment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          organizationName: output.organization,
          environmentId: output.environmentId,
        }),
      );
      yield* waitUntilGone(
        `Confluent environment ${output.environmentId}`,
        getEnvironment(
          subscriptionId,
          output.resourceGroup,
          output.organization,
          output.environmentId,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Confluent.Organization"] },
  });
