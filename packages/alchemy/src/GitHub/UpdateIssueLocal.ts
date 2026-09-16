import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { UpdateIssue } from "./UpdateIssue.ts";
import { updateIssueOperation } from "./UpdateIssueHttp.ts";

/** {@link UpdateIssue} off the provider's ambient credentials (laptop / Actions / tests). */
export const UpdateIssueLocal = Layer.effect(
  UpdateIssue,
  BindingLocal.make(updateIssueOperation),
);
