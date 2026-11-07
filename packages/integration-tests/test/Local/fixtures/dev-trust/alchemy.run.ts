import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "DevTrustFixture",
  {
    providers: Command.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const out = yield* Config.String("DEV_TRUST_OUT");
    // What this program's own process (the exec child) received.
    const execTrust = yield* Config.String("ALCHEMY_DEV_TRUST").pipe(Config.withDefault(""));
    const child = yield* Command.Dev("Child", {
      command: "node child.cjs",
      env: { DEV_TRUST_OUT: out, EXEC_DEV_TRUST: execTrust },
    });
    return { url: child.url };
  }),
);
