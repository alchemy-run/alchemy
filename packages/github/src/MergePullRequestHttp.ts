import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { MergePullRequest, type MergePullRequestRequest } from "./MergePullRequest.ts";

export const mergePullRequestOperation = BindingHttp.operation(
  "pulls.merge",
  (octokit, repo) => (request: MergePullRequestRequest) =>
    octokit.rest.pulls.merge({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed implementation of {@link MergePullRequest}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.MergePullRequest
 */
export const MergePullRequestHttp = Layer.effect(
  MergePullRequest,
  BindingHttp.make(mergePullRequestOperation),
);
