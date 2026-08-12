/**
 * Deployable git-service example app: the service plus a GitHub-style
 * web UI for browsing it.
 *
 * Deploys the whole service — the GitWorker front door, the GitRepo and
 * GitRegistry Durable Objects, and the GitObjects R2 bucket — and a Vite
 * React SPA (`index.html` + `src/`) that drives the service's REST API.
 *
 * Set the deployer admin secret before deploying:
 *
 * ```sh
 * export GIT_SERVICE_ADMIN_TOKEN="$(openssl rand -base64 32)"
 * bun run deploy
 * ```
 *
 * Then open the printed `webUrl`, sign in with the admin token, and create
 * a repo — or drive it from the terminal:
 *
 * ```sh
 * curl -X POST "$URL/api/v1/repos" \
 *   -H "Authorization: Bearer $GIT_SERVICE_ADMIN_TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"acme","name":"web"}'
 * # → { repo, remote, token: { token: "gs_..." } }
 *
 * git remote add origin "https://x:gs_...@<host>/acme/web.git"
 * git push origin main
 * ```
 */
import { GitService } from "@alchemy.run/git";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "GitServiceExample",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const git = yield* GitService();

    // The GitHub-style SPA. The service URL is inlined into the client
    // bundle at build time (import.meta.env.VITE_GIT_URL); deep links work
    // because unknown paths fall back to index.html.
    const web = yield* Cloudflare.Website.Vite("Web", {
      assets: { notFoundHandling: "single-page-application" },
      env: {
        VITE_GIT_URL: git.url,
      },
    });

    return { url: git.url, webUrl: web.url };
  }),
);
