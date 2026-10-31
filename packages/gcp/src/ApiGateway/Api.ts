import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, diffLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  fieldMask,
  hasAlchemyLabelMap,
  listApis,
  locationParent,
  parseName,
  replaceOnIdentity,
  ResourceFailed,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ApiProps = {
  /**
   * API id (the `{api}` segment of `projects/{project}/locations/global/apis/{api}`).
   * If omitted, a unique RFC1035 id is generated. Immutable — changing it
   * replaces the API.
   */
  apiId?: string;
  /**
   * User-visible display name. Defaults to the API id.
   */
  displayName?: string;
  /**
   * The Service Management service the API is backed by
   * (`{api}-{hash}.apigateway.{project}.cloud.goog`). If omitted, API Gateway
   * creates one. Immutable — changing it replaces the API.
   */
  managedService?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Api = Resource<
  "GCP.ApiGateway.Api",
  ApiProps,
  {
    /** Full resource name (`projects/{project}/locations/global/apis/{api}`). */
    name: string;
    /** API id (last path segment). */
    apiId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-visible display name. */
    displayName: string | undefined;
    /** The Service Management service backing the API. */
    managedService: string | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
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
 * An API Gateway API: the managed API that {@link ApisConfig}s describe and
 * Gateways serve.
 *
 * The API id and managed service are immutable. Display name and labels
 * update in place. APIs live in `locations/global`.
 *
 * ### Creating an API
 * **Example:** Generated id
 * ```typescript
 * const api = yield* GCP.ApiGateway.Api("Orders", {});
 * ```
 *
 * **Example:** An API with an OpenAPI config
 * ```typescript
 * const api = yield* GCP.ApiGateway.Api("Orders", {
 *   apiId: "orders",
 *   displayName: "Orders API",
 * });
 * const config = yield* GCP.ApiGateway.ApisConfig("V1", {
 *   api: api.name,
 *   openapiDocuments: [
 *     { document: { path: "openapi.yaml", contents: openApi } },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ApiGateway
 */
export const Api = Resource<Api>("GCP.ApiGateway.Api");

const apiName = (project: string, apiId: string) => `${locationParent(project)}/apis/${apiId}`;

const toAttrs = (api: apigateway.ApigatewayApi, project: string) => {
  const parsed = parseName(api.name ?? "", "apis");
  // API Gateway reports names with the project number; keep the project-id
  // form so names are stable and match what configs are addressed by.
  return {
    name: apiName(project, parsed.id),
    apiId: parsed.id,
    project,
    location: parsed.location || DEFAULT_LOCATION,
    displayName: api.displayName,
    managedService: api.managedService,
    state: api.state,
    labels: userLabels(api.labels),
    createTime: api.createTime,
    updateTime: api.updateTime,
  };
};

const getByName = (name: string) =>
  apigateway
    .getProjectsLocationsApis({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitApiActive = (name: string) =>
  waitUntilReady(getByName(name), name, (api) => api.state, { times: 30, interval: "4 seconds" });

export const ApiProvider = () =>
  Provider.succeed(Api, {
    stables: ["name", "apiId", "project", "location", "managedService", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const serviceChanged =
        news.managedService !== undefined &&
        (olds?.managedService ?? output?.managedService) !== undefined &&
        news.managedService !== (olds?.managedService ?? output?.managedService);
      return replaceOnIdentity({
        previousId: olds?.apiId ?? output?.apiId,
        nextId: news.apiId ?? olds?.apiId ?? output?.apiId,
        extra: serviceChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const apiId = yield* toPhysicalId(id, olds?.apiId, output?.apiId);
      const existing = yield* getByName(output?.name ?? apiName(env.project, apiId));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apis = yield* listApis(locationParent(env.project));
        return apis
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const apiId = yield* toPhysicalId(id, news.apiId, output?.apiId);
      const name = output?.name ?? apiName(env.project, apiId);
      const displayName = news.displayName ?? apiId;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apigateway
          .createProjectsLocationsApis({
            parent: locationParent(env.project),
            apiId,
            body: {
              displayName,
              labels: desiredLabels,
              managedService: news.managedService,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
      }
      current = yield* waitApiActive(name);

      const { upsert, removed } = diffLabels(tagRecord(current.labels), desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, displayName) && "displayName",
      ]);
      if (mask.length > 0) {
        const operation = yield* apigateway.patchProjectsLocationsApis({
          name,
          updateMask: mask,
          body: { displayName, labels: desiredLabels },
        });
        yield* waitForOperation(operation);
        current = yield* waitApiActive(name);
      }

      if ((current.state ?? "").toUpperCase() === "FAILED") {
        return yield* new ResourceFailed({ resourceName: name, state: "FAILED" });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigateway.deleteProjectsLocationsApis({ name: output.name }).pipe(
        Effect.retry({
          // Conflict: a config or another operation still holds the API.
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("5 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
