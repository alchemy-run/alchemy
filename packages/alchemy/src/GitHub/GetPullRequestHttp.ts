import * as Layer from "effect/Layer";
import { Self } from "../Self.ts";
import * as BindingHttp from "./BindingHttp.ts";
import {
  GetPullRequest,
  type GetPullRequestRequest,
} from "./GetPullRequest.ts";

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
 * Token-backed {@link GetPullRequest}: captures the provider
 * credential as a `GitHub.PersonalAccessToken` resource bound into the
 * host. (Annotated: the contract's format-conditional client type is
 * wider than the operation scaffolding can infer.)
 */
export const GetPullRequestHttp: Layer.Layer<GetPullRequest, never, Self> =
  Layer.effect(
    GetPullRequest,
    BindingHttp.make(getPullRequestOperation) as never,
  );
