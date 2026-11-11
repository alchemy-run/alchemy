import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { PROBE_ENV_KEY, ProbeEnv, ProbeEnvBinding } from "../effectful/env-binding.ts";
import { BunBox } from "./containers.ts";
import { SelectableStorage } from "./storage.ts";

export default BunBox.make(
  {
    schedulingPolicy: "durable_object",
    main: import.meta.url,
    env: {
      GREETING: "hello from bun",
      SECRET: Redacted.make("bun-secret"),
    },
  },
  Effect.gen(function* () {
    // A capability whose only contribution is an env var bound onto the
    // container: it must reach the process through the handle's start().
    yield* ProbeEnv(yield* SelectableStorage);

    return BunBox.of({
      whoami: () =>
        Effect.sync(() => ({
          container: "BunBox",
          runtime: "bun" as const,
          greeting: process.env.GREETING,
          secret: process.env.SECRET,
          boundEnv: process.env[PROBE_ENV_KEY],
          caller: process.env.CALLER,
          hasAccountId: !!process.env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
        })),
      echo: (text) => Effect.succeed(`bun:${text}`),
    });
  }).pipe(Effect.provide(ProbeEnvBinding)),
);
