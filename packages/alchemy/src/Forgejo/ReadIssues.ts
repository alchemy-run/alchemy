import type * as API from "@distilled.cloud/forgejo/issue";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Repository } from "./Repository.ts";
import type {
  ForgejoBindingOptions,
  ForgejoMethod,
  OptionalForgejoMethod,
} from "./RuntimeTypes.ts";

export interface ReadIssuesClient {
  /** List issues using the SDK's pagination and filters. */
  readonly list: OptionalForgejoMethod<typeof API.listIssues>;
  /** Read an issue by index. */
  readonly get: ForgejoMethod<typeof API.getIssue>;
  /** List comments for an issue. */
  readonly listComments: ForgejoMethod<typeof API.issueGetComments>;
}
export interface ReadIssues extends Binding.Service<
  ReadIssues,
  "Forgejo.ReadIssues",
  (
    repository: Repository,
    options?: ForgejoBindingOptions,
  ) => Effect.Effect<ReadIssuesClient>
> {}

/**
 * Read issues using an automatically managed, repository-restricted
 * read:issue token.
 *
 * ### Listing Issues
 * **Example:** Bind a read-only issue client
 * ```typescript
 * const client = yield* Forgejo.ReadIssues(repository);
 * // Inside the runtime handler:
 * const issues = yield* client.list();
 * ```
 *
 * @binding
 */
export const ReadIssues = Binding.Service<ReadIssues>("Forgejo.ReadIssues");
