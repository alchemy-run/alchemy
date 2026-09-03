/**
 * The typed REST contract for git-service (DESIGN.md §5).
 *
 * Everything on the management plane — repos, refs, objects, tokens — is
 * declared as an Effect `HttpApi` so that the Worker, the Repo DO
 * handlers, and test clients (`HttpApiClient.make(GitApi, ...)`) all share
 * one schema-checked surface. Each operation is an exported `const` whose
 * identifier matches its wire operation name, namespaced by group:
 *
 * ```typescript
 * import { Repos } from "alchemy/Git";
 * Repos.create; // HttpApiEndpoint.post("create", ...)
 * ```
 *
 * Shared schemas, tagged errors, and the `Credentials`/`GitAuth` services
 * live in `Api/Schema.ts` and are re-exported flatly from here.
 *
 * The git wire protocol (`/:owner/:repo.git/info/refs`,
 * `git-upload-pack`, `git-receive-pack`) and the raw streaming blob/file
 * reads are deliberately NOT part of this contract — they are registered
 * as raw `HttpRouter` routes on the same router (see `GitWorker.ts`),
 * keeping binary streaming out of schema land.
 */
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import ObjectsGroup from "./Api/Objects.ts";
import PullsGroup from "./Api/Pulls.ts";
import RefsGroup from "./Api/Refs.ts";
import ReposGroup from "./Api/Repos.ts";

export * from "./Api/Schema.ts";
export * as Objects from "./Api/Objects.ts";
export * as Pulls from "./Api/Pulls.ts";
export * as Refs from "./Api/Refs.ts";
export * as Repos from "./Api/Repos.ts";

/**
 * The complete git-service management-plane API, mounted at `/api/v1`.
 *
 * Authorization is `Git.Policy`'s, asked inside the Repo DO with the
 * action's parsed facts. The groups carry no middleware of their own: the
 * `HttpApi` you mount them in decides who the caller is.
 */
export const GitApi = HttpApi.make("git-service")
  .add(ReposGroup)
  .add(RefsGroup)
  .add(ObjectsGroup)
  .add(PullsGroup)
  .prefix("/api/v1");
