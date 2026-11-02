import type * as edge from "@distilled.cloud/stackit/edge";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for Edge Cloud `listCompatibleKubernetesReleases`: the Kubernetes
 * releases that run on a given Talos release. A Talos release it doesn't know fails
 * with the typed `NotFound`.
 *
 * The operation takes no project, and STACKIT's API spec turns authorization off for
 * it, so this binding has no bound resource and grants no role. Provide {@link
 * ListCompatibleKubernetesReleasesHttp}. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * ### Reading the Releases
 * **Example:** List the Kubernetes releases of a Talos release
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listReleases = yield* Stackit.EdgeCloud.ListCompatibleKubernetesReleases();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://worker");
 *         const talosVersion = url.searchParams.get("talos") ?? "";
 *         const releases = yield* listReleases({ talosVersion });
 *         return yield* HttpServerResponse.json(releases.k8s_releases);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.EdgeCloud.ListCompatibleKubernetesReleasesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export interface ListCompatibleKubernetesReleases extends Binding.Service<
  ListCompatibleKubernetesReleases,
  "Stackit.EdgeCloud.ListCompatibleKubernetesReleases",
  () => Effect.Effect<
    (
      request: edge.ListCompatibleKubernetesReleasesRequest,
    ) => Effect.Effect<
      edge.KubernetesReleaseList,
      edge.ListCompatibleKubernetesReleasesError,
      RuntimeContext
    >
  >
> {}

export const ListCompatibleKubernetesReleases = Binding.Service<ListCompatibleKubernetesReleases>(
  "Stackit.EdgeCloud.ListCompatibleKubernetesReleases",
);
