import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeArtifactsBinding,
  makeReadNamespaceClient,
  makeRepoClient,
  makeWriteNamespaceClient,
} from "./NamespaceBinding.ts";
import { ReadWriteNamespace, type ReadWriteNamespaceClient } from "./ReadWriteNamespace.ts";

/**
 * Native Worker-binding implementation of {@link ReadWriteNamespace}: the full
 * Artifacts namespace + repository surface, each method wrapped in Effect.
 */
export const ReadWriteNamespaceBinding = Layer.effect(
  ReadWriteNamespace,
  Effect.suspend(() =>
    makeArtifactsBinding({
      makeClient: (helpers): ReadWriteNamespaceClient => ({
        ...makeReadNamespaceClient(helpers),
        ...makeWriteNamespaceClient(helpers),
        get: (name) =>
          helpers.openRepo(name).pipe(Effect.map((repo) => makeRepoClient(name, repo))),
      }),
    }),
  ),
);
