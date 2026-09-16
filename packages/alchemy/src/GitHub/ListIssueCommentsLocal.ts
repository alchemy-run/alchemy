import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListIssueComments } from "./ListIssueComments.ts";
import { listIssueCommentsOperation } from "./ListIssueCommentsHttp.ts";

/** {@link ListIssueComments} off the provider's ambient credentials (laptop / Actions / tests). */
export const ListIssueCommentsLocal = Layer.effect(
  ListIssueComments,
  BindingLocal.make(listIssueCommentsOperation),
);
