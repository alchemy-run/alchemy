import type { Input } from "alchemy/Input";
import * as Context from "effect/Context";
import type * as Redacted from "effect/Redacted";

/**
 * The image Rivet Services nodes run. Durable Streams are reached by an
 * actor key this release derives from each stream's path, so the version is
 * pinned.
 */
export const SERVICES_IMAGE = "rivetdev/services:0.2.5";

/** The pool Rivet Services nodes join. Rivet's own actors are created in it. */
export const SERVICES_POOL = "services";

/** What callers need to reach Rivet's own actors: Durable Streams and agentOS. */
export interface ServicesShape {
  /** The control plane URL callers send requests to. */
  readonly endpoint: Input<string>;
  /** The token callers present to the gateway. */
  readonly token: Input<Redacted.Redacted<string>>;
  /** The namespace the services' actors live in. */
  readonly namespace: Input<string>;
}

/**
 * Rivet Services: Rivet's prebuilt node, which hosts Durable Streams and
 * agentOS. Provided by a services pool on a host (`RivetDocker.ServicesPool`,
 * …), and required by every `Rivet.DurableStream`.
 */
export class Services extends Context.Service<Services, ServicesShape>()("Rivet.Services") {}
