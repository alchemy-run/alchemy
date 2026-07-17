import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { GetIssue } from "./GetIssue.ts";
import { getIssueOperation } from "./GetIssueHttp.ts";

/** {@link GetIssue} off the provider's ambient credentials (laptop / Actions / tests). */
export const GetIssueLocal = Layer.effect(
  GetIssue,
  BindingLocal.make(getIssueOperation),
);
