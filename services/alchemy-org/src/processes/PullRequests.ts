/**
 * The pull-requests surface — a SEALED process: {@link PullRequests}
 * is a plain `Context.Service` resolving to
 * {@link PullRequestsService} and nothing else. Unlinked (foreign)
 * pull requests are reviewed by the org's ONE Reviewer, dispatched by
 * the router in processes/Issues.ts with a deterministic merge
 * ratifier — work enters through GitHub or not at all.
 */
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../Repos.ts";

/** What the org may ask of the PullRequests owner from code: read, never drive. */
export interface PullRequestsService {
  /** Snapshot of the repository's open pull requests. */
  readonly list: () => Effect.Effect<
    GitHub.ListPullRequestsResponse,
    GitHub.GitHubApiError
  >;
}

export class PullRequests extends Context.Service<
  PullRequests,
  PullRequestsService
>()("alchemy-org/PullRequests") {}

/** The read-only status surface (events are routed by Issues.ts). */
export const PullRequestsLive = Layer.effect(
  PullRequests,
  Effect.gen(function* () {
    const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);
    return {
      list: () => listPullRequests({ state: "open" }),
    };
  }),
);
