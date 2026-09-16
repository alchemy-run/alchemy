import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreateIssueComment } from "./CreateIssueComment.ts";
import { createIssueCommentOperation } from "./CreateIssueCommentHttp.ts";

/** {@link CreateIssueComment} off the provider's ambient credentials (laptop / Actions / tests). */
export const CreateIssueCommentLocal = Layer.effect(
  CreateIssueComment,
  BindingLocal.make(createIssueCommentOperation),
);
