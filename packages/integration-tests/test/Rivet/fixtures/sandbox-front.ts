/**
 * The front of the agentOS Sandbox suite: a Docker service on the control
 * plane's network that drives agentOS VMs through the gateway, one route per
 * behaviour. `/<step>/<key>` runs `step` on the VM addressed by `key`.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Registry from "@alchemy.run/rivet/Registry";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { SandboxControlPlane, SandboxServices } from "./sandbox-cluster.ts";

const decoder = new TextDecoder();

export default class SandboxFront extends Docker.Service<SandboxFront>()(
  "RivetSandboxFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
    };
  }).pipe(Effect.provide(SandboxControlPlane)),
  Effect.gen(function* () {
    const base = yield* Rivet.SandboxTemplate("Agent", {
      software: [Registry.Jq],
      environment: { GREETING: "hello from the template" },
    });
    const sandboxes = yield* Rivet.CreateSandbox(base);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [, step, key] = url.pathname.split("/");
        if (step === "ready") return HttpServerResponse.text("ok");
        if (!key) return HttpServerResponse.text("Not Found", { status: 404 });
        const sandbox = sandboxes.getOrCreate(key);
        switch (step) {
          case "exec":
            return yield* HttpServerResponse.json(
              yield* sandbox.exec(url.searchParams.get("command") ?? "true"),
            );
          case "env":
            return yield* HttpServerResponse.json(
              yield* sandbox.exec(["sh", "-c", "echo $GREETING"]),
            );
          case "jq":
            return yield* HttpServerResponse.json(
              yield* sandbox.exec(["sh", "-c", "echo '{\"a\":41}' | jq '.a + 1'"]),
            );
          case "write":
            yield* sandbox.files.makeDir("/home/agentos/notes");
            yield* sandbox.files.write(
              "/home/agentos/notes/a.txt",
              url.searchParams.get("text") ?? "",
            );
            return yield* HttpServerResponse.json({ ok: true });
          case "read":
            return yield* HttpServerResponse.json({
              text: yield* sandbox.files.readText("/home/agentos/notes/a.txt"),
              list: yield* sandbox.files.list("/home/agentos/notes"),
              stat: yield* sandbox.files.stat("/home/agentos/notes/a.txt"),
            });
          case "remove":
            yield* sandbox.files.remove("/home/agentos/notes");
            return yield* HttpServerResponse.json({
              exists:
                (yield* sandbox.exec(["sh", "-c", "test -e /home/agentos/notes"])).exitCode === 0,
            });
          case "stream": {
            // A process that writes to both streams, read as it runs.
            const process = yield* sandbox.start([
              "sh",
              "-c",
              "echo one; echo two >&2; echo three",
            ]);
            const chunks = yield* process.output.pipe(Stream.runCollect);
            const { exitCode } = yield* process.wait;
            return yield* HttpServerResponse.json({
              exitCode,
              stdout: chunks
                .filter((c) => c.fd === "stdout")
                .map((c) => decoder.decode(c.data))
                .join(""),
              stderr: chunks
                .filter((c) => c.fd === "stderr")
                .map((c) => decoder.decode(c.data))
                .join(""),
            });
          }
          case "port": {
            // A server inside the VM, reached through agentOS's fetch.
            const server = yield* sandbox.start([
              "node",
              "-e",
              "require('http').createServer((q,s)=>s.end('pong '+q.url)).listen(8080)",
            ]);
            const port = yield* sandbox.getTcpPort(8080);
            const response = yield* port.fetch(HttpClientRequest.get("/ping")).pipe(
              // The server takes a moment to listen.
              Effect.retry({ times: 20, schedule: Schedule.spaced("250 millis") }),
            );
            const text = yield* response.text;
            yield* server.kill("SIGKILL");
            return yield* HttpServerResponse.json({ status: response.status, text });
          }
          case "destroy":
            yield* sandbox.destroy();
            return yield* HttpServerResponse.json({ ok: true });
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(SandboxServices)),
) {}
