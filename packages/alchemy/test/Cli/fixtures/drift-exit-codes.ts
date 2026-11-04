import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A stack of one resource whose `read` is steered by `DRIFT_FIXTURE_CLOUD`:
 * unset, the resource is in sync; `missing`, it was deleted out of band;
 * `broken`, the cloud can't be read. Pins `alchemy drift`'s exit codes.
 */
interface Probe extends Resource<"CliDrift.Probe", {}, { id: string }> {}
const Probe = Resource<Probe>("CliDrift.Probe");

class CloudUnreachable extends Data.TaggedError("CloudUnreachable")<{}> {}

const cloud = Config.String("DRIFT_FIXTURE_CLOUD").pipe(Config.withDefault("in-sync"));

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
      return { id };
    }),
    delete: () => Effect.void,
  }),
);

export default Alchemy.Stack(
  "CliDriftExitCodes",
  { providers: ProbeProvider, state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* Probe("Probe", {});
  }),
);
