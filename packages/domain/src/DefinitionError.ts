import * as Data from "effect/Data";

/**
 * A domain definition error (duplicate tag, missing `keyOf`, a reserved
 * field name, …), raised while a block is declared or the kernel is built.
 */
export class DefinitionError extends Data.TaggedError("DefinitionError")<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
