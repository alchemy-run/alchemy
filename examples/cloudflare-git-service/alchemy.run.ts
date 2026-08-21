/**
 * Deployable git-service example: a git host assembled from
 * `@alchemy.run/git` building blocks, plus a GitHub-style web UI, on ONE
 * origin.
 *
 * - `src/git-host.ts` — the block assembly: `Git.ServerLive` +
 *   `Git.ReposDurableObject` + `Git.RegistryDurableObject` wired into a
 *   `Cloudflare.Worker` the example owns.
 * - `src/worker.ts` — the site's front door: forwards `/api/v1`,
 *   `/api/v3`, and the git wire paths to the GitHost over a private
 *   service binding; serves the Vite SPA for everything else. Clone URLs
 *   are therefore same-host.
 *
 * Set the deployer admin secret before deploying:
 *
 * ```sh
 * export GIT_SERVICE_ADMIN_TOKEN="$(openssl rand -base64 32)"
 * bun run deploy
 * ```
 *
 * Then open the printed `webUrl` and create a repo — or from the terminal:
 *
 * ```sh
 * curl -X POST "$WEB/api/v1/repos" \
 *   -H "Authorization: Bearer $GIT_SERVICE_ADMIN_TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"acme","name":"web","public":true}'
 *
 * git remote add origin "https://x:gs_...@<host>/acme/web.git"
 * git push origin main
 * ```
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import GitHost from "./src/git-host.ts";

export default Alchemy.Stack(
  "GitServiceExample",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const git = yield* GitHost;

    const web = yield* Cloudflare.Website.Vite("Web", {
      main: "src/worker.ts",
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
      env: {
        GIT: GitHost,
      },
    });

    return { url: git.url.as<string>(), webUrl: web.url };
  }),
);
