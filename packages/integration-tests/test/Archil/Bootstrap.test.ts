import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "@alchemy.run/test";
import { nodeLoaderArgs } from "alchemy/Util/Node";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

interface Collector {
  readonly server: Server;
  readonly port: number;
  readonly bodies: string[];
}

const startCollector = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<Collector>((resolve) => {
        const bodies: string[] = [];
        const server = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            if (request.url === "/v1/traces") bodies.push(Buffer.concat(chunks).toString("utf8"));
            response.writeHead(200, { "content-type": "application/json" }).end("{}");
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({ server, bodies, port: (server.address() as AddressInfo).port }),
        );
      }),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

const spanNames = (bodies: readonly string[]): string[] =>
  bodies
    .flatMap((body) => JSON.parse(body).resourceSpans ?? [])
    .flatMap((resource: any) => resource.scopeSpans ?? [])
    .flatMap((scope: any) => scope.spans ?? [])
    .map((span: { name: string }) => span.name);

describe.sequential("Archil.Sandbox bootstrap", { tags: ["provider:archil", "local"] }, () => {
  it.live(
    "exports the program's spans to ALCHEMY_OTEL_EXPORTERS",
    () =>
      Effect.gen(function* () {
        const collector = yield* startCollector;
        const path = yield* Path.Path;
        const fixture = yield* path.fromFileUrl(
          new URL("./fixtures/bootstrap-telemetry.ts", import.meta.url),
        );
        const args = yield* Effect.sync(() => nodeLoaderArgs(fixture));
        const handle = yield* ChildProcess.make("node", [...args, fixture], {
          env: {
            ALCHEMY_STACK_NAME: "archil-bootstrap",
            ALCHEMY_STAGE: "test",
            ALCHEMY_OTEL_EXPORTERS: JSON.stringify([
              { traces: { url: `http://127.0.0.1:${collector.port}/v1/traces` } },
            ]),
          },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGKILL",
        });
        const output: string[] = [];
        yield* Stream.merge(handle.stdout, handle.stderr).pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) => Effect.sync(() => void output.push(chunk))),
          Effect.forkScoped,
        );
        const names = yield* Effect.sync(() => spanNames(collector.bodies)).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (found) => found.includes("archil-bootstrap-telemetry"),
            times: 40,
          }),
          Effect.tapError(() => Effect.logError(output.join(""))),
        );
        expect(names).toContain("archil-bootstrap-telemetry");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 60_000 },
  );
});
