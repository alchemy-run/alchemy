import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "StartupBenchmark",
  {
    providers: Layer.empty,
    state: State.inMemoryState(),
  },
  Effect.succeed({}),
);
