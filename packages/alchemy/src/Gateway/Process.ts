/**
 * A gateway as the program of any host that runs a process and serves HTTP
 * (a Fly Service, an ECS Service, a container): the host's own bootstrap
 * runs it, with the services and the HTTP server it gives every program.
 *
 * A gateway host Layer declares its resource with a `main` whose default
 * export is {@link gateway} over the sandbox's program.
 */
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerRequestApi from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Http from "../Http.ts";
import { serve } from "./Serve.ts";

/**
 * `entrypoint` (the sandbox's program) as a gateway, in the shape a process
 * bootstrap resolves: an instance whose `RuntimeContext.exports.program`
 * serves it.
 */
export const gateway = (entrypoint: unknown) =>
  Effect.succeed({
    RuntimeContext: {
      exports: Effect.succeed({
        program: Effect.gen(function* () {
          // What the host gives its programs: its file system, its cloud's
          // credentials, an HTTP client.
          const services = yield* Effect.context<never>();
          const handle = serve(entrypoint, {
            services: Layer.succeedContext(services) as Layer.Layer<any>,
            // The server sees its own address; the public one is the Host header.
            url: (request) => `https://${request.headers.get("host")}`,
          });
          yield* Http.serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest;
              const web = yield* HttpServerRequestApi.toWeb(request);
              // Bound values are read raw, never through Config (see unpackEnvValue).
              const response = yield* Effect.promise(() => handle(web, process.env));
              return HttpServerResponse.fromWeb(response);
            }).pipe(Effect.orDie),
          );
          return yield* Effect.never;
        }),
      }),
    },
  });
