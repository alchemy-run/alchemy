import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeArtifactsBinding, makeReadNamespaceClient } from "./NamespaceBinding.ts";
import { ReadNamespace } from "./ReadNamespace.ts";

/**
 * Native Worker-binding implementation of {@link ReadNamespace}: `get` (a
 * read-only repo handle), `list`, `listAll`.
 */
export const ReadNamespaceBinding = Layer.effect(
  ReadNamespace,
  Effect.suspend(() => makeArtifactsBinding({ makeClient: makeReadNamespaceClient })),
);
