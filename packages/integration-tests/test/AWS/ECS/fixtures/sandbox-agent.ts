import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The program every sandbox of the `AWS.ECS.CreateSandbox` suite runs: one
 * ECS task in its own Nitro Sandbox.
 *
 * - `hello` is a typed method the host calls on the sandbox handle.
 * - `fetch` is the program's own HTTP surface on port 3000, which the host
 *   reaches through `sandbox.getTcpPort(3000)`.
 */
export default class SandboxAgent extends AWS.ECS.Task<
  SandboxAgent,
  { hello: (name: string) => Effect.Effect<string> }
>()(
  "EcsSandboxAgent",
  {
    main: import.meta.filename,
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // rate-limits anonymous pulls (429) during local builds.
    image: "oven/bun:1",
    port: 3000,
    cpu: 1024,
    memory: 2048,
    isolation: "isolated",
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://sandbox");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text(`sandbox agent ${url.pathname}`);
      }).pipe(Effect.orDie),
      hello: Effect.fn(function* (name: string) {
        return `hello ${name}`;
      }),
    };
  }),
) {}
