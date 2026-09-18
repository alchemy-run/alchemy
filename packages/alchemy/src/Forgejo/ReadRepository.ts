import type * as API from "@distilled.cloud/forgejo/repository";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Repository } from "./Repository.ts";
import type {
  ForgejoBindingOptions,
  ForgejoMethod,
  OptionalForgejoMethod,
} from "./RuntimeTypes.ts";

export interface ReadRepositoryClient {
  /** Read repository metadata. */
  readonly get: OptionalForgejoMethod<typeof API.getRepo>;
  /** List repository topics. */
  readonly getTopics: OptionalForgejoMethod<typeof API.repoListTopics>;
  /** Read a file at the requested path and revision. */
  readonly getContent: ForgejoMethod<typeof API.repoGetContents>;
}

export interface ReadRepository extends Binding.Service<
  ReadRepository,
  "Forgejo.ReadRepository",
  (
    repository: Repository,
    options?: ForgejoBindingOptions,
  ) => Effect.Effect<ReadRepositoryClient>
> {}

/**
 * Read repository metadata, topics and files using an automatically managed,
 * repository-restricted read:repository token.
 *
 * ### Reading a Repository
 * **Example:** Bind a read-only client
 * ```typescript
 * const client = yield* Forgejo.ReadRepository(repository);
 * // Inside the runtime handler:
 * const details = yield* client.get();
 * ```
 *
 * @binding
 */
export const ReadRepository = Binding.Service<ReadRepository>(
  "Forgejo.ReadRepository",
);
