import type * as API from "@distilled.cloud/forgejo/issue";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Repository } from "./Repository.ts";
import type { ForgejoBindingOptions, ForgejoMethod } from "./RuntimeTypes.ts";

export interface WriteIssuesClient {
  /** Create an issue. */
  readonly create: ForgejoMethod<typeof API.createIssue>;
  /** Edit an existing issue. */
  readonly update: ForgejoMethod<typeof API.editIssue>;
  /** Add a comment to an issue. */
  readonly createComment: ForgejoMethod<typeof API.issueCreateComment>;
}
export interface WriteIssues extends Binding.Service<
  WriteIssues,
  "Forgejo.WriteIssues",
  (
    repository: Repository,
    options?: ForgejoBindingOptions,
  ) => Effect.Effect<WriteIssuesClient>
> {}

/**
 * Write issues using an automatically managed, repository-restricted
 * write:issue token.
 *
 * ### Creating an Issue
 * **Example:** Bind a write issue client
 * ```typescript
 * const client = yield* Forgejo.WriteIssues(repository);
 * // Inside the runtime handler:
 * yield* client.create({ title: "Deployment failed" });
 * ```
 *
 * @binding
 */
export const WriteIssues = Binding.Service<WriteIssues>("Forgejo.WriteIssues");
