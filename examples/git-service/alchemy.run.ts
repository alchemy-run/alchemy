/**
 * Deployable git-service example app.
 *
 * Deploys the whole service — the GitWorker front door, the GitRepo and
 * GitRegistry Durable Objects, and the GitObjects R2 bucket — as one stack.
 *
 * Set the deployer admin secret before deploying:
 *
 * ```sh
 * export GIT_SERVICE_ADMIN_TOKEN="$(openssl rand -base64 32)"
 * bun run deploy
 * ```
 *
 * Then create a repo and push to it:
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
import { GitStack } from "@alchemy.run/git-service/Stack";

export default GitStack({ name: "GitServiceExample" });
