import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  MergePullRequest,
  type MergePullRequestRequest,
} from "./MergePullRequest.ts";

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
 * Token-backed {@link MergePullRequest}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const MergePullRequestHttp = Layer.effect(
  MergePullRequest,
  BindingHttp.make(mergePullRequestOperation),
);
