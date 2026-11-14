// src/Greeter.ts
import * as E2B from "@alchemy.run/e2b";

/**
 * A plain handler file baked into an E2B template, run as-is with no
 * Effect runtime. `env` becomes its environment.
 */
export const Greeter = E2B.Template("Greeter", {
  main: "./src/server.ts",
  port: 3000,
  env: { GREETING: "hello" },
});

export type GreeterEnv = E2B.InferEnv<typeof Greeter>;
