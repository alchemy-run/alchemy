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
  artifactAttrs,
  contentsOf,
  hasAlchemyLabelMap,
  ignoreGone,
  locationArtifacts,
  locationParent,
  missingGet,
  normalizeLocation,
  reconcileArtifact,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
} from "./internal.ts";

export type ArtifactProps = {
  /**
   * Artifact id (the `{artifact}` segment of
   * `projects/{project}/locations/{location}/artifacts/{artifact}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the artifact.
   */
  artifactId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * artifact.
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

export type Artifact = Resource<
  "GCP.Apigeeregistry.Artifact",
  ArtifactProps,
  {
    /** Full resource name. */
    name: string;
    /** Artifact id (last path segment). */
    artifactId: string;
    /** Parent location resource name. */
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
 * A location-scoped Apigee Registry artifact. Artifacts store metadata
 * too large to keep on the parent resource.
 *
 * Location and id are immutable. Mime type, contents, labels, and
 * annotations replace in place.
 *
 * ### Creating an Artifact
 * **Example:** Generated id
 * ```typescript
 * const artifact = yield* GCP.Apigeeregistry.Artifact("Manifest", {
 *   mimeType: "application/json",
 *   contents: JSON.stringify({ kind: "manifest" }),
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const Artifact = Resource<Artifact>("GCP.Apigeeregistry.Artifact");

const resourceName = (parent: string, artifactId: string) =>
  `${parent}/artifacts/${artifactId}`;

const getByName = missingGet(registry.getProjectsLocationsArtifacts);
const getContents = contentsOf(registry.getContentsProjectsLocationsArtifacts);

export const ArtifactProvider = () =>
  Provider.succeed(Artifact, {
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
      return replaceOnIdentity({
        previousId: olds?.artifactId ?? output?.artifactId,
        nextId: news.artifactId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
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
      const parent = locationParent(env.project, location);
      const name = output?.name ?? resourceName(parent, artifactId);
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
        const items = yield* locationArtifacts(
          locationParent(env.project, DEFAULT_LOCATION),
        );
        return items
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => artifactAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = locationParent(env.project, location);
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
              registry.createProjectsLocationsArtifacts({
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
              registry.replaceArtifactProjectsLocationsArtifacts({
                name: input.name,
                body: input.body,
              }),
            ),
          delete: (artifactName) =>
            ignoreGone(
              registry.deleteProjectsLocationsArtifacts({ name: artifactName }),
            ),
          getContents,
        },
      });
      return artifactAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        registry.deleteProjectsLocationsArtifacts({ name: output.name }),
      );
    }),
  });
