import * as AWS from "@alchemy.run/aws";
import * as Modal from "@alchemy.run/modal";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import EnvAgent from "./env-program.ts";

/** Starts one {@link EnvAgent} sandbox per request and returns what it echoes. */
export default class EnvFunction extends AWS.Lambda.Function<EnvFunction>()(
  "ModalEnvFunction",
  { main: import.meta.url, timeout: Duration.minutes(5), memorySize: 1024 },
  Effect.gen(function* () {
    const agents = yield* Modal.CreateSandbox(EnvAgent);
    return {
      fetch: Effect.gen(function* () {
        const agent = yield* agents.create({ timeout: "5 minutes" });
        const body = yield* Effect.gen(function* () {
          const port = yield* agent.getTcpPort();
          const response = yield* port
            .fetch(HttpClientRequest.get("/"))
            // The program needs a few seconds to start listening after boot.
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
          return yield* response.json;
        }).pipe(Effect.ensuring(Effect.ignore(agent.terminate())));
        return yield* HttpServerResponse.json(body);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
) {}
