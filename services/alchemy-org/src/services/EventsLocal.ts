import * as GitHub from "alchemy/GitHub";

/**
 * How GitHub's events reach the bot: REST polling. 3s is the floor —
 * each cycle is 3 REST calls (issues + comments + PRs), ~3.6k req/hr
 * against GitHub's 5k budget. A webhook variant replaces this seam
 * when the bot moves off the laptop.
 */
export const EventsLocal = GitHub.RepositoryEventSourcePolling({
  every: "3 seconds",
});
