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
  encodeBytes,
  hasAlchemyLabelMap,
  ignoreGone,
  listApis,
  listChildResources,
  listSpecs,
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
  sha256Hex,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  RegistryNotResolved,
} from "./internal.ts";

export type ApisVersionsSpecProps = {
  /**
   * Parent version. Full name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}`.
   * Immutable — changing it replaces the spec.
   */
  version: string;
  /**
   * Spec id (the `{spec}` segment of
   * `.../versions/{version}/specs/{spec}`). If omitted, a unique id is
   * generated. Immutable — changing it replaces the spec.
   */
  specId?: string;
  /**
   * Location used when parsing parent names.
   * @default "us-central1"
   */
  location?: string;
  /**
   * File name used to refer to this spec from other specs.
   */
  filename?: string;
  /**
   * Media type (`application/x.openapi+json;version=3.0.0`, …).
   */
  mimeType?: string;
  /**
   * Spec document as UTF-8 text. Alchemy base64-encodes it for the API.
   * Input-only — updates send a new document when this field changes.
   */
  contents?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Original source URI of the spec, if one exists.
   */
  sourceUri?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Non-identifying metadata. Not used for ownership.
   */
  annotations?: Record<string, string>;
};

export type ApisVersionsSpec = Resource<
  "GCP.Apigeeregistry.ApisVersionsSpec",
  ApisVersionsSpecProps,
  {
    /** Full resource name. */
    name: string;
    /** Spec id (last path segment). */
    specId: string;
    /** Parent version resource name. */
    version: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** File name. */
    filename: string | undefined;
    /** Media type. */
    mimeType: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Original source URI. */
    sourceUri: string | undefined;
    /** SHA-256 of the uncompressed spec contents. */
    hash: string | undefined;
    /** Size in bytes of the uncompressed spec. */
    sizeBytes: number | undefined;
    /** Current revision id. */
    revisionId: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Annotations. */
    annotations: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 revision creation timestamp. */
    revisionCreateTime: string | undefined;
    /** RFC3339 last revision update timestamp. */
    revisionUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee Registry API spec — a formal description of an API version.
 *
 * Parent version, location, and spec id are immutable. Filename, mime
 * type, description, source URI, contents, labels, and annotations
 * update in place (contents changes commit a new revision).
 *
 * ### Creating a Spec
 * **Example:** OpenAPI document
 * ```typescript
 * const spec = yield* GCP.Apigeeregistry.ApisVersionsSpec("Openapi", {
 *   version: version.name,
 *   filename: "openapi.json",
 *   mimeType: "application/x.openapi+json;version=3.0.0",
 *   contents: JSON.stringify({
 *     openapi: "3.0.0",
 *     info: { title: "pets", version: "1.0.0" },
 *     paths: {},
 *   }),
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const ApisVersionsSpec = Resource<ApisVersionsSpec>(
  "GCP.Apigeeregistry.ApisVersionsSpec",
);

const resourceName = (version: string, specId: string) =>
  `${version}/specs/${specId}`;

const toAttrs = (spec: registry.ApiSpec, project: string) => {
  const name = spec.name ?? "";
  const parsed = parseResourceName(name, "specs");
  return {
    name,
    specId: parsed.id,
    version: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    filename: spec.filename,
    mimeType: spec.mimeType,
    description: spec.description,
    sourceUri: spec.sourceUri,
    hash: spec.hash,
    sizeBytes: spec.sizeBytes,
    revisionId: spec.revisionId,
    labels: userLabels(spec.labels),
    annotations: annotationsOf(spec.annotations),
    createTime: spec.createTime,
    revisionCreateTime: spec.revisionCreateTime,
    revisionUpdateTime: spec.revisionUpdateTime,
  };
};

const getByName = missingGet(registry.getProjectsLocationsApisVersionsSpecs);

export const ApisVersionsSpecProvider = () =>
  Provider.succeed(ApisVersionsSpec, {
    stables: ["name", "specId", "version", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.specId ?? output?.specId,
        nextId: news.specId,
        previousParent: olds?.version ?? output?.version,
        nextParent: news.version,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const specId = yield* toPhysicalId(id, olds?.specId, output?.specId);
      const version = olds?.version ?? output?.version ?? "";
      const name =
        output?.name ?? (version ? resourceName(version, specId) : "");
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
        const specs = yield* listChildResources(namedOf(versions), listSpecs);
        return specs
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const version = news.version.replace(/\/+$/, "");
      const specId = yield* toPhysicalId(id, news.specId, output?.specId);
      const name = output?.name ?? resourceName(version, specId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = tagRecord(news.annotations);
      const mimeType = news.mimeType ?? "application/json";
      const contents =
        news.contents !== undefined
          ? yield* encodeBytes(news.contents)
          : undefined;
      const body: registry.ApiSpec = {
        filename: news.filename,
        mimeType,
        description: news.description,
        sourceUri: news.sourceUri,
        contents,
        labels: desiredLabels,
        annotations: desiredAnnotations,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          registry.createProjectsLocationsApisVersionsSpecs({
            parent: version,
            apiSpecId: specId,
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
      const filenameChanged = !sameText(current.filename, news.filename);
      const mimeChanged = !sameText(current.mimeType, mimeType);
      const descriptionChanged = !sameText(
        current.description,
        news.description,
      );
      const sourceChanged = !sameText(current.sourceUri, news.sourceUri);
      const annotationsChanged = !sameJson(
        annotationsOf(current.annotations),
        desiredAnnotations,
      );
      let contentsChanged = false;
      if (news.contents !== undefined) {
        const desiredHash = yield* sha256Hex(news.contents);
        contentsChanged = (current.hash ?? "").toLowerCase() !== desiredHash;
      }

      if (
        labelsChanged ||
        filenameChanged ||
        mimeChanged ||
        descriptionChanged ||
        sourceChanged ||
        annotationsChanged ||
        contentsChanged
      ) {
        current = yield* retryTransient(
          registry.patchProjectsLocationsApisVersionsSpecs({
            name: currentName,
            updateMask: updateMaskOf(
              filenameChanged ? "filename" : undefined,
              mimeChanged ? "mimeType" : undefined,
              descriptionChanged ? "description" : undefined,
              sourceChanged ? "sourceUri" : undefined,
              contentsChanged ? "contents" : undefined,
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
        registry.deleteProjectsLocationsApisVersionsSpecs({
          name: output.name,
          force: true,
        }),
      );
    }),
  });
