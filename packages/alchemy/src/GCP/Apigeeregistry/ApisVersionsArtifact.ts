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
  listApis,
  listChildResources,
  listVersions,
  locationParent,
  missingGet,
  namedOf,
  reconcileArtifact,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
  versionArtifacts,
} from "./internal.ts";

export type ApisVersionsArtifactProps = {
  /**
   * Parent version. Full name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}`.
   * Immutable — changing it replaces the artifact.
   */
  version: string;
  /**
   * Artifact id (the `{artifact}` segment of
   * `.../versions/{version}/artifacts/{artifact}`). If omitted, a unique
   * id is generated. Immutable — changing it replaces the artifact.
   */
  artifactId?: string;
  /**
   * Location used when parsing parent names.
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

export type ApisVersionsArtifact = Resource<
  "GCP.Apigeeregistry.ApisVersionsArtifact",
  ApisVersionsArtifactProps,
  {
    /** Full resource name. */
    name: string;
    /** Artifact id (last path segment). */
    artifactId: string;
    /** Parent version resource name. */
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
 * An Apigee Registry artifact attached to an API version.
 *
 * Parent version and id are immutable. Mime type, contents, labels, and
 * annotations replace in place.
 *
 * ### Creating a Version Artifact
 * **Example:** JSON manifest
 * ```typescript
 * const artifact = yield* GCP.Apigeeregistry.ApisVersionsArtifact(
 *   "Manifest",
 *   {
 *     version: version.name,
 *     mimeType: "application/json",
 *     contents: JSON.stringify({ kind: "version-manifest" }),
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const ApisVersionsArtifact = Resource<ApisVersionsArtifact>(
  "GCP.Apigeeregistry.ApisVersionsArtifact",
);

const resourceName = (parent: string, artifactId: string) =>
  `${parent}/artifacts/${artifactId}`;

const getByName = missingGet(
  registry.getProjectsLocationsApisVersionsArtifacts,
);
const getContents = contentsOf(
  registry.getContentsProjectsLocationsApisVersionsArtifacts,
);

export const ApisVersionsArtifactProvider = () =>
  Provider.succeed(ApisVersionsArtifact, {
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
        previousParent: olds?.version ?? output?.parent,
        nextParent: news.version,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const artifactId = yield* toPhysicalId(
        id,
        olds?.artifactId,
        output?.artifactId,
      );
      const parent = olds?.version ?? output?.parent ?? "";
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
        const versions = yield* listChildResources(namedOf(apis), listVersions);
        const items = yield* listChildResources(
          namedOf(versions),
          versionArtifacts,
        );
        return items
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => artifactAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = news.version.replace(/\/+$/, "");
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
              registry.createProjectsLocationsApisVersionsArtifacts({
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
              registry.replaceArtifactProjectsLocationsApisVersionsArtifacts({
                name: input.name,
                body: input.body,
              }),
            ),
          delete: (artifactName) =>
            ignoreGone(
              registry.deleteProjectsLocationsApisVersionsArtifacts({
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
        registry.deleteProjectsLocationsApisVersionsArtifacts({
          name: output.name,
        }),
      );
    }),
  });
