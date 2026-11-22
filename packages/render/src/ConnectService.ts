import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { PrivateService } from "./PrivateService.ts";
import type { ServicePreview } from "./ServicePreview.ts";
import type { StaticSite } from "./StaticSite.ts";
import type { WebService } from "./WebService.ts";

/** Any Render HTTP-reachable compute resource that can be bound via {@link ConnectService}. */
export type ConnectableService = WebService | PrivateService | StaticSite | ServicePreview;

export const connectServiceEnvKeys = (service: Pick<ConnectableService, "LogicalId">) => {
  const id = service.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    url: `RENDER_SERVICE_${id}_URL`,
    slug: `RENDER_SERVICE_${id}_SLUG`,
  } as const;
};

export class ServiceUrlMissing extends Data.TaggedError("Render.ServiceUrlMissing")<{
  readonly resourceName: string;
}> {}

export interface ConnectServiceClient {
  /** Normalized HTTP/HTTPS base URL (`https://...` or `http://host:port`) for the bound service. */
  readonly url: Effect.Effect<string, ServiceUrlMissing, RuntimeContext>;
  /** Render service slug for the bound service. */
  readonly slug: Effect.Effect<string, ServiceUrlMissing, RuntimeContext>;
  /** Execute an HTTP request against the bound service (resolving relative paths against {@link url}). */
  readonly fetch: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | ServiceUrlMissing,
    HttpClient.HttpClient | RuntimeContext
  >;
}

/**
 * Bind another Render compute service (`WebService`, `PrivateService`,
 * `StaticSite`, or `ServicePreview`) to obtain its normalized URL, slug, and an
 * Effect `HttpClient` helper for service-to-service requests.
 *
 * At deploy time on Render hosts, injects `RENDER_SERVICE_<ID>_URL` and
 * `RENDER_SERVICE_<ID>_SLUG` via the host binding contract. On foreign
 * `RuntimeContext` hosts, writes both into the ambient `RuntimeContext`.
 * Provide {@link ConnectServiceHttp}.
 *
 * **Example:** Bind a PrivateService from a WebService
 * ```typescript
 * const internal = yield* Render.ConnectService(privateApi);
 * const res = yield* internal.fetch(HttpClientRequest.get("/health"));
 * ```
 *
 * @binding
 * @product Compute
 * @category Compute
 */
export interface ConnectService extends Binding.Service<
  ConnectService,
  "Render.ConnectService",
  (service: ConnectableService) => Effect.Effect<ConnectServiceClient>
> {}

export const ConnectService = Binding.Service<ConnectService>("Render.ConnectService");
