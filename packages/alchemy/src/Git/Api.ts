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
 * import { Tokens } from "alchemy/Git";
 * Tokens.revoke; // HttpApiEndpoint.delete("revoke", ...)
 * ```
 *
 * Shared schemas, tagged errors, and the `Credentials`/`GitAuth` services
 * live in `api/Schema.ts` and are re-exported flatly from here.
 *
 * The git wire protocol (`/:owner/:repo.git/info/refs`,
 * `git-upload-pack`, `git-receive-pack`) and the raw streaming blob/file
 * reads are deliberately NOT part of this contract — they are registered
 * as raw `HttpRouter` routes on the same router (see `GitWorker.ts`),
 * keeping binary streaming out of schema land.
 */
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import ObjectsGroup from "./api/Objects.ts";
import PullsGroup from "./api/Pulls.ts";
import RefsGroup from "./api/Refs.ts";
import ReposGroup from "./api/Repos.ts";
import TokensGroup from "./api/Tokens.ts";

export * from "./api/Schema.ts";
export * as Objects from "./api/Objects.ts";
export * as Pulls from "./api/Pulls.ts";
export * as Refs from "./api/Refs.ts";
export * as Repos from "./api/Repos.ts";
export * as Tokens from "./api/Tokens.ts";

/**
 * The complete git-service management-plane API, mounted at `/api/v1`.
 *
 * Authorization matrix (enforced in the Repo DO, DESIGN.md §8):
 * admin key → everything; repo `admin` token → its repo's write + token
 * create/list/revoke + repo update/delete; `write` → its repo's reads +
 * receive-pack + ref writes; `read` → its repo's reads + upload-pack
 * only. Repo create / list-all / fork / import are admin-key-only.
 */
export const GitApi = HttpApi.make("git-service")
  .add(ReposGroup)
  .add(RefsGroup)
  .add(ObjectsGroup)
  .add(PullsGroup)
  .add(TokensGroup)
  .prefix("/api/v1");
