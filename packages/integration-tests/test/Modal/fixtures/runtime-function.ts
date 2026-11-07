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
              const port = yield* agent.getTcpPort();
              const response = yield* port
                .fetch(HttpClientRequest.get(path))
                .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
              return yield* response.json;
            }).pipe(Effect.ensuring(Effect.ignore(agent.terminate())));
          });
        if (url.pathname === "/owned") {
          // Left running: the test reads its tags, then terminates it.
          const agent = yield* agents.create({
            timeout: "5 minutes",
            tags: { user: "u1", "alchemy::stack": "spoofed" },
          });
          return yield* HttpServerResponse.json({ sandboxId: agent.sandboxId });
        }
        if (url.pathname.startsWith("/port/")) {
          const agent = yield* agents.create({ timeout: "5 minutes" });
          return yield* Effect.gen(function* () {
            const port = yield* agent.getTcpPort();
            // Wait for the program to listen, so the request below is sent once.
            yield* port
              .fetch(HttpClientRequest.get("/"))
              .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
            if (url.pathname === "/port/client") {
              // A client request in, a client response out.
              const response = yield* port.fetch(
                HttpClientRequest.post("/client/echo?x=1").pipe(
                  HttpClientRequest.setHeader("x-probe", "client"),
                  HttpClientRequest.bodyText("hello client"),
                ),
              );
              return yield* HttpServerResponse.json({
                status: response.status,
                echo: response.headers["x-echo"],
                body: yield* response.json,
              });
            }
            if (url.pathname === "/port/connect") {
              // HTTP/1.1 by hand over the TCP socket (TLS: an encrypted tunnel).
              const socket = yield* port.connect();
              const text = yield* Effect.scoped(
                Effect.gen(function* () {
                  const writer = yield* socket.writer;
                  const reader = yield* socket.reader;
                  yield* writer.write(
                    `GET /connect/echo?x=3 HTTP/1.1\r\nhost: ${port.host}\r\nx-probe: connect\r\nconnection: close\r\n\r\n`,
                  );
                  let text = "";
                  // Read the head, then the body its content-length announces.
                  for (;;) {
                    for (const chunk of yield* reader.pull) {
                      text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                    }
                    const end = text.indexOf("\r\n\r\n");
                    const length = /content-length: *(\d+)/i.exec(text)?.[1];
                    if (end >= 0 && length && text.length >= end + 4 + Number(length)) return text;
                  }
                }),
              );
              const [head = "", body = ""] = text.split("\r\n\r\n");
              return yield* HttpServerResponse.json({
                statusLine: head.split("\r\n")[0],
                body: JSON.parse(body),
              });
            }
            // The request this Lambda received, proxied to the sandbox as is.
            return yield* port.fetch(request);
          }).pipe(Effect.ensuring(Effect.ignore(agent.terminate())));
        }
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
