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

export type ApiCenterApiKind =
  | "rest"
  | "graphql"
  | "grpc"
  | "soap"
  | "webhook"
  | "websocket";

export type ApiCenterLifecycleStage =
  | "design"
  | "development"
  | "testing"
  | "preview"
  | "production"
  | "deprecated"
  | "retired";

export interface ApiCenterExternalDocumentation {
  /** Title of the documentation. */
  title?: string;
  /** Description of the documentation. */
  description?: string;
  /** URL of the documentation. */
  url: string;
}

export interface ApiCenterContact {
  /** Name of the contact. */
  name?: string;
  /** URL of the contact. */
  url?: string;
  /** Email address of the contact. */
  email?: string;
}

export interface ApiCenterLicense {
  /** Name of the license. */
  name?: string;
  /** URL of the license text. */
  url?: string;
  /** SPDX license identifier, e.g. `MIT`. */
  identifier?: string;
}

export interface ApiProps {
  /** Resource group of the API Center service. Changing it replaces the API. */
  resourceGroup: string;
  /** API Center service that holds the API. Changing it replaces the API. */
  serviceName: string;
  /**
   * API name: 3-90 letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the API.
   */
  name?: string;
  /**
   * Display title of the API.
   * @default the API name
   */
  title?: string;
  /** Kind of API. */
  kind: ApiCenterApiKind;
  /** Description of the API. */
  description?: string;
  /** Short summary of the API. */
  summary?: string;
  /** Development lifecycle stage of the API. */
  lifecycleStage?: ApiCenterLifecycleStage;
  /** URL of the API's terms of service. */
  termsOfServiceUrl?: string;
  /** External documentation links. */
  externalDocumentation?: ApiCenterExternalDocumentation[];
  /** Contacts for the API. */
  contacts?: ApiCenterContact[];
  /** License of the API. */
  license?: ApiCenterLicense;
  /**
   * Custom metadata values, keyed by {@link MetadataSchema} name. Values
   * are validated against the schemas assigned to `api`.
   */
  customProperties?: Record<string, unknown>;
}

export interface Api extends Resource<
  "Azure.ApiCenter.Api",
  ApiProps,
  {
    /** Name of the API. */
    apiName: string;
    /** API Center service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the API. */
    apiId: string;
    /** Display title of the API. */
    title: string;
    /** Kind of API. */
    kind: string;
    /** Lifecycle stage reported by API Center. */
    lifecycleStage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API registered in an Azure API Center inventory.
 *
 * Deleting an API also deletes its versions, definitions, and deployments.
 *
 * @see https://learn.microsoft.com/azure/api-center/register-apis
 *
 * ### Registering APIs
 * **Example:** REST API
 * ```typescript
 * const api = yield* Azure.ApiCenter.Api("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   title: "Orders API",
 *   kind: "rest",
 * });
 * ```
 *
 * **Example:** API with contacts and custom metadata
 * ```typescript
 * const api = yield* Azure.ApiCenter.Api("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   title: "Orders API",
 *   kind: "rest",
 *   lifecycleStage: "production",
 *   contacts: [{ name: "Platform", email: "platform@example.com" }],
 *   customProperties: { [schema.metadataSchemaName]: "payments" },
 * });
 * ```
 *
 * @resource
 */
export const Api = Resource<Api>("Azure.ApiCenter.Api");

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
}

const desiredProperties = (
  props: ApiProps,
  name: string,
): apicenter.ApiProperties => ({
  title: props.title ?? name,
  kind: props.kind,
  description: props.description,
  summary: props.summary,
  lifecycleStage: props.lifecycleStage,
  termsOfService:
    props.termsOfServiceUrl === undefined
      ? undefined
      : { url: props.termsOfServiceUrl },
  externalDocumentation: props.externalDocumentation,
  contacts: props.contacts,
  license: props.license,
  customProperties: props.customProperties,
});

export const ApiProvider = () =>
  Provider.succeed(Api, {
    stables: ["apiName", "serviceName", "resourceGroup", "apiId"],
    ...entityLifecycle<ApiProps, Api["Attributes"], Key, apicenter.GetApisResponse>(
      {
        label: (key) => `API Center API ${key.apiName}`,
        keyOf: (props, id, output) =>
          Effect.gen(function* () {
            return {
              resourceGroup: props.resourceGroup,
              serviceName: props.serviceName,
              apiName:
                props.name ?? output?.apiName ?? (yield* createApiCenterName(id)),
            };
          }),
        keyOfAttrs: (attrs) => attrs,
        get: (subscriptionId, key) =>
          apicenter.GetApis({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            workspaceName: DEFAULT_WORKSPACE,
            apiName: key.apiName,
          }),
        put: (subscriptionId, key, props) =>
          apicenter.ApisCreateOrUpdate({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            workspaceName: DEFAULT_WORKSPACE,
            apiName: key.apiName,
            properties: desiredProperties(props, key.apiName),
          }),
        remove: (subscriptionId, key) =>
          apicenter.DeleteApis({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            workspaceName: DEFAULT_WORKSPACE,
            apiName: key.apiName,
          }),
        inSync: (props, observed) =>
          subsetMatches(
            desiredProperties(props, observed.name ?? ""),
            observed.properties,
          ),
        toAttrs: (_subscriptionId, key, observed) => ({
          resourceGroup: key.resourceGroup,
          serviceName: key.serviceName,
          apiName: key.apiName,
          apiId: observed.id ?? "",
          title: observed.properties?.title ?? key.apiName,
          kind: observed.properties?.kind ?? "",
          lifecycleStage: observed.properties?.lifecycleStage,
        }),
      },
    ),
  });
