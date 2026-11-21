import * as Portless from "@alchemy.run/portless";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";

// The dev server the Workers call. This module is bundled into the Worker too, where there is no
// directory to resolve against and the command is never run.
const server =
  typeof import.meta.dirname === "string"
    ? pathe.resolve(import.meta.dirname, "../server.mjs")
    : "server.mjs";

/** The proxy and the service behind it, shared by the stack and by the Worker that calls it. */
export const Api = Portless.Proxy("Proxy", { domain: "fetch-test" }).pipe(
  Effect.flatMap((proxy) =>
    Portless.Dev("Api", {
      proxy,
      command: `node ${server}`,
      env: { SERVER_NAME: "api" },
    }),
  ),
);
