import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import Events from "./Events.ts";
import { resources } from "./resources.ts";

export default Alchemy.Stack(
  "neon-triggers",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { branch } = yield* resources;
    const events = yield* Events;
    const native = yield* Neon.Function("NativeEvents", {
      branch,
      main: new URL("./native.ts", import.meta.url).href,
    });
    yield* Neon.FunctionTrigger("NativeNightly", {
      function: native,
      type: "schedule",
      schedule: { cron: "0 2 * * *" },
      path: "/jobs/nightly",
    });
    return { effectUrl: events.url, nativeUrl: native.url };
  }),
);
