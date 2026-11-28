import * as E2B from "@alchemy.run/e2b";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Repo } from "./e2b-git.ts";

/**
 * A sandbox program with a credentialed binding and no gateway: the GitHub
 * token would be readable in the sandbox, so its deploy is refused.
 */
export default class UnguardedSandbox extends E2B.Template<UnguardedSandbox>()(
  "GatewayUnguardedSandbox",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const listIssues = yield* GitHub.ListIssues(Repo);
    return {
      fetch: Effect.gen(function* () {
        const issues = yield* listIssues({ per_page: 1 });
        return yield* HttpServerResponse.json({ listed: issues.length });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GitHub.ListIssuesHttp)),
) {}
