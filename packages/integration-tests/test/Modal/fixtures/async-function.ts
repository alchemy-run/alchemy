import * as Modal from "@alchemy.run/modal";
import { Services } from "./services.ts";

/** An async function: a plain Bun server, no Effect. */
export const AsyncEmbed = Modal.Function("AsyncEmbed", {
  main: new URL("./async-function-server.ts", import.meta.url).pathname,
  app: Services,
  env: { GREETING: "hello from an async function" },
});

export type AsyncEmbedEnv = Modal.InferEnv<typeof AsyncEmbed>;
