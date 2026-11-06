import * as AWS from "@alchemy.run/aws";
import * as Modal from "@alchemy.run/modal";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { AsyncAgent } from "./async-agent.ts";
import Agent from "./program.ts";

/** Starts a sandbox of each program per request and returns its answer. */
export default class RuntimeFunction extends AWS.Lambda.Function<RuntimeFunction>()(
  "ModalRuntimeFunction",
  { main: import.meta.url, timeout: Duration.minutes(14), memorySize: 1024 },
  Effect.gen(function* () {
    const agents = yield* Modal.CreateSandbox(Agent);
    const asyncAgents = yield* Modal.CreateSandbox(AsyncAgent);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://host");
        // Ask one sandbox of the program for `path`, then terminate it.
        const ask = (path: string) =>
          Effect.gen(function* () {
            const agent = yield* agents.create({ timeout: "5 minutes" });
            return yield* Effect.gen(function* () {
              const response = yield* agent
                .fetch(HttpClientRequest.get(path))
                .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
              return yield* response.json;
            }).pipe(Effect.ensuring(Effect.ignore(agent.terminate())));
          });
        if (url.pathname === "/mounts") {
          // One sandbox writes through its mounts; a second reads the files
          // back, so they live in the volume and the bucket, not the sandbox.
          const key = url.searchParams.get("key") ?? "k";
          yield* ask(`/write?key=${key}`);
          return yield* HttpServerResponse.json(yield* ask(`/read?key=${key}`));
        }
        const pool =
          new URL(request.url, "http://host").pathname === "/async" ? asyncAgents : agents;
        const agent = yield* pool.create({ timeout: "5 minutes" });
        const body = yield* Effect.gen(function* () {
          const response = yield* agent
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
