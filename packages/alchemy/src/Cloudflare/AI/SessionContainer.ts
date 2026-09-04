import * as Context from "effect/Context";
import type { Container } from "../Containers/Container.ts";

/**
 * The driver's OPTIONAL per-session container — set this Reference
 * beside `DriverCloudflare` (`Layer.succeed(SessionContainerImage,
 * SandboxContainerImage)`) so the session Durable Object's constructor
 * BINDS the container to the sessions namespace at PLAN time. That
 * registration (the `durableObjects` attachment on the
 * ContainerApplication + the `containers` declaration on the Worker)
 * can only be discovered from a plan-evaluated, namespace-scoped site,
 * and the driver's constructor is the one such site — a Layer built in
 * the shared per-isolate graph (`SandboxContainerSession`) runs too
 * late to be seen by the plan.
 *
 * Its own LEAF module (type-only container import): both the driver
 * and the sandbox layers import it, and anything heavier here would
 * re-create the DriverCloudflare ↔ SandboxContainer module cycle.
 */
export const SessionContainerImage: Context.Reference<
  Container.Decl.Any | undefined
> = Context.Reference("alchemy/Cloudflare/AI/SessionContainerImage", {
  defaultValue: (): Container.Decl.Any | undefined => undefined,
});
