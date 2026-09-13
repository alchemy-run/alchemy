/**
 * The Worker that serves the API: Better Auth's routes under `/api/auth`,
 * the git server for everything else. `src/worker.ts` fronts it on the
 * website's origin.
 */
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import { Auth, AuthDb } from "./auth.ts";
import { GitLive } from "./git.ts";

export default class GitHost extends Cloudflare.Worker<GitHost>()(
  "GitHost",
  {
    main: import.meta.url,
    ...Git.GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const auth = yield* Auth;
    const git = yield* Git.Server;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/auth")) return yield* auth.fetch;
        return yield* git.fetch;
      }),
    };
  }).pipe(Effect.provide(GitLive), Effect.provide(CloudflareD1(AuthDb))),
) {}
