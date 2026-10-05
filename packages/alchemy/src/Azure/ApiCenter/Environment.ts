import * as apicenter from "@distilled.cloud/azure/apicenter";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createApiCenterName,
  DEFAULT_WORKSPACE,
  entityLifecycle,
  subsetMatches,
} from "./Common.ts";

export type ApiCenterEnvironmentKind =
  | "development"
  | "testing"
  | "staging"
  | "production";

export type ApiCenterEnvironmentServerType =
  | "Azure API Management"
  | "Azure compute service"
  | "Apigee API Management"
  | "AWS API Gateway"
  | "Kong API Gateway"
  | "Kubernetes"
  | "MuleSoft API Management";

export interface ApiCenterEnvironmentServer {
  /** Kind of server (gateway or platform) behind the environment. */
  type?: ApiCenterEnvironmentServerType;
  /** URLs of the server's management portal. */
  managementPortalUri?: string[];
}

export interface ApiCenterEnvironmentOnboarding {
  /** Instructions for onboarding to the environment. */
  instructions?: string;
  /** URLs of the environment's developer portal. */
  developerPortalUri?: string[];
}

export interface EnvironmentProps {
  /** Resource group of the API Center service. Changing it replaces the environment. */
  resourceGroup: string;
  /** API Center service that holds the environment. Changing it replaces the environment. */
  serviceName: string;
  /**
   * Environment name: 3-90 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the environment.
   */
  name?: string;
  /**
   * Display title of the environment.
   * @default the environment name
   */
  title?: string;
  /** Kind of environment. */
  kind: ApiCenterEnvironmentKind;
  /** Description of the environment. */
  description?: string;
  /** Server (gateway/platform) that hosts the environment. */
  server?: ApiCenterEnvironmentServer;
  /** Onboarding information for API consumers. */
  onboarding?: ApiCenterEnvironmentOnboarding;
  /**
   * Custom metadata values, keyed by {@link MetadataSchema} name. Values
   * are validated against the schemas assigned to `environment`.
   */
  customProperties?: Record<string, unknown>;
}

export interface Environment extends Resource<
  "Azure.ApiCenter.Environment",
  EnvironmentProps,
  {
    /** Name of the environment. */
    environmentName: string;
    /** API Center service that holds the environment. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the environment. */
    environmentId: string;
    /**
     * Service-scoped ID, `/workspaces/default/environments/{name}`, used as
     * a {@link Deployment}'s `environmentId`.
     */
    scopedId: string;
    /** Display title of the environment. */
    title: string;
    /** Kind of environment. */
    kind: string;
  },
  never,
  Providers
> {}

/**
 * An environment (gateway, platform, or stage) where APIs from an Azure
 * API Center inventory are deployed.
 *
 * @see https://learn.microsoft.com/azure/api-center/configure-environments-deployments
 *
 * ### Creating Environments
 * **Example:** Production environment on API Management
 * ```typescript
 * const prod = yield* Azure.ApiCenter.Environment("prod", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   title: "Production",
 *   kind: "production",
 *   server: {
 *     type: "Azure API Management",
 *     managementPortalUri: ["https://portal.azure.com"],
 *   },
 *   onboarding: {
 *     instructions: "Request a subscription key in the developer portal.",
 *     developerPortalUri: ["https://developer.example.com"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Environment = Resource<Environment>("Azure.ApiCenter.Environment");

interface Key {
  resourceGroup: string;
  serviceName: string;
  environmentName: string;
}

const desiredProperties = (
  props: EnvironmentProps,
  name: string,
): apicenter.EnvironmentProperties => ({
  title: props.title ?? name,
  kind: props.kind,
  description: props.description,
  server: props.server,
  onboarding: props.onboarding,
  customProperties: props.customProperties,
});

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: [
      "environmentName",
      "serviceName",
      "resourceGroup",
      "environmentId",
      "scopedId",
    ],
    ...entityLifecycle<
      EnvironmentProps,
      Environment["Attributes"],
      Key,
      apicenter.GetEnvironmentResponse
    >({
      label: (key) => `API Center environment ${key.environmentName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            environmentName:
              props.name ??
              output?.environmentName ??
              (yield* createApiCenterName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apicenter.GetEnvironment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          environmentName: key.environmentName,
        }),
      put: (subscriptionId, key, props) =>
        apicenter.EnvironmentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          environmentName: key.environmentName,
          properties: desiredProperties(props, key.environmentName),
        }),
      remove: (subscriptionId, key) =>
        apicenter.DeleteEnvironment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          environmentName: key.environmentName,
        }),
      inSync: (props, observed) =>
        subsetMatches(
          desiredProperties(props, observed.name ?? ""),
          observed.properties,
        ),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        environmentName: key.environmentName,
        environmentId: observed.id ?? "",
        scopedId: `/workspaces/${DEFAULT_WORKSPACE}/environments/${key.environmentName}`,
        title: observed.properties?.title ?? key.environmentName,
        kind: observed.properties?.kind ?? "",
      }),
    }),
  });
