import type * as API from "@distilled.cloud/forgejo/repository";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Repository } from "./Repository.ts";
import type { ForgejoBindingOptions, ForgejoMethod } from "./RuntimeTypes.ts";

export interface WriteRepositoryClient {
  /**
   * Replace topics. Forgejo 16 rejects this repository-admin operation for
   * repository-restricted tokens with Forbidden. Use an explicit external
   * credential with repository-admin access when needed; automatic tokens
   * are never broadened. Leave resource topics unmanaged for runtime updates.
   */
  readonly setTopics: ForgejoMethod<typeof API.repoUpdateTopics>;
  /** Create a file with base64-encoded content. */
  readonly createFile: ForgejoMethod<typeof API.repoCreateFile>;
  /** Update a file using its observed SHA and base64-encoded content. */
  readonly updateFile: ForgejoMethod<typeof API.repoUpdateFile>;
  /** Delete a file using its observed SHA. */
  readonly deleteFile: ForgejoMethod<typeof API.repoDeleteFile>;
}

export interface WriteRepository extends Binding.Service<
  WriteRepository,
  "Forgejo.WriteRepository",
  (
    repository: Repository,
    options?: ForgejoBindingOptions,
  ) => Effect.Effect<WriteRepositoryClient>
> {}

/**
 * Write repository files using an automatically managed,
 * repository-restricted write:repository token. Forgejo 16 requires repository
 * administrator access for topic changes and rejects restricted tokens for
 * that operation; the client preserves the typed Forbidden error.
 *
 * ### Creating a File
 * **Example:** Bind a write client
 * ```typescript
 * const client = yield* Forgejo.WriteRepository(repository);
 * // Inside the runtime handler:
 * yield* client.createFile({ filepath: "hello.txt", content: "aGVsbG8=" });
 * ```
 *
 * @binding
 */
export const WriteRepository = Binding.Service<WriteRepository>(
  "Forgejo.WriteRepository",
);
