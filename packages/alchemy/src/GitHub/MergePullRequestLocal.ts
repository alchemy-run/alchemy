import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { MergePullRequest } from "./MergePullRequest.ts";
import { mergePullRequestOperation } from "./MergePullRequestHttp.ts";

/** {@link MergePullRequest} off the provider's ambient credentials (laptop / Actions / tests). */
export const MergePullRequestLocal = Layer.effect(
  MergePullRequest,
  BindingLocal.make(mergePullRequestOperation),
);
