import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { SearchIssues } from "./SearchIssues.ts";
import { searchIssuesOperation } from "./SearchIssuesHttp.ts";

/** {@link SearchIssues} off the provider's ambient credentials (laptop / Actions / tests). */
export const SearchIssuesLocal = Layer.effect(
  SearchIssues,
  BindingLocal.make(searchIssuesOperation),
);
