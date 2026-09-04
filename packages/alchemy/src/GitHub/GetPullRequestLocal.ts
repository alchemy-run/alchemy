import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import type { GitHubCredentials } from "./Credentials.ts";
import { GetPullRequest } from "./GetPullRequest.ts";
import { getPullRequestOperation } from "./GetPullRequestHttp.ts";

/**
 * {@link GetPullRequest} off the provider's ambient credentials
 * (laptop / Actions / tests). (Annotated: the contract's
 * format-conditional client type is wider than the operation
 * scaffolding can infer.)
 */
export const GetPullRequestLocal: Layer.Layer<
  GetPullRequest,
  never,
  GitHubCredentials
> = Layer.effect(
  GetPullRequest,
  BindingLocal.make(getPullRequestOperation) as never,
);
