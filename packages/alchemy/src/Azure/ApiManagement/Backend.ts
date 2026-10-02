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

export interface BackendCredentials {
  /** Header name to values sent with every request to the backend. */
  header?: Record<string, string[]>;
  /** Query parameter name to values sent with every request. */
  query?: Record<string, string[]>;
  /** `Authorization` header sent to the backend. */
  authorization?: {
    /** Authentication scheme, e.g. `Basic` or `Bearer`. */
    scheme: string;
    /** Scheme parameter (the credential). */
    parameter: string;
  };
  /** Client certificate ids (APIM certificate entity ids) for mutual TLS. */
  certificateIds?: string[];
}

export interface BackendTls {
  /** Validate the backend's certificate chain. @default true */
  validateCertificateChain?: boolean;
  /** Validate the backend's certificate host name. @default true */
  validateCertificateName?: boolean;
}

export interface BackendPoolMember {
  /** ARM id of a `Single` backend in the same service. */
  id: string;
  /** Relative weight for load balancing. */
  weight?: number;
  /** Priority group (lower is preferred). */
  priority?: number;
}

export interface BackendProps {
  /** Resource group of the API Management service. Changing it replaces the backend. */
  resourceGroup: string;
  /** API Management service that holds the backend. Changing it replaces the backend. */
  serviceName: string;
  /**
   * Backend identifier (1-80 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the backend.
   */
  name?: string;
  /**
   * `Single` (one URL) or `Pool` (load-balanced set of backends). Changing
   * it replaces the backend.
   * @default "Single"
   */
  type?: "Single" | "Pool";
  /** Runtime URL of the backend. Required for `Single` backends. */
  url?: string;
  /**
   * Backend protocol. Required for `Single` backends.
   * @default "http" for `Single` backends
   */
  protocol?: "http" | "soap";
  /** Title. */
  title?: string;
  /** Description. */
  description?: string;
  /**
   * Management URI of the backend's Azure resource (e.g. the ARM URL of a
   * Function App or Logic App).
   */
  resourceId?: string;
  /** Credentials sent to the backend. */
  credentials?: BackendCredentials;
  /** TLS validation settings. */
  tls?: BackendTls;
  /** Members of a `Pool` backend. */
  pool?: BackendPoolMember[];
  /** Circuit breaker rules (v2 and classic tiers). */
  circuitBreaker?: apim.BackendCircuitBreaker;
}

export interface Backend extends Resource<
  "Azure.ApiManagement.Backend",
  BackendProps,
  {
    /** Backend identifier; use it in `<set-backend-service backend-id=... />`. */
    backendName: string;
    /** ARM resource ID of the backend. */
    backendId: string;
    /** API Management service that holds the backend. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Backend type. */
    type: string;
    /** Runtime URL of the backend. */
    url: string | undefined;
    /** Backend protocol. */
    protocol: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API Management backend — a named upstream service that policies route
 * to with `<set-backend-service backend-id="..." />`.
 *
 * @see https://learn.microsoft.com/azure/api-management/backends
 *
 * ### Creating a Backend
 * **Example:** HTTP backend
 * ```typescript
 * const backend = yield* Azure.ApiManagement.Backend("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   url: "https://orders.example.com",
 *   protocol: "http",
 * });
 * ```
 *
 * **Example:** Backend with a header credential and relaxed TLS
 * ```typescript
 * const backend = yield* Azure.ApiManagement.Backend("legacy", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   url: "https://legacy.internal.example.com",
 *   credentials: { header: { "x-api-key": ["{{legacy-key}}"] } },
 *   tls: { validateCertificateChain: false, validateCertificateName: false },
 * });
 * ```
 *
 * @resource
 */
export const Backend = Resource<Backend>("Azure.ApiManagement.Backend");

const getBackend = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  backendId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetBackend({
      subscriptionId,
      resourceGroupName,
      serviceName,
      backendId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  backend: apim.GetBackendResponse,
): Backend["Attributes"] => ({
  backendName: name,
  backendId: backend.id ?? "",
  serviceName,
  resourceGroup,
  type: backend.properties?.type ?? "Single",
  url: backend.properties?.url,
  protocol: backend.properties?.protocol,
});

export const BackendProvider = () =>
  Provider.succeed(Backend, {
    stables: ["backendName", "backendId", "serviceName", "resourceGroup"],

    // Backends live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.backendName)) ||
        (news.type ?? "Single") !== output.type
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
        output?.backendName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getBackend(
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.backendName ?? (yield* createEntityName(id));
      const type = news.type ?? "Single";
      const desired: apim.BackendContractProperties = {
        type,
        url: news.url,
        protocol: news.protocol ?? (type === "Single" ? "http" : undefined),
        title: news.title,
        description: news.description,
        resourceId: news.resourceId,
        credentials: news.credentials,
        tls: news.tls,
        pool: news.pool ? { services: news.pool } : undefined,
        circuitBreaker: news.circuitBreaker,
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getBackend(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const current =
        observed !== undefined && subsetMatches(desired, observed.properties)
          ? observed
          : yield* apim.BackendCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              backendId: name,
              properties: desired,
            });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteBackend({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          backendId: output.backendName,
        }),
      );
      yield* waitUntilGone(
        `API Management backend ${output.backendName}`,
        getBackend(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.backendName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
