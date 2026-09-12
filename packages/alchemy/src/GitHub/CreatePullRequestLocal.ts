import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreatePullRequest } from "./CreatePullRequest.ts";
import { createPullRequestOperation } from "./CreatePullRequestHttp.ts";

/** {@link CreatePullRequest} off the provider's ambient credentials (laptop / Actions / tests). */
export const CreatePullRequestLocal = Layer.effect(
  CreatePullRequest,
  BindingLocal.make(createPullRequestOperation),
);
