import type { Self } from "alchemy/Self";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { GetPullRequest, type GetPullRequestRequest } from "./GetPullRequest.ts";

export const getPullRequestOperation = BindingHttp.operation(
  "pulls.get",
  (octokit, repo) =>
    async ({ format, ...request }: GetPullRequestRequest) => {
      const response = await octokit.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repository,
        ...request,
        // the diff/patch media types return the raw text as the body
        ...(format !== undefined ? { mediaType: { format } } : {}),
      });
      return { data: response.data };
    },
);

/**
 * Token-backed implementation of {@link GetPullRequest}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.GetPullRequest
 */
export const GetPullRequestHttp: Layer.Layer<GetPullRequest, never, Self> = Layer.effect(
  GetPullRequest,
  BindingHttp.make(getPullRequestOperation) as never,
);
