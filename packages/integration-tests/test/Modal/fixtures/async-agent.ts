import * as Modal from "@alchemy.run/modal";
import { Coder } from "./resources.ts";

export const AsyncAgent = Modal.Sandbox("AsyncAgent", {
  main: new URL("./async-program.ts", import.meta.url).pathname,
  app: Coder,
  env: { GREETING: "hello from async" },
});

export type AsyncAgentEnv = Modal.InferEnv<typeof AsyncAgent>;
