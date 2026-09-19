import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Repository } from "./Repository.ts";
import type { ReadRepositoryClient } from "./ReadRepository.ts";
import type { WriteRepositoryClient } from "./WriteRepository.ts";
import type { ForgejoBindingOptions } from "./RuntimeTypes.ts";

export interface ReadWriteRepositoryClient
  extends ReadRepositoryClient, WriteRepositoryClient {}
export interface ReadWriteRepository extends Binding.Service<
  ReadWriteRepository,
  "Forgejo.ReadWriteRepository",
  (
    repository: Repository,
    options?: ForgejoBindingOptions,
  ) => Effect.Effect<ReadWriteRepositoryClient>
> {}

/**
 * Read and write repository metadata, topics and files. Shares a restricted
 * write:repository token with WriteRepository on the same host and target,
 * never with ReadRepository. Forgejo 16 rejects topic mutations for restricted
 * tokens; those calls retain the SDK's typed Forbidden error.
 *
 * ### Reading and Writing
 * **Example:** Bind a combined client
 * ```typescript
 * const client = yield* Forgejo.ReadWriteRepository(repository);
 * // Inside the runtime handler:
 * yield* client.createFile({ filepath: "hello.txt", content: "aGVsbG8=" });
 * const file = yield* client.getContent({ filepath: "hello.txt" });
 * ```
 *
 * @binding
 */
export const ReadWriteRepository = Binding.Service<ReadWriteRepository>(
  "Forgejo.ReadWriteRepository",
);
