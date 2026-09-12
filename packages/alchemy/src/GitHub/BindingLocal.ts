/**
 * Shared scaffolding for the GitHub `*Local` binding implementations —
 * the GitHub analogue of the Cloudflare `{Cap}Local.ts` convention.
 *
 * Instead of capturing a {@link PersonalAccessToken} resource and
 * binding its value into a host (the `*Http` path), `make(op)` runs the
 * SAME operation off the provider's ambient {@link GitHubCredentials} —
 * the laptop factory, Actions, and tests authenticate with whatever
 * `alchemy login` / `GITHUB_TOKEN` resolved, no resource, no bind.
 *
 * NOT exported from `index.ts` (internal scaffolding).
 */
import * as Effect from "effect/Effect";
import { type Operation, makeOperationClient } from "./BindingHttp.ts";
import { GitHubCredentials } from "./Credentials.ts";

/**
 * Build the ambient-credentials implementation Effect of a GitHub
 * binding — pass the result straight to `Layer.effect(Tag, …)`:
 *
 * ```ts
 * export const ListIssuesLocal = Layer.effect(
 *   ListIssues,
 *   BindingLocal.make(listIssuesOperation),
 * );
 * ```
 */
export const make = <Request extends ReadonlyArray<any>, Out, E>(
  op: Operation<Request, Out, E>,
) =>
  Effect.gen(function* () {
    const credentials = yield* yield* GitHubCredentials;
    const octokit = credentials.octokit();
    return makeOperationClient(op, Effect.succeed(octokit));
  });
