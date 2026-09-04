/**
 * The typed HTTP contract for git-service (DESIGN.md §5): every plane as
 * one Effect `HttpApi`, so the Worker, the clients
 * (`HttpApiClient.make(GitApi, ...)`), and OpenAPI share one schema-checked
 * surface.
 *
 * Every endpoint is an `alchemy/Http` route class: an `HttpApiEndpoint`
 * that also names the tag of its implementation, so any route can be
 * swapped by providing a different Layer for its tag. The groups are
 * classes too, and exported, so an API can be built from a subset.
 *
 * | Group | Path | Routes |
 * | --- | --- | --- |
 * | {@link Repos} | `/api/v1/repos` | create, get, update, list, delete, fork, import, compact |
 * | {@link Refs} | `/api/v1/repos/:owner/:repo/ref(s)` | list, get, update, remove |
 * | {@link Objects} | `/api/v1/repos/:owner/:repo/…` | commit, log, tree, blob, diff, compare, blobRaw, file |
 * | {@link Pulls} | `/api/v1/repos/:owner/:repo/pulls` | create, list, get, update, merge |
 * | {@link Protocol} | `/:owner/:repo/…` | infoRefs, uploadPack, receivePack |
 * | {@link GitHub} | `/api/v3` | the GitHub REST v3 facade |
 *
 * No route carries middleware: who may call it is decided by the API that
 * mounts it (`Git.Api.middleware(Yours)`). The engine's own hash route is
 * {@link InternalApi}, mounted separately. Shared schemas and tagged
 * errors live in `Api/Schema.ts` and are re-exported flatly from here.
 */
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import { GitHub } from "./Api/GitHub.ts";
import { Objects } from "./Api/Objects.ts";
import { Protocol } from "./Api/Protocol.ts";
import { Pulls } from "./Api/Pulls.ts";
import { Refs } from "./Api/Refs.ts";
import { Repos } from "./Api/Repos.ts";

export * from "./Api/Schema.ts";
export * from "./Api/GitHub.ts";
export * from "./Api/Internal.ts";
export * from "./Api/Objects.ts";
export * from "./Api/Protocol.ts";
export * from "./Api/Pulls.ts";
export * from "./Api/Refs.ts";
export * from "./Api/Repos.ts";

/**
 * The complete git-service API: the REST plane at `/api/v1`, the git wire
 * protocol at the root, and the GitHub facade at `/api/v3`. Derive yours
 * from it (`Git.Api.add(...)`) or build one from the groups.
 */
export class GitApi extends HttpApi.make("git-service")
  .add(Repos)
  .add(Refs)
  .add(Objects)
  .add(Pulls)
  .add(Protocol)
  .add(GitHub) {}

/**
 * Whether a request to one of the engine's routes only reads: the REST
 * and raw reads, the GitHub facade's `GET`s, the ref advertisement for a
 * fetch, and `git-upload-pack`. The advertisement for a push
 * (`info/refs?service=git-receive-pack`) is not a read. A middleware that
 * lets anonymous callers read public repositories asks this.
 *
 * ```typescript
 * (httpEffect, { endpoint }) =>
 *   Effect.gen(function* () {
 *     const request = yield* HttpServerRequest.HttpServerRequest;
 *     if (Git.isRead(endpoint, request) && (yield* isPublic)) return yield* httpEffect;
 *     // …
 *   })
 * ```
 */
export const isRead = (
  endpoint: HttpApiEndpoint.Top,
  request: HttpServerRequest.HttpServerRequest,
): boolean => {
  if (endpoint.identifier === "uploadPack") return true;
  if (endpoint.method !== "GET") return false;
  if (endpoint.identifier !== "infoRefs") return true;
  const service = new URL(request.url, "http://localhost").searchParams.get(
    "service",
  );
  return service !== "git-receive-pack";
};
