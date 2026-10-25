import { createHash } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import AcrBindingsFunction, { BindingsRegistry, OCI_MANIFEST } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureAcrBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AcrBindingsFunction;
    const registry = yield* BindingsRegistry;
    return { url: fn.url, loginServer: registry.loginServer };
  }),
);

// Basic registry (~$0.17/day, billed per day) + a Flex Consumption app;
// ~4 min deploy, ~2 min destroy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

/** Azure credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (a few minutes), then return the last
 * answer so a real failure shows its registry error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const endpoint = Effect.map(stack, ({ loginServer }) => `https://${loginServer}`);

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array) =>
  Effect.sync(() => `sha256:${createHash("sha256").update(data).digest("hex")}`);

/** Upload `data` to `repo` out of band; returns its digest. */
const uploadOutOfBand = (repo: string, data: Uint8Array) =>
  Effect.gen(function* () {
    const at = yield* endpoint;
    const digest = yield* sha256(data);
    const started = yield* acr.ContainerRegistryBlobStartUpload({ endpoint: at, name: repo });
    yield* acr.UploadContainerRegistryBlobComplete({
      endpoint: at,
      nextBlobUuidLink: started.location ?? "",
      digest,
      body: data,
    });
    return digest;
  });

/** An OCI artifact manifest over an empty config and one layer. */
const manifestOf = (config: string, layer: { digest: string; size: number }) =>
  JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    artifactType: "application/vnd.alchemy.test",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: config, size: 2 },
    layers: [{ mediaType: "application/octet-stream", ...layer }],
  });

/**
 * Push `repo:<tag>` out of band: the empty config, a layer holding
 * `layer`, and the manifest. Returns the digests.
 */
const seed = (repo: string, tag: string, layer = repo) =>
  Effect.gen(function* () {
    const at = yield* endpoint;
    const config = yield* uploadOutOfBand(repo, bytes("{}"));
    const layerBytes = bytes(layer);
    const layerDigest = yield* uploadOutOfBand(repo, layerBytes);
    const manifest = manifestOf(config, { digest: layerDigest, size: layerBytes.length });
    const put = yield* acr.CreateContainerRegistryManifest({
      endpoint: at,
      name: repo,
      reference: tag,
      payload: bytes(manifest),
      contentType: OCI_MANIFEST,
    });
    const digest = yield* sha256(bytes(manifest));
    expect(put.dockerContentDigest).toEqual(digest);
    return { config, layerDigest, digest, manifest };
  });

/** Delete `repo` out of band; a missing one is fine. */
const removeRepo = (repo: string) =>
  Effect.gen(function* () {
    const at = yield* endpoint;
    yield* acr
      .DeleteContainerRegistryRepository({ endpoint: at, name: repo })
      .pipe(Effect.catchTag("ContainerRegistryRepositoryNotFound", () => Effect.void));
  });

/** The `_tag` of the out-of-band call's failure, or `"found"`. */
const failureTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("found"),
    Effect.catch((e) => Effect.succeed(e._tag)),
  );

const live = { timeout: 600_000 };

describe(
  "Container Registry bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:containerregistry", "live"] },
  () => {
    describe("ContainerRegistry.GetManifest", () => {
      test(
        "reads a manifest by tag",
        Effect.gen(function* () {
          const seeded = yield* seed("bindings/get-manifest", "v1");
          const body = yield* call("/manifest?repo=bindings/get-manifest&ref=v1");
          expectOk(body);
          expect(body.result).toEqual({
            mediaType: OCI_MANIFEST,
            configDigest: seeded.config,
            digest: seeded.digest,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.GetBlob", () => {
      test(
        "downloads a layer by digest",
        Effect.gen(function* () {
          const seeded = yield* seed("bindings/get-blob", "v1", "layer-bytes");
          const body = yield* call(`/blob?repo=bindings/get-blob&digest=${seeded.layerDigest}`);
          expectOk(body);
          expect(body.result).toEqual({ text: "layer-bytes" });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.PutManifest", () => {
      test(
        "pushes a manifest under a new tag",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const seeded = yield* seed("bindings/put-manifest", "v1");
          const body = yield* call(
            `/put-manifest?repo=bindings/put-manifest&ref=v2&manifest=${encodeURIComponent(seeded.manifest)}`,
          );
          expectOk(body);
          expect(body.result).toEqual({ digest: seeded.digest });
          const tag = yield* acr.GetContainerRegistryTagProperties({
            endpoint: at,
            name: "bindings/put-manifest",
            reference: "v2",
          });
          expect(tag.tag.digest).toEqual(seeded.digest);
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.UploadBlob", () => {
      test(
        "uploads a blob in one request",
        Effect.gen(function* () {
          const at = yield* endpoint;
          // The repository exists once a manifest is in it.
          yield* seed("bindings/upload-blob", "v1");
          const body = yield* call("/upload?repo=bindings/upload-blob&body=uploaded-bytes");
          expectOk(body);
          const digest = yield* sha256(bytes("uploaded-bytes"));
          expect(body.result.digest).toEqual(digest);
          const blob = yield* acr.GetContainerRegistryBlobBlob({
            endpoint: at,
            name: "bindings/upload-blob",
            digest,
          });
          expect(new TextDecoder().decode(blob.body)).toEqual("uploaded-bytes");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.GetRepositoryProperties", () => {
      test(
        "reads repository counts",
        Effect.gen(function* () {
          yield* removeRepo("bindings/repo-props");
          yield* seed("bindings/repo-props", "v1");
          const body = yield* call("/repo?repo=bindings/repo-props");
          expectOk(body);
          expect(body.result).toEqual({
            imageName: "bindings/repo-props",
            tagCount: 1,
            manifestCount: 1,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.UpdateRepositoryProperties", () => {
      test(
        "locks a repository against writes",
        Effect.gen(function* () {
          const at = yield* endpoint;
          yield* seed("bindings/repo-update", "v1");
          const body = yield* call("/repo-update?repo=bindings/repo-update&writeEnabled=false");
          expectOk(body);
          const repo = yield* acr.GetContainerRegistryProperties({
            endpoint: at,
            name: "bindings/repo-update",
          });
          expect(repo.changeableAttributes.writeEnabled).toEqual(false);
          expect(repo.changeableAttributes.deleteEnabled).toEqual(true);
          yield* acr.UpdateContainerRegistryProperties({
            endpoint: at,
            name: "bindings/repo-update",
            writeEnabled: true,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.DeleteRepository", () => {
      test(
        "deletes a repository",
        Effect.gen(function* () {
          const at = yield* endpoint;
          yield* seed("bindings/repo-delete", "v1");
          const body = yield* call("/repo-delete?repo=bindings/repo-delete");
          expectOk(body);
          const after = yield* failureTag(
            acr.GetContainerRegistryProperties({ endpoint: at, name: "bindings/repo-delete" }),
          );
          expect(after).toEqual("ContainerRegistryRepositoryNotFound");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.ListRepositories", () => {
      test(
        "lists the registry's repositories",
        Effect.gen(function* () {
          yield* seed("bindings/list-repos", "v1");
          const body = yield* call("/repos");
          expectOk(body);
          expect(body.result.repositories).toContain("bindings/list-repos");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.ListTags", () => {
      test(
        "lists a repository's tags",
        Effect.gen(function* () {
          yield* removeRepo("bindings/list-tags");
          yield* seed("bindings/list-tags", "v1");
          yield* seed("bindings/list-tags", "v2");
          const body = yield* call("/tags?repo=bindings/list-tags");
          expectOk(body);
          expect(body.result).toEqual({ tags: ["v1", "v2"] });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.GetTagProperties", () => {
      test(
        "reads the digest a tag points at",
        Effect.gen(function* () {
          const seeded = yield* seed("bindings/tag-props", "v1");
          const body = yield* call("/tag?repo=bindings/tag-props&ref=v1");
          expectOk(body);
          expect(body.result).toEqual({ name: "v1", digest: seeded.digest });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.UpdateTagAttributes", () => {
      test(
        "locks a tag against deletes",
        Effect.gen(function* () {
          const at = yield* endpoint;
          yield* seed("bindings/tag-update", "v1");
          const body = yield* call(
            "/tag-update?repo=bindings/tag-update&ref=v1&deleteEnabled=false",
          );
          expectOk(body);
          const tag = yield* acr.GetContainerRegistryTagProperties({
            endpoint: at,
            name: "bindings/tag-update",
            reference: "v1",
          });
          expect(tag.tag.changeableAttributes.deleteEnabled).toEqual(false);
          yield* acr.UpdateContainerRegistryTagAttributes({
            endpoint: at,
            name: "bindings/tag-update",
            reference: "v1",
            deleteEnabled: true,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.DeleteTag", () => {
      test(
        "deletes a tag",
        Effect.gen(function* () {
          const at = yield* endpoint;
          yield* seed("bindings/tag-delete", "v1");
          const body = yield* call("/tag-delete?repo=bindings/tag-delete&ref=v1");
          expectOk(body);
          const after = yield* failureTag(
            acr.GetContainerRegistryTagProperties({
              endpoint: at,
              name: "bindings/tag-delete",
              reference: "v1",
            }),
          );
          expect(after).toEqual("ContainerRegistryManifestNotFound");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.ListManifests", () => {
      test(
        "lists a repository's manifests",
        Effect.gen(function* () {
          yield* removeRepo("bindings/list-manifests");
          const seeded = yield* seed("bindings/list-manifests", "v1");
          const body = yield* call("/manifests?repo=bindings/list-manifests");
          expectOk(body);
          expect(body.result).toEqual({ digests: [seeded.digest] });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.GetManifestProperties", () => {
      test(
        "reads a manifest's tags by digest",
        Effect.gen(function* () {
          const seeded = yield* seed("bindings/manifest-props", "v1");
          const body = yield* call(
            `/manifest-props?repo=bindings/manifest-props&digest=${seeded.digest}`,
          );
          expectOk(body);
          expect(body.result).toEqual({ digest: seeded.digest, tags: ["v1"] });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.UpdateManifestProperties", () => {
      test(
        "locks a manifest against deletes",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const seeded = yield* seed("bindings/manifest-update", "v1");
          const body = yield* call(
            `/manifest-update?repo=bindings/manifest-update&digest=${seeded.digest}&deleteEnabled=false`,
          );
          expectOk(body);
          const props = yield* acr.GetContainerRegistryManifestProperties({
            endpoint: at,
            name: "bindings/manifest-update",
            digest: seeded.digest,
          });
          expect(props.manifest.changeableAttributes?.deleteEnabled).toEqual(false);
          yield* acr.UpdateContainerRegistryManifestProperties({
            endpoint: at,
            name: "bindings/manifest-update",
            digest: seeded.digest,
            deleteEnabled: true,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.DeleteManifest", () => {
      test(
        "deletes a manifest by digest",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const seeded = yield* seed("bindings/manifest-delete", "v1");
          const body = yield* call(
            `/manifest-delete?repo=bindings/manifest-delete&digest=${seeded.digest}`,
          );
          expectOk(body);
          const after = yield* failureTag(
            acr.GetContainerRegistryManifest({
              endpoint: at,
              name: "bindings/manifest-delete",
              reference: seeded.digest,
            }),
          );
          expect(after).toEqual("ContainerRegistryManifestNotFound");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("ContainerRegistry.DeleteBlob", () => {
      test(
        "deletes a blob by digest",
        Effect.gen(function* () {
          const at = yield* endpoint;
          yield* seed("bindings/blob-delete", "v1");
          const digest = yield* uploadOutOfBand("bindings/blob-delete", bytes("loose-blob"));
          const body = yield* call(`/blob-delete?repo=bindings/blob-delete&digest=${digest}`);
          expectOk(body);
          const after = yield* failureTag(
            acr.GetContainerRegistryBlobBlob({
              endpoint: at,
              name: "bindings/blob-delete",
              digest,
            }),
          );
          expect(after).toEqual("ContainerRegistryBlobNotFound");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });
  },
);
