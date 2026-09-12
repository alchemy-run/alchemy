import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  CreatePullRequest,
  type CreatePullRequestRequest,
} from "./CreatePullRequest.ts";

export const createPullRequestOperation = BindingHttp.operation(
  "pulls.create",
  (octokit, repo) => (request: CreatePullRequestRequest) =>
    octokit.rest.pulls.create({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link CreatePullRequest}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const CreatePullRequestHttp = Layer.effect(
  CreatePullRequest,
  BindingHttp.make(createPullRequestOperation),
);
