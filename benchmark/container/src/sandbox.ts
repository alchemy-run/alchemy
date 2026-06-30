import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Build role shared by both MicroVM images (effectful + external).
 */
export const SandboxBuildRole = AWS.IAM.Role("MicrovmSandboxBuildRole");

/**
 * Effectful MicroVM image — a bundled Effect program exposing a raw `fetch`
 * handler and a typed RPC `hello` method. The runtime serves RPC over the
 * `/__rpc__/*` protocol and falls through to `fetch` otherwise. This is the
 * AWS analog of the Cloudflare effectful container: it measures the cost of
 * shipping a bundled Effect runtime into the MicroVM.
 */
export class Sandbox extends AWS.Lambda.MicrovmImage<
  Sandbox,
  {
    hello: (message: string) => Effect.Effect<string>;
  }
>()("MicrovmSandbox") {}

export default Sandbox.make(
  SandboxBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");
        if (url.pathname === "/echo") {
          return yield* HttpServerResponse.json({
            message: url.searchParams.get("message") ?? "",
          });
        }
        return HttpServerResponse.text("hello from effectful microvm");
      }),
      hello: (message: string) => Effect.succeed(`hello, ${message}!`),
    };
  }),
);
