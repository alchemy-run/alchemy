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

export interface DeploymentProps {
  /** Resource group of the API Center service. Changing it replaces the deployment. */
  resourceGroup: string;
  /** API Center service that holds the API. Changing it replaces the deployment. */
  serviceName: string;
  /** API that is deployed. Changing it replaces the deployment. */
  apiName: string;
  /**
   * Deployment name: 3-90 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the deployment.
   */
  name?: string;
  /**
   * Display title of the deployment.
   * @default the deployment name
   */
  title?: string;
  /** Description of the deployment. */
  description?: string;
  /**
   * Service-scoped ID of the target environment,
   * `/workspaces/default/environments/{name}` — use
   * {@link Environment}'s `scopedId`.
   */
  environmentId: string;
  /**
   * Service-scoped ID of the deployed definition,
   * `/workspaces/default/apis/{api}/versions/{version}/definitions/{name}`
   * — use {@link ApiDefinition}'s `scopedId`.
   */
  definitionId: string;
  /**
   * Whether the deployment is live. API Center 2024-03-01 accepts the value
   * but does not report it back, so changing only `state` is not detected
   * as drift.
   * @default "active"
   */
  state?: "active" | "inactive";
  /** Base runtime URLs where the API is served. */
  runtimeUri?: string[];
  /**
   * Custom metadata values, keyed by {@link MetadataSchema} name. Values
   * are validated against the schemas assigned to `deployment`.
   */
  customProperties?: Record<string, unknown>;
}

export interface Deployment extends Resource<
  "Azure.ApiCenter.Deployment",
  DeploymentProps,
  {
    /** Name of the deployment. */
    deploymentName: string;
    /** API that is deployed. */
    apiName: string;
    /** API Center service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the deployment. */
    deploymentId: string;
    /** Display title of the deployment. */
    title: string;
    /** State of the deployment, when reported by API Center. */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A deployment recording where (which {@link Environment}) and as what
 * ({@link ApiDefinition}) an API from an Azure API Center inventory runs.
 *
 * @see https://learn.microsoft.com/azure/api-center/configure-environments-deployments
 *
 * ### Recording Deployments
 * **Example:** API deployed to production
 * ```typescript
 * const deployment = yield* Azure.ApiCenter.Deployment("orders-prod", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   apiName: api.apiName,
 *   title: "Orders (production)",
 *   environmentId: prod.scopedId,
 *   definitionId: definition.scopedId,
 *   runtimeUri: ["https://api.example.com/orders"],
 * });
 * ```
 *
 * @resource
 */
export const Deployment = Resource<Deployment>("Azure.ApiCenter.Deployment");

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  deploymentName: string;
}

const desiredProperties = (
  props: DeploymentProps,
  name: string,
): apicenter.DeploymentProperties => ({
  title: props.title ?? name,
  description: props.description,
  environmentId: props.environmentId,
  definitionId: props.definitionId,
  state: props.state ?? "active",
  server:
    props.runtimeUri === undefined ? undefined : { runtimeUri: props.runtimeUri },
  customProperties: props.customProperties,
});

/** Compare scoped IDs case-insensitively (ARM echoes them in its own casing). */
const normalize = (
  properties: apicenter.DeploymentProperties | undefined,
): apicenter.DeploymentProperties | undefined =>
  properties === undefined
    ? undefined
    : {
        ...properties,
        environmentId: properties.environmentId?.toLowerCase(),
        definitionId: properties.definitionId?.toLowerCase(),
      };

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: [
      "deploymentName",
      "apiName",
      "serviceName",
      "resourceGroup",
      "deploymentId",
    ],
    ...entityLifecycle<
      DeploymentProps,
      Deployment["Attributes"],
      Key,
      apicenter.GetDeploymentResponse
    >({
      label: (key) => `API Center deployment ${key.apiName}/${key.deploymentName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            apiName: props.apiName,
            deploymentName:
              props.name ??
              output?.deploymentName ??
              (yield* createApiCenterName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apicenter.GetDeployment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          apiName: key.apiName,
          deploymentName: key.deploymentName,
        }),
      put: (subscriptionId, key, props) =>
        apicenter.DeploymentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          apiName: key.apiName,
          deploymentName: key.deploymentName,
          properties: desiredProperties(props, key.deploymentName),
        }),
      remove: (subscriptionId, key) =>
        apicenter.DeleteDeployment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          apiName: key.apiName,
          deploymentName: key.deploymentName,
        }),
      // API Center 2024-03-01 accepts `state` but does not echo it on GET,
      // so it is only compared when the service reports it.
      inSync: (props, observed) => {
        const desired = normalize(desiredProperties(props, observed.name ?? ""));
        return subsetMatches(
          observed.properties?.state === undefined
            ? { ...desired, state: undefined }
            : desired,
          normalize(observed.properties),
        );
      },
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        deploymentName: key.deploymentName,
        deploymentId: observed.id ?? "",
        title: observed.properties?.title ?? key.deploymentName,
        state: observed.properties?.state,
      }),
    }),
  });
