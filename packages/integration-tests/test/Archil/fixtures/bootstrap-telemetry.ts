import { bootstrap } from "@alchemy.run/archil/Bootstrap";
import { createContainerRuntimeContext } from "alchemy/Runtime/Process";
import * as Effect from "effect/Effect";

const host = createContainerRuntimeContext("Archil.Sandbox")("fixture");

const program = Effect.void.pipe(
  Effect.withSpan("archil-bootstrap-telemetry"),
  Effect.andThen(Effect.never),
);

const entrypoint = Effect.gen(function* () {
  yield* host.run(program);
  return { RuntimeContext: host };
});

await bootstrap(entrypoint);
