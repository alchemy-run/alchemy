import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { warehouse } from "./warehouse.ts";

/**
 * Deploy a binding suite's warehouse under `name` in a stack of its own,
 * and destroy it when the test's scope closes. A lookup may not resolve
 * to a resource of the stack doing the lookup, so the host's stack
 * reaches it by name from outside.
 */
export const deployWarehouse = (name: string) => {
  const scratch = Core.scratchStack(
    { providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()) },
    `StarburstGalaxyWarehouse-${name}`,
  );
  return Effect.acquireRelease(
    scratch.destroy().pipe(Effect.andThen(scratch.deploy(warehouse(name)))),
    () => scratch.destroy().pipe(Effect.ignore),
  );
};
