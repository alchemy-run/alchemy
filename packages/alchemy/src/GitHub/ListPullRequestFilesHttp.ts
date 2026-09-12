import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListPullRequestFiles,
  type ListPullRequestFilesRequest,
} from "./ListPullRequestFiles.ts";

export const listPullRequestFilesOperation = BindingHttp.operation(
  "pulls.listFiles",
  (octokit, repo) => (request: ListPullRequestFilesRequest) =>
    octokit.rest.pulls.listFiles({
      owner: repo.owner,
      repo: repo.repository,
      ...request,
    }),
);

/**
 * Token-backed {@link ListPullRequestFiles}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host.
 */
export const ListPullRequestFilesHttp = Layer.effect(
  ListPullRequestFiles,
  BindingHttp.make(listPullRequestFilesOperation),
);
