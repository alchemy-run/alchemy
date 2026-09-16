import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequests } from "./ListPullRequests.ts";
import { listPullRequestsOperation } from "./ListPullRequestsHttp.ts";

/** {@link ListPullRequests} off the provider's ambient credentials (laptop / Actions / tests). */
export const ListPullRequestsLocal = Layer.effect(
  ListPullRequests,
  BindingLocal.make(listPullRequestsOperation),
);
