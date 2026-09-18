import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeForgejoCapabilityLayers } from "../../Forgejo/RuntimeLayers.ts";
import { ForgejoRepositoryEventSourceLive } from "./ForgejoRepositoryEventSource.ts";
import { Worker } from "./Worker.ts";

const capabilities = makeForgejoCapabilityLayers(
  Worker.pipe(Effect.map((host) => `${host.Type}:${host.FQN}`)),
);
/** Worker implementation of Forgejo.ReadRepository. */
export const ForgejoReadRepositoryHttp = capabilities.readRepository;
/** Worker implementation of Forgejo.WriteRepository. */
export const ForgejoWriteRepositoryHttp = capabilities.writeRepository;
/** Worker implementation of Forgejo.ReadWriteRepository. */
export const ForgejoReadWriteRepositoryHttp = capabilities.readWriteRepository;
/** Worker implementation of Forgejo.ReadIssues. */
export const ForgejoReadIssuesHttp = capabilities.readIssues;
/** Worker implementation of Forgejo.WriteIssues. */
export const ForgejoWriteIssuesHttp = capabilities.writeIssues;
/** Worker implementation of Forgejo.ReadWriteIssues. */
export const ForgejoReadWriteIssuesHttp = capabilities.readWriteIssues;

/**
 * Forgejo capabilities and signed repository events for Cloudflare Workers.
 * Providing this layer alone creates no tokens or webhooks. Each capability
 * provisions its own repository-restricted credential from the deployment profile.
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
