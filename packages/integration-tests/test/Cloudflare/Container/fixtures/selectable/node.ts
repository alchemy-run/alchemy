import * as Effect from "effect/Effect";
import { NodeBox } from "./containers.ts";

export default NodeBox.make(
  {
    schedulingPolicy: "durable_object",
    main: import.meta.url,
    runtime: "node",
    env: { GREETING: "hello from node" },
  },
  Effect.succeed(
    NodeBox.of({
      whoami: () =>
        Effect.sync(() => ({
          container: "NodeBox",
          runtime: "node" as const,
          greeting: process.env.GREETING,
          secret: process.env.SECRET,
          boundEnv: undefined,
          caller: process.env.CALLER,
          hasAccountId: !!process.env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
        })),
      echo: (text) => Effect.succeed(`node:${text}`),
    }),
  ),
);
