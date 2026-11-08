import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class ContainerSnapshotCleanupError extends Schema.TaggedError<ContainerSnapshotCleanupError>()(
  "ContainerSnapshotCleanupError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect({ includeStack: true })),
  },
) {}

const registryHost = "registry.cloudflare.com";

/**
 * Delete the registry images of every container snapshot an application's
 * Durable Objects took.
 *
 * `ctx.container.snapshotContainer()` stores a snapshot in the account
 * registry under `<account>/cloudchamber-snapshots/<id>` as one manifest with
 * several tags (`rootfs-set-…`, `rootfs-snapshot-…`, `sha256:…`), and
 * Cloudflare keeps it after the application is deleted. The manifest's
 * `deployment_id` annotation is the id of the Durable Object that took it.
 * Deleting a tag removes only that tag, so every tag goes, digest tags last,
 * before layers are collected.
 */
export const deleteSnapshotImages = Effect.fn("deleteSnapshotImages")(function* (
  accountId: string,
  applicationId: string,
) {
  const durableObjects = new Set(
    yield* Containers.listContainerApplicationInstances.items({ accountId, applicationId }).pipe(
      Stream.map((object) => object.id),
      Stream.runCollect,
    ),
  );
  if (durableObjects.size === 0) return;
  const http = yield* HttpClient.HttpClient;
  const credentials = yield* Containers.createContainerRegistryCredentials({
    accountId,
    registryId: registryHost,
    permissions: ["pull", "push"],
    expirationMinutes: 15,
  });
  const username = credentials.username ?? credentials.user ?? "";
  const registry = (method: "GET" | "DELETE" | "PUT", path: string) =>
    http
      .execute(
        HttpClientRequest.make(method)(`https://${registryHost}${path}`).pipe(
          HttpClientRequest.basicAuth(username, credentials.password),
          HttpClientRequest.setHeader(
            "Accept",
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          ),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          ContainerSnapshotCleanupError.make({
            message: `Container registry ${method} failed`,
            cause,
          }),
        ),
        Effect.filterOrFail(
          (response) => response.status >= 200 && response.status < 300,
          (response) =>
            ContainerSnapshotCleanupError.make({
              message: `Container registry ${method} returned HTTP ${response.status}`,
            }),
        ),
      );

  const repositoryPrefix = `${accountId}/cloudchamber-snapshots/`;
  const tags: Array<{ repository: string; tag: string }> = [];
  let page: string | undefined = "/v2/_catalog?tags=true";
  while (page !== undefined) {
    const response: HttpClientResponse.HttpClientResponse = yield* registry("GET", page);
    const catalog = (yield* response.json.pipe(Effect.orElseSucceed(() => ({})))) as {
      repositories?: Record<string, ReadonlyArray<string>>;
    };
    for (const [repository, repositoryTags] of Object.entries(catalog.repositories ?? {})) {
      if (!repository.startsWith(repositoryPrefix)) continue;
      for (const tag of repositoryTags) tags.push({ repository, tag });
    }
    const next: string | undefined = /<([^>]+)>;\s*rel="?next"?/.exec(
      response.headers.link ?? "",
    )?.[1];
    const nextUrl: URL | undefined =
      next === undefined ? undefined : new URL(next, `https://${registryHost}`);
    page = nextUrl === undefined ? undefined : nextUrl.pathname + nextUrl.search;
  }

  const owned = yield* Effect.filter(
    tags,
    ({ repository, tag }) =>
      registry("GET", `/v2/${repository}/manifests/${tag}`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((manifest) =>
          durableObjects.has(
            (manifest as { annotations?: Record<string, string> }).annotations?.[
              "io.cloudflare.cloudchamber.deployment_id"
            ] ?? "",
          ),
        ),
        Effect.orElseSucceed(() => false),
      ),
    { concurrency: 8 },
  );
  if (owned.length === 0) return;
  const digestTagsLast = [...owned].sort(
    (a, b) => Number(a.tag.startsWith("sha256:")) - Number(b.tag.startsWith("sha256:")),
  );
  for (const { repository, tag } of digestTagsLast) {
    yield* registry("DELETE", `/v2/${repository}/manifests/${tag}`);
  }
  yield* registry("PUT", "/v2/gc/layers");
  yield* Effect.logInfo(`Cloudflare Container delete: deleted ${owned.length} snapshot image tags`);
});
