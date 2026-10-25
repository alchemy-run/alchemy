import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

/** The registry every binding route works on. Module-scope so the test stack yields it too. */
export const BindingsRegistry = Azure.ContainerRegistry.Registry("AcrBindingsRegistry", {});

/** OCI media type of the manifests the routes push and read. */
export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const flag = (value: string | null) => (value === null ? undefined : value === "true");

/**
 * Effect Function with one route per Container Registry binding. Routes
 * take `repo` and, per operation, `ref` (tag or digest), `digest`, `body`
 * (UTF-8 text), `manifest` (the manifest JSON), and attribute flags. They
 * answer `{ ok, result | error }` with a 500 on error, so a caller retries
 * through role propagation and a real failure shows the registry error.
 */
export default class AcrBindingsFunction extends Azure.Functions.Function<AcrBindingsFunction>()(
  "AcrBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const registry = yield* BindingsRegistry;
    const getManifest = yield* Azure.ContainerRegistry.GetManifest(registry);
    const getBlob = yield* Azure.ContainerRegistry.GetBlob(registry);
    const putManifest = yield* Azure.ContainerRegistry.PutManifest(registry);
    const uploadBlob = yield* Azure.ContainerRegistry.UploadBlob(registry);
    const getRepositoryProperties =
      yield* Azure.ContainerRegistry.GetRepositoryProperties(registry);
    const updateRepositoryProperties =
      yield* Azure.ContainerRegistry.UpdateRepositoryProperties(registry);
    const deleteRepository = yield* Azure.ContainerRegistry.DeleteRepository(registry);
    const listRepositories = yield* Azure.ContainerRegistry.ListRepositories(registry);
    const listTags = yield* Azure.ContainerRegistry.ListTags(registry);
    const getTagProperties = yield* Azure.ContainerRegistry.GetTagProperties(registry);
    const updateTagAttributes = yield* Azure.ContainerRegistry.UpdateTagAttributes(registry);
    const deleteTag = yield* Azure.ContainerRegistry.DeleteTag(registry);
    const listManifests = yield* Azure.ContainerRegistry.ListManifests(registry);
    const getManifestProperties = yield* Azure.ContainerRegistry.GetManifestProperties(registry);
    const updateManifestProperties =
      yield* Azure.ContainerRegistry.UpdateManifestProperties(registry);
    const deleteManifest = yield* Azure.ContainerRegistry.DeleteManifest(registry);
    const deleteBlob = yield* Azure.ContainerRegistry.DeleteBlob(registry);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const q = (key: string) => url.searchParams.get(key) ?? "";
        const name = q("repo");
        const attributes = {
          deleteEnabled: flag(url.searchParams.get("deleteEnabled")),
          writeEnabled: flag(url.searchParams.get("writeEnabled")),
        };
        switch (url.pathname) {
          case "/manifest":
            return yield* respond(
              Effect.map(getManifest({ name, reference: q("ref") }), (m) => ({
                mediaType: m.mediaType,
                configDigest: m.config?.digest,
                digest: m.dockerContentDigest,
              })),
            );
          case "/blob":
            return yield* respond(
              Effect.map(getBlob({ name, digest: q("digest") }), (b) => ({
                text: new TextDecoder().decode(b.body),
              })),
            );
          case "/put-manifest":
            return yield* respond(
              Effect.map(
                putManifest({
                  name,
                  reference: q("ref"),
                  contentType: OCI_MANIFEST,
                  payload: new TextEncoder().encode(q("manifest")),
                }),
                (r) => ({ digest: r.dockerContentDigest }),
              ),
            );
          case "/upload":
            return yield* respond(uploadBlob({ name, body: new TextEncoder().encode(q("body")) }));
          case "/repo":
            return yield* respond(
              Effect.map(getRepositoryProperties({ name }), (r) => ({
                imageName: r.imageName,
                tagCount: r.tagCount,
                manifestCount: r.manifestCount,
              })),
            );
          case "/repo-update":
            return yield* respond(
              Effect.map(updateRepositoryProperties({ name, ...attributes }), (r) => ({
                changeableAttributes: r.changeableAttributes,
              })),
            );
          case "/repo-delete":
            return yield* respond(Effect.as(deleteRepository({ name }), { deleted: name }));
          case "/repos":
            return yield* respond(
              Effect.map(listRepositories(), (r) => ({ repositories: r.repositories })),
            );
          case "/tags":
            return yield* respond(
              Effect.map(listTags({ name }), (r) => ({ tags: r.tags.map((t) => t.name).sort() })),
            );
          case "/tag":
            return yield* respond(
              Effect.map(getTagProperties({ name, reference: q("ref") }), (r) => ({
                name: r.tag.name,
                digest: r.tag.digest,
              })),
            );
          case "/tag-update":
            return yield* respond(
              Effect.map(
                updateTagAttributes({ name, reference: q("ref"), ...attributes }),
                (r) => ({
                  changeableAttributes: r.tag.changeableAttributes,
                }),
              ),
            );
          case "/tag-delete":
            return yield* respond(
              Effect.as(deleteTag({ name, reference: q("ref") }), { deleted: q("ref") }),
            );
          case "/manifests":
            return yield* respond(
              Effect.map(listManifests({ name }), (r) => ({
                digests: (r.manifests ?? []).map((m) => m.digest).sort(),
              })),
            );
          case "/manifest-props":
            return yield* respond(
              Effect.map(getManifestProperties({ name, digest: q("digest") }), (r) => ({
                digest: r.manifest.digest,
                tags: r.manifest.tags,
              })),
            );
          case "/manifest-update":
            return yield* respond(
              Effect.map(
                updateManifestProperties({ name, digest: q("digest"), ...attributes }),
                (r) => ({ changeableAttributes: r.manifest.changeableAttributes }),
              ),
            );
          case "/manifest-delete":
            return yield* respond(
              Effect.as(deleteManifest({ name, reference: q("digest") }), {
                deleted: q("digest"),
              }),
            );
          case "/blob-delete":
            return yield* respond(
              Effect.as(deleteBlob({ name, digest: q("digest") }), { deleted: q("digest") }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ContainerRegistry.GetManifestHttp,
        Azure.ContainerRegistry.GetBlobHttp,
        Azure.ContainerRegistry.PutManifestHttp,
        Azure.ContainerRegistry.UploadBlobHttp,
        Azure.ContainerRegistry.GetRepositoryPropertiesHttp,
        Azure.ContainerRegistry.UpdateRepositoryPropertiesHttp,
        Azure.ContainerRegistry.DeleteRepositoryHttp,
        Azure.ContainerRegistry.ListRepositoriesHttp,
        Azure.ContainerRegistry.ListTagsHttp,
        Azure.ContainerRegistry.GetTagPropertiesHttp,
        Azure.ContainerRegistry.UpdateTagAttributesHttp,
        Azure.ContainerRegistry.DeleteTagHttp,
        Azure.ContainerRegistry.ListManifestsHttp,
        Azure.ContainerRegistry.GetManifestPropertiesHttp,
        Azure.ContainerRegistry.UpdateManifestPropertiesHttp,
        Azure.ContainerRegistry.DeleteManifestHttp,
        Azure.ContainerRegistry.DeleteBlobHttp,
      ),
    ),
  ),
) {}
