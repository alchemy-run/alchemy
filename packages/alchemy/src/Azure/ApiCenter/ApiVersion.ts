import * as apicenter from "@distilled.cloud/azure/apicenter";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { ApiCenterLifecycleStage } from "./Api.ts";
import {
  createApiCenterName,
  DEFAULT_WORKSPACE,
  entityLifecycle,
  subsetMatches,
} from "./Common.ts";

export interface ApiVersionProps {
  /** Resource group of the API Center service. Changing it replaces the version. */
  resourceGroup: string;
  /** API Center service that holds the API. Changing it replaces the version. */
  serviceName: string;
  /** API that the version belongs to. Changing it replaces the version. */
  apiName: string;
  /**
   * Version name: 3-90 letters, digits, and hyphens (e.g. `v1`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the version.
   */
  name?: string;
  /**
   * Display title of the version, e.g. `1.0.0`.
   * @default the version name
   */
  title?: string;
  /** Development lifecycle stage of the version. */
  lifecycleStage: ApiCenterLifecycleStage;
}

export interface ApiVersion extends Resource<
  "Azure.ApiCenter.ApiVersion",
  ApiVersionProps,
  {
    /** Name of the version. */
    versionName: string;
    /** API that the version belongs to. */
    apiName: string;
    /** API Center service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    versionId: string;
    /** Display title of the version. */
    title: string;
    /** Lifecycle stage of the version. */
    lifecycleStage: string;
  },
  never,
  Providers
> {}

/**
 * A version of an API registered in Azure API Center.
 *
 * @see https://learn.microsoft.com/azure/api-center/key-concepts#api-version
 *
 * ### Versioning APIs
 * **Example:** Production version
 * ```typescript
 * const v1 = yield* Azure.ApiCenter.ApiVersion("orders-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   apiName: api.apiName,
 *   name: "v1",
 *   title: "1.0.0",
 *   lifecycleStage: "production",
 * });
 * ```
 *
 * @resource
 */
export const ApiVersion = Resource<ApiVersion>("Azure.ApiCenter.ApiVersion");

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  versionName: string;
}

const desiredProperties = (
  props: ApiVersionProps,
  name: string,
): apicenter.ApiVersionProperties => ({
  title: props.title ?? name,
  lifecycleStage: props.lifecycleStage,
});

export const ApiVersionProvider = () =>
  Provider.succeed(ApiVersion, {
    stables: [
      "versionName",
      "apiName",
      "serviceName",
      "resourceGroup",
      "versionId",
    ],
    ...entityLifecycle<
      ApiVersionProps,
      ApiVersion["Attributes"],
      Key,
      apicenter.GetApiVersionResponse
    >({
      label: (key) => `API Center API version ${key.apiName}/${key.versionName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            apiName: props.apiName,
            versionName:
              props.name ??
              output?.versionName ??
              (yield* createApiCenterName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apicenter.GetApiVersion({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          apiName: key.apiName,
          versionName: key.versionName,
        }),
      put: (subscriptionId, key, props) =>
        apicenter.ApiVersionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          apiName: key.apiName,
          versionName: key.versionName,
          properties: desiredProperties(props, key.versionName),
        }),
      remove: (subscriptionId, key) =>
        apicenter.DeleteApiVersion({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceName: DEFAULT_WORKSPACE,
          apiName: key.apiName,
          versionName: key.versionName,
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
        versionName: key.versionName,
        versionId: observed.id ?? "",
        title: observed.properties?.title ?? key.versionName,
        lifecycleStage: observed.properties?.lifecycleStage ?? "",
      }),
    }),
  });
