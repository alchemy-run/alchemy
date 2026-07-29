/**
 * How GitHub's events reach the org — one seam, two physics:
 *
 * - {@link EventsLocal} — REST polling. 3s is the floor: each cycle is
 *   3 REST calls (issues + comments + PRs), ~3.6k req/hr against
 *   GitHub's 5k budget. The one architectural latency of the local
 *   factory (~2×3s per issue→merge loop).
 * - {@link EventsWorker} — a real webhook: deploy provisions a
 *   {@link GitHub.Webhook} pointing at the Worker (secret bound as a
 *   Worker secret), runtime verifies HMAC signatures and claims the
 *   delivery path before the Worker's own fetch. Delivery becomes
 *   PUSH; the polling latency disappears.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";

export const EventsLocal = GitHub.RepositoryEventSourcePolling({
  every: "3 seconds",
});

export const EventsWorker = Cloudflare.Workers.GitHubRepositoryEventSourceLive;
