import * as apicenter from "@distilled.cloud/azure/apicenter";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { waitForProvisioned } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import {
  createApiCenterName,
  DEFAULT_WORKSPACE,
  entityLifecycle,
  subsetMatches,
} from "./Common.ts";

export interface ApiCenterSpecification {
  /**
   * How `value` is interpreted: the specification document itself
   * (`inline`) or a public URL to fetch it from (`link`).
   * @default "inline"
   */
  format?: "inline" | "link";
  /** Specification document (inline) or its URL (link). */
  value: string;
  /**
   * Specification language, e.g. `openapi`, `asyncapi`, `graphql`, `grpc`,
   * `wsdl`, `wadl`.
   */
  name: string;
  /** Specification language version, e.g. `3.0.1`. */
  version?: string;
}

export interface ApiDefinitionProps {
  /** Resource group of the API Center service. Changing it replaces the definition. */
  resourceGroup: string;
  /** API Center service that holds the API. Changing it replaces the definition. */
  serviceName: string;
  /** API that the version belongs to. Changing it replaces the definition. */
  apiName: string;
  /** API version that the definition belongs to. Changing it replaces the definition. */
  versionName: string;
  /**
   * Definition name: 3-90 letters, digits, and hyphens (e.g. `openapi`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the definition.
   */
  name?: string;
  /**
   * Display title of the definition.
   * @default the definition name
   */
  title?: string;
  /** Description of the definition. */
  description?: string;
  /**
   * Specification document to import into the definition. It is
   * re-imported whenever it changes.
   * @default no specification
   */
  specification?: ApiCenterSpecification;
}

export interface ApiDefinition extends Resource<
  "Azure.ApiCenter.ApiDefinition",
  ApiDefinitionProps,
  {
    /** Name of the definition. */
    definitionName: string;
    /** API version that the definition belongs to. */
    versionName: string;
    /** API that the version belongs to. */
    apiName: string;
    /** API Center service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the definition. */
    definitionId: string;
    /**
     * Service-scoped ID,
     * `/workspaces/default/apis/{api}/versions/{version}/definitions/{name}`,
     * used as a {@link Deployment}'s `definitionId`.
     */
    scopedId: string;
    /** Display title of the definition. */
    title: string;
    /** Imported specification language, if any. */
    specificationName: string | undefined;
    /** Imported specification language version, if any. */
    specificationVersion: string | undefined;
    /** Hash of the last imported specification (change detection). */
    specificationHash: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API definition (e.g. an OpenAPI document) attached to an API version
 * in Azure API Center.
 *
 * The definition entity is created first; a `specification`, when given,
 * is then imported with the `importSpecification` action and re-imported
 * whenever it changes.
 *
 * @see https://learn.microsoft.com/azure/api-center/register-apis#add-an-api-definition
 *
 * ### Adding Definitions
 * **Example:** Inline OpenAPI document
 * ```typescript
 * const definition = yield* Azure.ApiCenter.ApiDefinition("orders-openapi", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   apiName: api.apiName,
 *   versionName: v1.versionName,
 *   name: "openapi",
 *   title: "OpenAPI",
 *   specification: {
 *     name: "openapi",
 *     version: "3.0.1",
 *     value: JSON.stringify({
 *       openapi: "3.0.1",
 *       info: { title: "Orders", version: "1.0.0" },
 *       paths: {},
 *     }),
 *   },
 * });
 * ```
 *
 * **Example:** Specification fetched from a URL
 * ```typescript
 * const definition = yield* Azure.ApiCenter.ApiDefinition("petstore", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   apiName: api.apiName,
 *   versionName: v1.versionName,
 *   specification: {
 *     format: "link",
 *     name: "openapi",
 *     value: "https://petstore3.swagger.io/api/v3/openapi.json",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ApiDefinition = Resource<ApiDefinition>(
  "Azure.ApiCenter.ApiDefinition",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  versionName: string;
  definitionName: string;
}

const desiredProperties = (
  props: ApiDefinitionProps,
  name: string,
): apicenter.ApiDefinitionProperties => ({
  title: props.title ?? name,
  description: props.description,
});

/** FNV-1a hash of the desired specification, for change detection. */
const specificationHash = (spec: ApiCenterSpecification | undefined) => {
  if (spec === undefined) return undefined;
  const text = JSON.stringify([
    spec.format ?? "inline",
    spec.name,
    spec.version ?? "",
    spec.value,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceName: DEFAULT_WORKSPACE,
  apiName: key.apiName,
  versionName: key.versionName,
  definitionName: key.definitionName,
});

export const ApiDefinitionProvider = () =>
  Provider.succeed(ApiDefinition, {
    stables: [
      "definitionName",
      "versionName",
      "apiName",
      "serviceName",
      "resourceGroup",
      "definitionId",
      "scopedId",
    ],
    ...entityLifecycle<
      ApiDefinitionProps,
      ApiDefinition["Attributes"],
      Key,
      apicenter.GetApiDefinitionResponse
    >({
      label: (key) =>
        `API Center definition ${key.apiName}/${key.versionName}/${key.definitionName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            apiName: props.apiName,
            versionName: props.versionName,
            definitionName:
              props.name ??
              output?.definitionName ??
              (yield* createApiCenterName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apicenter.GetApiDefinition(where(subscriptionId, key)),
      put: (subscriptionId, key, props) =>
        apicenter.ApiDefinitionsCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: desiredProperties(props, key.definitionName),
        }),
      remove: (subscriptionId, key) =>
        apicenter.DeleteApiDefinition(where(subscriptionId, key)),
      inSync: (props, observed) =>
        subsetMatches(
          desiredProperties(props, observed.name ?? ""),
          observed.properties,
        ),
      // The imported document is only readable through the asynchronous
      // exportSpecification action, so changes are detected by comparing
      // the desired hash with the one recorded at the last import.
      afterPut: (subscriptionId, key, props, observed, output) =>
        Effect.gen(function* () {
          const spec = props.specification;
          if (spec === undefined) return observed;
          const imported = observed.properties?.specification?.name;
          if (
            imported !== undefined &&
            output?.specificationHash === specificationHash(spec)
          ) {
            return observed;
          }
          yield* apicenter.ImportApiDefinitionSpecification({
            ...where(subscriptionId, key),
            format: spec.format ?? "inline",
            value: spec.value,
            specification: { name: spec.name, version: spec.version },
          });
          return yield* waitForProvisioned(
            `API Center definition import ${key.definitionName}`,
            apicenter.GetApiDefinition(where(subscriptionId, key)),
            (definition) =>
              definition.properties?.specification?.name?.toLowerCase() ===
              spec.name.toLowerCase()
                ? undefined
                : "Importing",
            { interval: "2 seconds", times: 30 },
          );
        }),
      toAttrs: (_subscriptionId, key, observed, props) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        versionName: key.versionName,
        definitionName: key.definitionName,
        definitionId: observed.id ?? "",
        scopedId: `/workspaces/${DEFAULT_WORKSPACE}/apis/${key.apiName}/versions/${key.versionName}/definitions/${key.definitionName}`,
        title: observed.properties?.title ?? key.definitionName,
        specificationName: observed.properties?.specification?.name,
        specificationVersion: observed.properties?.specification?.version,
        specificationHash:
          observed.properties?.specification?.name === undefined
            ? undefined
            : specificationHash(props?.specification),
      }),
    }),
  });
