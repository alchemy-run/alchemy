import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  annotationsOf,
  hasAlchemyLabelMap,
  ignoreGone,
  listApis,
  locationParent,
  missingGet,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  RegistryNotResolved,
} from "./internal.ts";

export type ApiProps = {
  /**
   * API id (the `{api}` segment of
   * `projects/{project}/locations/{location}/apis/{api}`). If omitted, a
   * unique id is generated. Immutable — changing it replaces the API.
   */
  apiId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the API.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Human-readable display name. Defaults to the API id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Availability word (`NONE`, `TESTING`, `PREVIEW`, `GENERAL`, …).
   */
  availability?: string;
  /**
   * Recommended version resource name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}`.
   */
  recommendedVersion?: string;
  /**
   * Recommended deployment resource name
   * `projects/{project}/locations/{location}/apis/{api}/deployments/{deployment}`.
   */
  recommendedDeployment?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Non-identifying metadata. Not used for ownership.
   */
  annotations?: Record<string, string>;
};

export type Api = Resource<
  "GCP.Apigeeregistry.Api",
  ApiProps,
  {
    /** Full resource name. */
    name: string;
    /** API id (last path segment). */
    apiId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Availability word. */
    availability: string | undefined;
    /** Recommended version resource name. */
    recommendedVersion: string | undefined;
    /** Recommended deployment resource name. */
    recommendedDeployment: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Annotations. */
    annotations: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A top-level API in Apigee Registry. Versions, specs, deployments, and
 * artifacts hang off it.
 *
 * Location and id are immutable. Display name, description, availability,
 * recommended version/deployment, labels, and annotations update in place.
 *
 * ### Creating an API
 * **Example:** Generated id
 * ```typescript
 * const api = yield* GCP.Apigeeregistry.Api("Pets", {
 *   displayName: "pets",
 *   description: "Pet store API",
 * });
 * ```
 *
 * **Example:** Named API with labels
 * ```typescript
 * const api = yield* GCP.Apigeeregistry.Api("Pets", {
 *   apiId: "pets",
 *   displayName: "pets",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const Api = Resource<Api>("GCP.Apigeeregistry.Api");

const resourceName = (project: string, location: string, apiId: string) =>
  `${locationParent(project, location)}/apis/${apiId}`;

const toAttrs = (api: registry.Api, project: string) => {
  const name = api.name ?? "";
  const parsed = parseResourceName(name, "apis");
  return {
    name,
    apiId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: api.displayName,
    description: api.description,
    availability: api.availability,
    recommendedVersion: api.recommendedVersion,
    recommendedDeployment: api.recommendedDeployment,
    labels: userLabels(api.labels),
    annotations: annotationsOf(api.annotations),
    createTime: api.createTime,
    updateTime: api.updateTime,
  };
};

const getByName = missingGet(registry.getProjectsLocationsApis);

export const ApiProvider = () =>
  Provider.succeed(Api, {
    stables: ["name", "apiId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.apiId ?? output?.apiId,
        nextId: news.apiId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const apiId = yield* toPhysicalId(id, olds?.apiId, output?.apiId);
      const name = output?.name ?? resourceName(env.project, location, apiId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listApis(
          locationParent(env.project, DEFAULT_LOCATION),
        );
        return items
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = locationParent(env.project, location);
      const apiId = yield* toPhysicalId(id, news.apiId, output?.apiId);
      const name = output?.name ?? resourceName(env.project, location, apiId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = tagRecord(news.annotations);
      const displayName = news.displayName ?? apiId;
      const body: registry.Api = {
        displayName,
        description: news.description,
        availability: news.availability,
        recommendedVersion: news.recommendedVersion,
        recommendedDeployment: news.recommendedDeployment,
        labels: desiredLabels,
        annotations: desiredAnnotations,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          registry.createProjectsLocationsApis({
            parent,
            apiId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RegistryNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(
        current.description,
        news.description,
      );
      const availabilityChanged = !sameText(
        current.availability,
        news.availability,
      );
      const recommendedVersionChanged = !sameText(
        current.recommendedVersion,
        news.recommendedVersion,
      );
      const recommendedDeploymentChanged = !sameText(
        current.recommendedDeployment,
        news.recommendedDeployment,
      );
      const annotationsChanged = !sameJson(
        annotationsOf(current.annotations),
        desiredAnnotations,
      );

      if (
        labelsChanged ||
        displayChanged ||
        descriptionChanged ||
        availabilityChanged ||
        recommendedVersionChanged ||
        recommendedDeploymentChanged ||
        annotationsChanged
      ) {
        current = yield* retryTransient(
          registry.patchProjectsLocationsApis({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              availabilityChanged ? "availability" : undefined,
              recommendedVersionChanged ? "recommendedVersion" : undefined,
              recommendedDeploymentChanged
                ? "recommendedDeployment"
                : undefined,
              labelsChanged ? "labels" : undefined,
              annotationsChanged ? "annotations" : undefined,
            ),
            body: { name: currentName, ...body },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        registry.deleteProjectsLocationsApis({
          name: output.name,
          force: true,
        }),
      );
    }),
  });
