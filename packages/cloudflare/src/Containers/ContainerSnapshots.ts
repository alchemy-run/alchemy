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

/** One tag of a container snapshot image in the account registry. */
export interface SnapshotImageTag {
  /** `<account>/cloudchamber-snapshots/<id>` */
  repository: string;
  tag: string;
}

const registryHost = "registry.cloudflare.com";
const deploymentIdAnnotation = "io.cloudflare.cloudchamber.deployment_id";

/** A registry client authenticated with short-lived push credentials. */
const makeRegistry = Effect.fn(function* (accountId: string) {
  const http = yield* HttpClient.HttpClient;
  const credentials = yield* Containers.createContainerRegistryCredentials({
    accountId,
    domain: registryHost,
    permissions: ["pull", "push"],
    expirationMinutes: 15,
  });
  const { username } = credentials;
  const fail = (message: string, cause?: unknown) =>
    ContainerSnapshotCleanupError.make({ message, cause });

  /** Send a request; resolves `undefined` on 404, fails on any other non-2xx. */
  const registry: Registry = (method, path) =>
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
        Effect.mapError((cause) => fail(`Container registry ${method} ${path} failed`, cause)),
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(undefined)
            : response.status >= 200 && response.status < 300
              ? Effect.succeed(response)
              : Effect.fail(
                  fail(`Container registry ${method} ${path} returned HTTP ${response.status}`),
                ),
        ),
      );
  return registry;
});

type Registry = (
  method: "GET" | "DELETE" | "PUT",
  path: string,
) => Effect.Effect<
  HttpClientResponse.HttpClientResponse | undefined,
  ContainerSnapshotCleanupError
>;

const readJson = (response: HttpClientResponse.HttpClientResponse, what: string) =>
  response.json.pipe(
    Effect.mapError((cause) =>
      ContainerSnapshotCleanupError.make({ message: `Could not read ${what}`, cause }),
    ),
  );

const listTags = Effect.fn(function* (
  registry: Registry,
  accountId: string,
  durableObjectIds: ReadonlySet<string>,
) {
  const repositoryPrefix = `${accountId}/cloudchamber-snapshots/`;
  const tags: Array<SnapshotImageTag> = [];
  let page: string | undefined = "/v2/_catalog?n=1000&tags=true";
  while (page !== undefined) {
    const response: HttpClientResponse.HttpClientResponse | undefined = yield* registry(
      "GET",
      page,
    );
    if (response === undefined) break;
    const catalog = (yield* readJson(response, "the registry catalog")) as {
      repositories?: Record<string, ReadonlyArray<string>>;
    };
    for (const [repository, repositoryTags] of Object.entries(catalog.repositories ?? {})) {
      if (!repository.startsWith(repositoryPrefix)) continue;
      for (const tag of repositoryTags) tags.push({ repository, tag });
    }
    // `Link: <url>; rel="next"`; Cloudflare's registry omits the brackets.
    const next: string | undefined = /<?([^<>;\s]+)>?\s*;\s*rel="?next"?/.exec(
      response.headers.link ?? "",
    )?.[1];
    const nextUrl: URL | undefined =
      next === undefined ? undefined : new URL(next, `https://${registryHost}`);
    page = nextUrl === undefined ? undefined : nextUrl.pathname + nextUrl.search;
  }

  // A snapshot's manifest records the Durable Object that took it.
  return yield* Effect.filter(
    tags,
    Effect.fn(function* ({ repository, tag }) {
      const response = yield* registry("GET", `/v2/${repository}/manifests/${tag}`);
      if (response === undefined) return false;
      const manifest = (yield* readJson(response, `manifest ${repository}:${tag}`)) as {
        annotations?: Record<string, string>;
      };
      return durableObjectIds.has(manifest.annotations?.[deploymentIdAnnotation] ?? "");
    }),
    { concurrency: 8 },
  );
});

/**
 * List the registry tags of every container snapshot taken by the given
 * Durable Objects.
 *
 * `ctx.container.snapshotContainer()` stores a snapshot in the account
 * registry under `<account>/cloudchamber-snapshots/<id>` as one manifest with
 * several tags (`rootfs-set-…`, `rootfs-snapshot-…`, `sha256:…`). The
 * manifest's `deployment_id` annotation is the id of the Durable Object that
 * took it.
 */
export const listSnapshotImages = Effect.fn("listSnapshotImages")(function* (
  accountId: string,
  durableObjectIds: Iterable<string>,
) {
  const ids = new Set(durableObjectIds);
  if (ids.size === 0) return [];
  const registry = yield* makeRegistry(accountId);
  return yield* listTags(registry, accountId, ids);
});

/** The ids of the Durable Objects a container application has assigned. */
export const listApplicationDurableObjects = (accountId: string, applicationId: string) =>
  Containers.listContainerApplicationInstances.items({ accountId, applicationId }).pipe(
    Stream.map((object) => object.id),
    Stream.runCollect,
  );

/**
 * Delete the registry images of every container snapshot an application's
 * Durable Objects took. Cloudflare keeps them after the application is
 * deleted.
 *
 * Deleting a tag removes only that tag, so every tag goes, digest tags last,
 * before layers are collected. A tag that is already gone is skipped, so an
 * interrupted delete finishes on the next run.
 */
export const deleteSnapshotImages = Effect.fn("deleteSnapshotImages")(function* (
  accountId: string,
  applicationId: string,
) {
  const ids = new Set(yield* listApplicationDurableObjects(accountId, applicationId));
  if (ids.size === 0) return;
  const registry = yield* makeRegistry(accountId);
  const owned = yield* listTags(registry, accountId, ids);
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
