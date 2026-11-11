import * as Effect from "effect/Effect";
import { Greeters } from "../greeter.ts";
import { Default } from "./cluster.ts";

export default Greeters.make(
  { main: import.meta.url },
  Effect.succeed(
    Effect.succeed(
      Greeters.of({ Greet: ({ payload }) => Effect.succeed(`hello ${payload.name}`) }),
    ),
  ).pipe(Effect.provide(Default)),
);
