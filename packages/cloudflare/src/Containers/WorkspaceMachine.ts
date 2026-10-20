/**
 * The program a workspace machine on a Lambda MicroVM runs: nothing but a
 * health check. Commands arrive through the sandbox's `exec`, and the disk
 * through `blockd mount`. Deploy names this file as the MicroVM program's
 * `main`.
 *
 * NOT exported from `index.ts`.
 */
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default Effect.succeed({
  fetch: Effect.succeed(HttpServerResponse.text("workspace machine\n")),
});
