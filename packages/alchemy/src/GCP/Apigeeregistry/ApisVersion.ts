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
  expandParent,
  hasAlchemyLabelMap,
  ignoreGone,
  listApis,
  listChildResources,
  listVersions,
  locationParent,
  missingGet,
  namedOf,
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

export type ApisVersionProps = {
  /**
   * Parent API. Full name
   * `projects/{project}/locations/{location}/apis/{api}` or the API id
   * (combined with `location`). Immutable — changing it replaces the
   * version.
   */
  api: string;
  /**
   * Version id (the `{version}` segment of
   * `.../apis/{api}/versions/{version}`). If omitted, a unique id is
   * generated. Immutable — changing it replaces the version.
   */
  versionId?: string;
  /**
   * Location used when `api` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Display name. Defaults to the version id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Lifecycle word (`CONCEPT`, `DESIGN`, `DEVELOPMENT`, `STAGING`,
   * `PRODUCTION`, …).
   */
  state?: string;
  /**
   * Primary spec resource name
   * `.../apis/{api}/versions/{version}/specs/{spec}`.
   */
  primarySpec?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Non-identifying metadata. Not used for ownership.
   */
  annotations?: Record<string, string>;
};

export type ApisVersion = Resource<
  "GCP.Apigeeregistry.ApisVersion",
  ApisVersionProps,
  {
    /** Full resource name. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent API resource name. */
    api: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Lifecycle word. */
    state: string | undefined;
    /** Primary spec resource name. */
    primarySpec: string | undefined;
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
 * An Apigee Registry API version. Specs and version artifacts hang off it.
 *
 * Parent API, location, and version id are immutable. Display name,
 * description, state, primary spec, labels, and annotations update in
 * place.
 *
 * ### Creating a Version
 * **Example:** Generated id
 * ```typescript
 * const version = yield* GCP.Apigeeregistry.ApisVersion("V1", {
 *   api: api.name,
 *   displayName: "v1",
 *   state: "PRODUCTION",
 * });
 * ```
 *
 * **Example:** Named version
 * ```typescript
 * const version = yield* GCP.Apigeeregistry.ApisVersion("V1", {
 *   api: api.name,
 *   versionId: "v1",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const ApisVersion = Resource<ApisVersion>(
  "GCP.Apigeeregistry.ApisVersion",
);

const parentApi = (api: string, project: string, location: string) =>
  expandParent(api, project, location, "apis");

const resourceName = (api: string, versionId: string) =>
  `${api}/versions/${versionId}`;

const toAttrs = (version: registry.ApiVersion, project: string) => {
  const name = version.name ?? "";
  const parsed = parseResourceName(name, "versions");
  return {
    name,
    versionId: parsed.id,
    api: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: version.displayName,
    description: version.description,
    state: version.state,
    primarySpec: version.primarySpec,
    labels: userLabels(version.labels),
    annotations: annotationsOf(version.annotations),
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const getByName = missingGet(registry.getProjectsLocationsApisVersions);

export const ApisVersionProvider = () =>
  Provider.succeed(ApisVersion, {
    stables: ["name", "versionId", "api", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return replaceOnIdentity({
        previousId: olds?.versionId ?? output?.versionId,
        nextId: news.versionId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: location,
        previousParent: olds?.api ?? output?.api,
        nextParent: parentApi(news.api, env.project, location),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const versionId = yield* toPhysicalId(
        id,
        olds?.versionId,
        output?.versionId,
      );
      const api =
        olds?.api !== undefined
          ? parentApi(olds.api, env.project, location)
          : (output?.api ?? "");
      const name = output?.name ?? (api ? resourceName(api, versionId) : "");
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
        const apis = yield* listApis(
          locationParent(env.project, DEFAULT_LOCATION),
        );
        const versions = yield* listChildResources(namedOf(apis), listVersions);
        return versions
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const api = parentApi(news.api, env.project, location);
      const versionId = yield* toPhysicalId(
        id,
        news.versionId,
        output?.versionId,
      );
      const name = output?.name ?? resourceName(api, versionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = tagRecord(news.annotations);
      const displayName = news.displayName ?? versionId;
      const body: registry.ApiVersion = {
        displayName,
        description: news.description,
        state: news.state,
        primarySpec: news.primarySpec,
        labels: desiredLabels,
        annotations: desiredAnnotations,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          registry.createProjectsLocationsApisVersions({
            parent: api,
            apiVersionId: versionId,
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
      const stateChanged = !sameText(current.state, news.state);
      const primaryChanged = !sameText(current.primarySpec, news.primarySpec);
      const annotationsChanged = !sameJson(
        annotationsOf(current.annotations),
        desiredAnnotations,
      );

      if (
        labelsChanged ||
        displayChanged ||
        descriptionChanged ||
        stateChanged ||
        primaryChanged ||
        annotationsChanged
      ) {
        current = yield* retryTransient(
          registry.patchProjectsLocationsApisVersions({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              stateChanged ? "state" : undefined,
              primaryChanged ? "primarySpec" : undefined,
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
        registry.deleteProjectsLocationsApisVersions({
          name: output.name,
          force: true,
        }),
      );
    }),
  });
