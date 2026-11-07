import * as Modal from "@alchemy.run/modal";
import { Services } from "./services.ts";

/** An async Server without proxy auth. */
export const AsyncApi = Modal.Server("AsyncApi", {
  main: new URL("./async-server-program.ts", import.meta.url).pathname,
  app: Services,
  unauthenticated: true,
  env: { GREETING: "hello from an async server" },
});

export type AsyncApiEnv = Modal.InferEnv<typeof AsyncApi>;
