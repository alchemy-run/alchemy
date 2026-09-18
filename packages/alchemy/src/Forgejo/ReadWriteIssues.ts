import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Repository } from "./Repository.ts";
import type { ReadIssuesClient } from "./ReadIssues.ts";
import type { WriteIssuesClient } from "./WriteIssues.ts";
import type { ForgejoBindingOptions } from "./RuntimeTypes.ts";

export interface ReadWriteIssuesClient
  extends ReadIssuesClient, WriteIssuesClient {}
export interface ReadWriteIssues extends Binding.Service<
  ReadWriteIssues,
  "Forgejo.ReadWriteIssues",
  (
    repository: Repository,
    options?: ForgejoBindingOptions,
  ) => Effect.Effect<ReadWriteIssuesClient>
> {}

/**
 * Read and write issues using an automatically managed, repository-restricted
 * write:issue token. Read-only clients retain separate credentials.
 *
 * ### Reading and Writing Issues
 * **Example:** Bind a combined issue client
 * ```typescript
 * const client = yield* Forgejo.ReadWriteIssues(repository);
 * // Inside the runtime handler:
 * const issue = yield* client.create({ title: "Deployment failed" });
 * yield* client.createComment({ index: issue.number, body: "Investigating" });
 * ```
 *
 * @binding
 */
export const ReadWriteIssues = Binding.Service<ReadWriteIssues>(
  "Forgejo.ReadWriteIssues",
);
