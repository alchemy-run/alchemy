import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeForgejoCapabilityLayers } from "../../Forgejo/RuntimeLayers.ts";
import { ForgejoRepositoryEventSourceLive } from "./ForgejoRepositoryEventSource.ts";
import { Function } from "./Function.ts";

const capabilities = makeForgejoCapabilityLayers(
  Function.pipe(Effect.map((host) => `${host.Type}:${host.FQN}`)),
);
/** Lambda implementation of Forgejo.ReadRepository. */
export const ForgejoReadRepositoryHttp = capabilities.readRepository;
/** Lambda implementation of Forgejo.WriteRepository. */
export const ForgejoWriteRepositoryHttp = capabilities.writeRepository;
/** Lambda implementation of Forgejo.ReadWriteRepository. */
export const ForgejoReadWriteRepositoryHttp = capabilities.readWriteRepository;
/** Lambda implementation of Forgejo.ReadIssues. */
export const ForgejoReadIssuesHttp = capabilities.readIssues;
/** Lambda implementation of Forgejo.WriteIssues. */
export const ForgejoWriteIssuesHttp = capabilities.writeIssues;
/** Lambda implementation of Forgejo.ReadWriteIssues. */
export const ForgejoReadWriteIssuesHttp = capabilities.readWriteIssues;

/**
 * Forgejo capabilities and signed events for Lambda Function URLs.
 * Auth infrastructure is instantiated only when a capability is bound.
 * The bootstrap profile credential remains deployment-only.
 *
 * @layer
 * @provides Forgejo.ReadRepository
 * @provides Forgejo.WriteRepository
 * @provides Forgejo.ReadWriteRepository
 * @provides Forgejo.ReadIssues
 * @provides Forgejo.WriteIssues
 * @provides Forgejo.ReadWriteIssues
 * @provides Forgejo.RepositoryEventSource
 */
export const ForgejoBindings = Layer.mergeAll(
  ForgejoReadRepositoryHttp,
  ForgejoWriteRepositoryHttp,
  ForgejoReadWriteRepositoryHttp,
  ForgejoReadIssuesHttp,
  ForgejoWriteIssuesHttp,
  ForgejoReadWriteIssuesHttp,
  ForgejoRepositoryEventSourceLive,
);
