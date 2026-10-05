import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  createEntityName,
  isParentOwned,
  sameName,
  subsetMatches,
} from "./Common.ts";

export type ApiType = apim.ApiCreateOrUpdatePropertiesInputType;
export type ApiProtocol = apim.ApiCreateOrUpdatePropertiesInputProtocolsItem;
export type ApiImportFormat = apim.ApiCreateOrUpdatePropertiesInputFormat;

export interface ApiProps {
  /** Resource group of the API Management service. Changing it replaces the API. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the API. */
  serviceName: string;
  /**
   * API identifier (1-80 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the API.
   */
  name?: string;
  /**
   * URL suffix of the API on the gateway (`{gatewayUrl}/{path}`); unique
   * per service. May be empty.
   */
  path: string;
  /**
   * Display name.
   * @default the API identifier, or the imported document's title
   */
  displayName?: string;
  /** Description; may contain HTML. */
  description?: string;
  /** URL of the backend service implementing the API. */
  serviceUrl?: string;
  /**
   * Protocols the API is exposed on.
   * @default ["https"]
   */
  protocols?: ApiProtocol[];
  /**
   * Whether calls need a subscription key.
   * @default true
   */
  subscriptionRequired?: boolean;
  /** Header and query parameter names carrying the subscription key. */
  subscriptionKeyParameterNames?: {
    /** Header name. @default "Ocp-Apim-Subscription-Key" */
    header?: string;
    /** Query parameter name. @default "subscription-key" */
    query?: string;
  };
  /**
   * API type. Changing it replaces the API.
   * @default "http"
   */
  type?: ApiType;
  /** Version of the API when it belongs to a version set. */
  apiVersion?: string;
  /** ARM id of the API version set the API belongs to. */
  apiVersionSetId?: string;
  /** Terms of service URL. */
  termsOfServiceUrl?: string;
  /**
   * Definition to import (an OpenAPI document, WSDL, GraphQL schema, or a
   * link to one), interpreted according to `format`. Importing replaces
   * the API's operations, so do not combine it with `ApiOperation`
   * resources on the same API. Changing it re-imports the definition.
   */
  value?: string;
  /** Format of `value`, e.g. `openapi+json`, `openapi-link`, or `wsdl`. */
  format?: ApiImportFormat;
}

export interface Api extends Resource<
  "Azure.ApiManagement.Api",
  ApiProps,
  {
    /** API identifier. */
    apiName: string;
    /** ARM resource ID of the API; use it as a subscription scope. */
    apiId: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** URL suffix of the API on the gateway. */
    path: string;
    /** Display name. */
    displayName: string | undefined;
    /** Backend service URL. */
    serviceUrl: string | undefined;
    /** API type. */
    type: string;
    /** Current revision number. */
    apiRevision: string | undefined;
    /** Whether this revision is the current one. */
    isCurrent: boolean;
  },
  never,
  Providers
> {}

/**
 * An API exposed through an API Management gateway at
 * `{gatewayUrl}/{path}`. Define operations with `ApiOperation`, or import
 * them from an OpenAPI/WSDL/GraphQL definition with `value` + `format`.
 *
 * @see https://learn.microsoft.com/azure/api-management/add-api-manually
 *
 * ### Creating an API
 * **Example:** HTTP API proxying a backend
 * ```typescript
 * const api = yield* Azure.ApiManagement.Api("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   path: "orders",
 *   serviceUrl: "https://orders.example.com",
 * });
 * ```
 *
 * ### Importing a Definition
 * **Example:** Import an inline OpenAPI document
 * ```typescript
 * const api = yield* Azure.ApiManagement.Api("petstore", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   path: "pets",
 *   format: "openapi+json",
 *   value: JSON.stringify(openApiDocument),
 * });
 * ```
 *
 * **Example:** Import from a URL
 * ```typescript
 * const api = yield* Azure.ApiManagement.Api("petstore", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   path: "pets",
 *   format: "openapi-link",
 *   value: "https://petstore3.swagger.io/api/v3/openapi.json",
 * });
 * ```
 *
 * @resource
 */
export const Api = Resource<Api>("Azure.ApiManagement.Api");

const getApi = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApi({ subscriptionId, resourceGroupName, serviceName, apiId }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  api: apim.GetApiResponse,
): Api["Attributes"] => ({
  apiName: name,
  apiId: api.id ?? "",
  serviceName,
  resourceGroup,
  path: api.properties?.path ?? "",
  displayName: api.properties?.displayName,
  serviceUrl: api.properties?.serviceUrl,
  type: api.properties?.type ?? "http",
  apiRevision: api.properties?.apiRevision,
  isCurrent: api.properties?.isCurrent ?? true,
});

export const ApiProvider = () =>
  Provider.succeed(Api, {
    stables: ["apiName", "apiId", "serviceName", "resourceGroup"],

    // APIs live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.apiName)) ||
        (news.type ?? "http") !== output.type
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.apiName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getApi(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.apiName ?? (yield* createEntityName(id));
      const imported = news.value !== undefined;
      const desired = {
        path: news.path,
        displayName: news.displayName ?? (imported ? undefined : name),
        description: news.description,
        serviceUrl: news.serviceUrl,
        protocols: news.protocols ?? ["https"],
        subscriptionRequired: news.subscriptionRequired ?? true,
        subscriptionKeyParameterNames: news.subscriptionKeyParameterNames,
        type: news.type ?? "http",
        apiVersion: news.apiVersion,
        apiVersionSetId: news.apiVersionSetId,
        termsOfServiceUrl: news.termsOfServiceUrl,
      } satisfies Partial<apim.ApiCreateOrUpdatePropertiesInput>;
      const get = getApi(subscriptionId, resourceGroup, serviceName, name);

      // Observe. An imported definition cannot be read back, so the
      // previous value is the only hint that a re-import is needed.
      const observed = yield* get;
      const needsImport =
        imported &&
        (observed === undefined ||
          olds?.value !== news.value ||
          olds?.format !== news.format);
      if (
        observed === undefined ||
        needsImport ||
        !subsetMatches(
          { ...desired, protocols: [...desired.protocols].sort() },
          {
            ...observed.properties,
            protocols: [...(observed.properties?.protocols ?? [])].sort(),
          },
        )
      ) {
        yield* apim.ApiCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serviceName,
          apiId: name,
          properties: {
            ...desired,
            value: needsImport ? news.value : undefined,
            format: needsImport ? news.format : undefined,
          },
        });
      }
      // Imports run asynchronously (202); wait until the API is readable
      // and no longer in progress.
      const current = yield* waitForProvisioned(
        `API Management API ${name}`,
        get,
        (api) =>
          api.properties?.provisioningState === "InProgress"
            ? "InProgress"
            : undefined,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteApi({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          apiId: output.apiName,
          deleteRevisions: true,
        }),
      );
      yield* waitUntilGone(
        `API Management API ${output.apiName}`,
        getApi(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.apiName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
