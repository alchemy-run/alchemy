import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A stack of one resource whose `read` is steered by `DRIFT_FIXTURE_CLOUD`:
 * unset, the resource is in sync; `missing`, it was deleted out of band;
 * `broken`, the cloud can't be read. Its id carries
 * `DRIFT_FIXTURE_GENERATION`, like a cloud-assigned id that changes when the
 * resource is recreated, and the stack outputs it. Pins `alchemy drift`'s exit
 * codes and that a repair through `deploy --detect-drift` refreshes outputs.
 */
interface Probe extends Resource<"CliDrift.Probe", {}, { id: string }> {}
const Probe = Resource<Probe>("CliDrift.Probe");

class CloudUnreachable extends Data.TaggedError("CloudUnreachable")<{}> {}

const cloud = Config.String("DRIFT_FIXTURE_CLOUD").pipe(Config.withDefault("in-sync"));
const generation = Config.String("DRIFT_FIXTURE_GENERATION").pipe(Config.withDefault("1"));

const ProbeProvider = Provider.effect(
  Probe,
  Effect.succeed({
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ output }) {
      const state = yield* cloud;
      if (state === "missing") return undefined;
      if (state === "broken") return yield* Effect.fail(new CloudUnreachable());
      return output;
    }),
    reconcile: Effect.fn(function* ({ id }) {
      return { id: `${id}#${yield* generation}` };
    }),
    delete: () => Effect.void,
  }),
);

export default Alchemy.Stack(
  "CliDriftExitCodes",
  { providers: ProbeProvider, state: Alchemy.localState() },
  Effect.gen(function* () {
    const probe = yield* Probe("Probe", {});
    return { probeId: probe.id };
  }),
);
