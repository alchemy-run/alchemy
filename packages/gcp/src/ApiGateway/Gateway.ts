import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, diffLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  hasAlchemyLabelMap,
  parseName,
  replaceOnIdentity,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_REGION = "us-central1";

export type GatewayProps = {
  /**
   * The API config the gateway serves:
   * `projects/{project}/locations/global/apis/{api}/configs/{apiConfig}`.
   * Updates in place; the gateway rolls out the new config.
   */
  apiConfig: string;
  /**
   * Gateway id (the `{gateway}` segment of
   * `projects/{project}/locations/{location}/gateways/{gateway}`). If
   * omitted, a unique RFC1035 id is generated. Immutable — changing it
   * replaces the gateway.
   */
  gatewayId?: string;
  /**
   * Region the gateway runs in. Immutable — changing it replaces the
   * gateway.
   * @default "us-central1"
   */
  location?: string;
  /**
   * User-visible display name. Defaults to the gateway id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Gateway = Resource<
  "GCP.ApiGateway.Gateway",
  GatewayProps,
  {
    /** Full resource name. */
    name: string;
    /** Gateway id (last path segment). */
    gatewayId: string;
    /** Project id. */
    project: string;
    /** Region. */
    location: string;
    /** The API config the gateway serves. */
    apiConfig: string | undefined;
    /** The gateway's hostname (`{gateway}-{hash}.uc.gateway.dev`). */
    defaultHostname: string | undefined;
    /** `https://` URL of the gateway. */
    url: string | undefined;
    /** User-visible display name. */
    displayName: string | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, `UPDATING`, …). */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Gateway gateway: a regional, fully managed endpoint that serves an
 * {@link ApisConfig}.
 *
 * The gateway id and region are immutable. The served config, display name
 * and labels update in place. Creating a gateway takes a few minutes.
 *
 * ### Serving an API
 * **Example:** A gateway in front of an OpenAPI config
 * ```typescript
 * const api = yield* GCP.ApiGateway.Api("Orders", {});
 * const config = yield* GCP.ApiGateway.ApisConfig("V1", {
 *   api: api.name,
 *   openapiDocuments: [
 *     { document: { path: "openapi.yaml", contents: openApi } },
 *   ],
 * });
 * const gateway = yield* GCP.ApiGateway.Gateway("Edge", {
 *   apiConfig: config.name,
 *   location: "us-central1",
 * });
 * // gateway.url → https://edge-….uc.gateway.dev
 * ```
 *
 * ### Rolling out a new config
 * **Example:** Point the gateway at the next config
 * ```typescript
 * const v2 = yield* GCP.ApiGateway.ApisConfig("V2", {
 *   api: api.name,
 *   openapiDocuments: [
 *     { document: { path: "openapi.yaml", contents: openApiV2 } },
 *   ],
 * });
 * const gateway = yield* GCP.ApiGateway.Gateway("Edge", {
 *   apiConfig: v2.name,
 * });
 * ```
 *
 * @resource
 * @category ApiGateway
 */
export const Gateway = Resource<Gateway>("GCP.ApiGateway.Gateway");

const regionParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const gatewayName = (project: string, location: string, gatewayId: string) =>
  `${regionParent(project, location)}/gateways/${gatewayId}`;

/** A config name in its project-id form; API Gateway may report the project number. */
const canonicalConfig = (config: string | undefined, project: string) =>
  config?.replace(/^projects\/\d+\//, `projects/${project}/`);

const toAttrs = (gateway: apigateway.ApigatewayGateway, project: string) => {
  const parsed = parseName(gateway.name ?? "", "gateways");
  return {
    name: gatewayName(project, parsed.location, parsed.id),
    gatewayId: parsed.id,
    project,
    location: parsed.location,
    apiConfig: canonicalConfig(gateway.apiConfig, project),
    defaultHostname: gateway.defaultHostname,
    url: gateway.defaultHostname ? `https://${gateway.defaultHostname}` : undefined,
    displayName: gateway.displayName,
    state: gateway.state,
    labels: userLabels(gateway.labels),
    createTime: gateway.createTime,
    updateTime: gateway.updateTime,
  };
};

const getByName = (name: string) =>
  apigateway
    .getProjectsLocationsGateways({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitGatewayActive = (name: string) =>
  waitUntilReady(getByName(name), name, (gateway) => gateway.state, {
    times: 40,
    interval: "8 seconds",
  });

export const GatewayProvider = () =>
  Provider.succeed(Gateway, {
    stables: ["name", "gatewayId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location ?? DEFAULT_REGION;
      return replaceOnIdentity({
        previousId: olds?.gatewayId ?? output?.gatewayId,
        nextId: news.gatewayId ?? olds?.gatewayId ?? output?.gatewayId,
        extra: (news.location ?? DEFAULT_REGION) !== previousLocation,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewayId = yield* toPhysicalId(id, olds?.gatewayId, output?.gatewayId);
      const location = olds?.location ?? output?.location ?? DEFAULT_REGION;
      const existing = yield* getByName(
        output?.name ?? gatewayName(env.project, location, gatewayId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* apigateway.listProjectsLocationsGateways
          .pages({ parent: regionParent(env.project, "-"), pageSize: 1000 })
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.gateways ?? [])
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? DEFAULT_REGION;
      const gatewayId = yield* toPhysicalId(id, news.gatewayId, output?.gatewayId);
      const name = output?.name ?? gatewayName(env.project, location, gatewayId);
      const displayName = news.displayName ?? gatewayId;
      const apiConfig = canonicalConfig(news.apiConfig, env.project)!;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      const existing = yield* getByName(name);
      if (existing === undefined) {
        const created = yield* apigateway
          .createProjectsLocationsGateways({
            parent: regionParent(env.project, location),
            gatewayId,
            body: { apiConfig, displayName, labels: desiredLabels },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
      }
      let current = yield* waitGatewayActive(name);

      const { upsert, removed } = diffLabels(tagRecord(current.labels), desiredLabels);
      const mask = fieldMask([
        canonicalConfig(current.apiConfig, env.project) !== apiConfig && "apiConfig",
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, displayName) && "displayName",
      ]);
      if (mask.length > 0) {
        const operation = yield* apigateway.patchProjectsLocationsGateways({
          name,
          updateMask: mask,
          body: { apiConfig, displayName, labels: desiredLabels },
        });
        yield* waitForOperation(operation);
        current = yield* waitGatewayActive(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigateway
        .deleteProjectsLocationsGateways({ name: output.name })
        .pipe(
          Effect.retry({
            // Conflict: an update is still rolling out.
            while: (error) => error._tag === "Conflict",
            times: 12,
            schedule: Schedule.spaced("10 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
