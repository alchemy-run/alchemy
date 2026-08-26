import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  apiArtifacts,
  artifactAttrs,
  contentsOf,
  expandParent,
  hasAlchemyLabelMap,
  ignoreGone,
  listApis,
  listChildResources,
  locationParent,
  missingGet,
  namedOf,
  normalizeLocation,
  reconcileArtifact,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
} from "./internal.ts";

export type ApisArtifactProps = {
  /**
   * Parent API. Full name
   * `projects/{project}/locations/{location}/apis/{api}` or the API id
   * (combined with `location`). Immutable — changing it replaces the
   * artifact.
   */
  api: string;
  /**
   * Artifact id (the `{artifact}` segment of
   * `.../apis/{api}/artifacts/{artifact}`). If omitted, a unique id is
   * generated. Immutable — changing it replaces the artifact.
   */
  artifactId?: string;
  /**
   * Location used when `api` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Media type (`text/plain`, `application/json`, …).
   * @default "text/plain"
   */
  mimeType?: string;
  /**
   * Artifact document as UTF-8 text. Alchemy base64-encodes it for the
   * API. Input-only — updates send a new document when this field
   * changes.
   */
  contents?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Non-identifying metadata. Not used for ownership.
   */
  annotations?: Record<string, string>;
};

export type ApisArtifact = Resource<
  "GCP.Apigeeregistry.ApisArtifact",
  ApisArtifactProps,
  {
    /** Full resource name. */
    name: string;
    /** Artifact id (last path segment). */
    artifactId: string;
    /** Parent API resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Media type. */
    mimeType: string | undefined;
    /** Size in bytes of the uncompressed artifact. */
    sizeBytes: number | undefined;
    /** SHA-256 of the uncompressed artifact contents. */
    hash: string | undefined;
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
 * An Apigee Registry artifact attached to an API.
 *
 * Parent API, location, and id are immutable. Mime type, contents,
 * labels, and annotations replace in place.
 *
 * ### Creating an API Artifact
 * **Example:** JSON manifest
 * ```typescript
 * const artifact = yield* GCP.Apigeeregistry.ApisArtifact("Manifest", {
 *   api: api.name,
 *   mimeType: "application/json",
 *   contents: JSON.stringify({ kind: "manifest" }),
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const ApisArtifact = Resource<ApisArtifact>(
  "GCP.Apigeeregistry.ApisArtifact",
);

const parentApi = (api: string, project: string, location: string) =>
  expandParent(api, project, location, "apis");

const resourceName = (parent: string, artifactId: string) =>
  `${parent}/artifacts/${artifactId}`;

const getByName = missingGet(registry.getProjectsLocationsApisArtifacts);
const getContents = contentsOf(
  registry.getContentsProjectsLocationsApisArtifacts,
);

export const ApisArtifactProvider = () =>
  Provider.succeed(ApisArtifact, {
    stables: [
      "name",
      "artifactId",
      "parent",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return replaceOnIdentity({
        previousId: olds?.artifactId ?? output?.artifactId,
        nextId: news.artifactId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: location,
        previousParent: olds?.api ?? output?.parent,
        nextParent: parentApi(news.api, env.project, location),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const artifactId = yield* toPhysicalId(
        id,
        olds?.artifactId,
        output?.artifactId,
      );
      const parent =
        olds?.api !== undefined
          ? parentApi(olds.api, env.project, location)
          : (output?.parent ?? "");
      const name =
        output?.name ?? (parent ? resourceName(parent, artifactId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = artifactAttrs(existing, env.project);
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
        const items = yield* listChildResources(namedOf(apis), apiArtifacts);
        return items
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => artifactAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = parentApi(news.api, env.project, location);
      const artifactId = yield* toPhysicalId(
        id,
        news.artifactId,
        output?.artifactId,
      );
      const name = output?.name ?? resourceName(parent, artifactId);
      const current = yield* reconcileArtifact({
        id,
        name,
        parent,
        artifactId,
        news,
        ops: {
          get: getByName,
          create: (input) =>
            retryTransient(
              registry.createProjectsLocationsApisArtifacts({
                parent: input.parent,
                artifactId: input.artifactId,
                body: input.body,
              }),
            ).pipe(
              Effect.catchTag("Conflict", () =>
                getByName(resourceName(input.parent, input.artifactId)),
              ),
            ),
          replace: (input) =>
            retryTransient(
              registry.replaceArtifactProjectsLocationsApisArtifacts({
                name: input.name,
                body: input.body,
              }),
            ),
          delete: (artifactName) =>
            ignoreGone(
              registry.deleteProjectsLocationsApisArtifacts({
                name: artifactName,
              }),
            ),
          getContents,
        },
      });
      return artifactAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        registry.deleteProjectsLocationsApisArtifacts({ name: output.name }),
      );
    }),
  });
