import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The stack's project, for fixture props that name it. `GcpEnvironment`
 * exists at deploy time only: a deployed host re-runs its fixtures' Effects
 * without reconciling props, so a placeholder stands in there.
 */
export const deployProject = Effect.gen(function* () {
  const env = yield* Effect.serviceOption(GcpEnvironment);
  if (Option.isNone(env)) return "runtime-placeholder";
  return (yield* env.value.pipe(Effect.orDie)).project;
});
