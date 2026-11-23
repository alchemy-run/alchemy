import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A stack whose `Probe` `read` is steered by `DRIFT_FIXTURE_CLOUD`: unset, the
 * resource is in sync; `missing`, it was deleted out of band; `broken`, the
 * cloud can't be read. `Note` has no `read`, so drift can never check it.
 * `DRIFT_FIXTURE_STUCK` adds a `Stuck` resource whose create fails, leaving
 * an interrupted deploy behind. Pins `alchemy drift`'s exit codes.
 */
interface Probe extends Resource<"CliDrift.Probe", {}, { id: string }> {}
const Probe = Resource<Probe>("CliDrift.Probe");

interface Note extends Resource<"CliDrift.Note", {}, { id: string }> {}
const Note = Resource<Note>("CliDrift.Note");

interface Stuck extends Resource<"CliDrift.Stuck", {}, { id: string }> {}
const Stuck = Resource<Stuck>("CliDrift.Stuck");

class CloudUnreachable extends Data.TaggedError("CloudUnreachable")<{}> {}
class CreateInterrupted extends Data.TaggedError("CreateInterrupted")<{}> {}

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

const NoteProvider = Provider.effect(
  Note,
  Effect.succeed({
    list: () => Effect.succeed([]),
    reconcile: Effect.fn(function* ({ id }) {
      return { id };
    }),
    delete: () => Effect.void,
  }),
);

const StuckProvider = Provider.effect(
  Stuck,
  Effect.succeed({
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: () => Effect.fail(new CreateInterrupted()),
    delete: () => Effect.void,
  }),
);

export default Alchemy.Stack(
  "CliDriftExitCodes",
  {
    providers: Layer.mergeAll(ProbeProvider, NoteProvider, StuckProvider),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* Probe("Probe", {});
    yield* Note("Note", {});
    if (yield* Config.Boolean("DRIFT_FIXTURE_STUCK").pipe(Config.withDefault(false))) {
      yield* Stuck("Stuck", {});
    }
  }),
);
