import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeArtifactsBinding, makeWriteNamespaceClient } from "./NamespaceBinding.ts";
import { WriteNamespace } from "./WriteNamespace.ts";

/**
 * Native Worker-binding implementation of {@link WriteNamespace}: `create`,
 * `import`, `delete`, and `get` (a repo handle that mints / revokes tokens and
 * forks).
 */
export const WriteNamespaceBinding = Layer.effect(
  WriteNamespace,
  Effect.suspend(() => makeArtifactsBinding({ makeClient: makeWriteNamespaceClient })),
);
