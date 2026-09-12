import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequestFiles } from "./ListPullRequestFiles.ts";
import { listPullRequestFilesOperation } from "./ListPullRequestFilesHttp.ts";

/** {@link ListPullRequestFiles} off the provider's ambient credentials (laptop / Actions / tests). */
export const ListPullRequestFilesLocal = Layer.effect(
  ListPullRequestFiles,
  BindingLocal.make(listPullRequestFilesOperation),
);
