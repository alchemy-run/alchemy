import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { CreatePullRequest, type CreatePullRequestRequest } from "./CreatePullRequest.ts";

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
 * Token-backed implementation of {@link CreatePullRequest}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.CreatePullRequest
 */
export const CreatePullRequestHttp = Layer.effect(
  CreatePullRequest,
  BindingHttp.make(createPullRequestOperation),
);
