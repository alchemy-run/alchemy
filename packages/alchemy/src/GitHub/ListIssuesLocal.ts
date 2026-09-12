import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListIssues } from "./ListIssues.ts";
import { listIssuesOperation } from "./ListIssuesHttp.ts";

/** {@link ListIssues} off the provider's ambient credentials (laptop / Actions / tests). */
export const ListIssuesLocal = Layer.effect(
  ListIssues,
  BindingLocal.make(listIssuesOperation),
);
