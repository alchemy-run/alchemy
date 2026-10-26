import * as Celld from "@alchemy.run/celld";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { Scope } from "effect/Scope";

class Tool extends Celld.Container<Tool>()("Tool", {
  image: "alpine:3.20",
  instanceType: "dev",
  maxInstances: 1,
  ociRuntime: "runsc",
}) {}

interface ProbeReport {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class Probe extends Celld.DurableObject<
  Probe,
  {
    check: () => Effect.Effect<ProbeReport, never, RuntimeContext | Scope>;
  }
>()("Probe") {}

export const probeStartup: Celld.Containers.ContainerStartupOptions = {
  entrypoint: [
    "sh",
    "-c",
    "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n' | nc -l -p 3000 >/dev/null; done",
  ],
  enableInternet: false,
};

export const checkContainer = (tool: Celld.Containers.ContainerClient) =>
  Effect.gen(function* () {
    yield* tool.start(probeStartup);
    yield* tool
      .getTcpPort(3000)
      .pipe(
        Effect.raceFirst(
          tool
            .monitor()
            .pipe(Effect.andThen(Effect.fail(new Error("Container exited before port readiness")))),
        ),
      );
    const process = yield* tool.exec([
      "sh",
      "-c",
      "printf 'celld-runsc-ok\\n'; uname -a; cat /proc/version; dmesg 2>/dev/null | head -n 3; if nc -w 2 169.254.169.254 80 </dev/null; then printf 'FENCE_OPEN\\n'; exit 42; fi; printf 'FENCE_BLOCKED\\n'",
    ]);
    const result = yield* process.output();
    return yield* Effect.sync(() => ({
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      exitCode: result.exitCode,
    }));
  }).pipe(Effect.ensuring(tool.destroy().pipe(Effect.orDie)), Effect.orDie);

const ProbeLive = Probe.make(
  Effect.gen(function* () {
    const tool = yield* Tool;
    return Effect.succeed({ check: () => checkContainer(tool) });
  }).pipe(Effect.provide(Celld.Containers.layer(Tool, probeStartup))),
);

export default class LiveWorker extends Celld.Worker<LiveWorker>()(
  "LiveWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const probes = yield* Probe;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/container")) {
          return yield* HttpServerResponse.json(yield* probes.getByName("live").check());
        }
        return HttpServerResponse.text("celld-ec2-live");
      }),
    };
  }).pipe(Effect.provide(ProbeLive)),
) {}
