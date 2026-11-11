import * as AWS from "@alchemy.run/aws";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import SandboxAgent from "./sandbox-agent.ts";

/**
 * Infrastructure of the `AWS.ECS.CreateSandbox` suite. Each export declares a
 * resource; the stack program and the host's Construction phase both yield
 * them and converge on one instance.
 */

/**
 * Private subnets behind one NAT gateway. The host Lambda calls the ECS API
 * from inside the VPC, and ECS instances pull the sandbox image, so both need
 * a route out.
 */
export const SandboxNetwork = AWS.EC2.Network("EcsSandboxNetwork", {
  cidrBlock: "10.67.0.0/16",
  nat: "single",
});

export const SandboxCluster = AWS.ECS.Cluster("EcsSandboxCluster", {});

/**
 * Managed Instances capacity with nothing but subnets and
 * `nitroEnclavesEnabled`: the roles, the instance profile and the instance
 * types are the provider's defaults.
 */
export const SandboxCapacity = Effect.gen(function* () {
  const cluster = yield* SandboxCluster;
  const network = yield* SandboxNetwork;
  return yield* AWS.ECS.CapacityProvider("EcsSandboxCapacity", {
    cluster: cluster.clusterName,
    managedInstancesProvider: {
      instanceLaunchTemplate: {
        networkConfiguration: { subnets: network.privateSubnetIds },
        nitroEnclavesEnabled: true,
      },
    },
  });
});

/** The route's result as JSON, or the failure as a 500 the test can read. */
const respond = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flatMap((body) => HttpServerResponse.json(body)),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
    ),
    Effect.orDie,
  );

const decoder = new TextDecoder();

/**
 * The host of the suite's sandboxes: a Lambda Function with one route per
 * sandbox operation. The binding attaches it to the capacity's subnets.
 */
export default class SandboxHost extends AWS.Lambda.Function<SandboxHost>()(
  "EcsSandboxHost",
  {
    main: import.meta.filename,
    functionUrl: true,
    // The first sandbox waits for ECS to launch an instance.
    timeout: Duration.seconds(285),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const capacity = yield* SandboxCapacity;
    const sandboxes = yield* AWS.ECS.CreateSandbox(capacity, SandboxAgent);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://host");
        const param = (name: string) => url.searchParams.get(name) ?? "";

        if (url.pathname === "/create") {
          const idle = url.searchParams.get("idle");
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.create({
                tags: { user: param("user") },
                env: { SANDBOX_GREETING: "from the host" },
                startTimeout: "4 minutes",
                ...(idle === null ? {} : { idleTimeout: Duration.seconds(Number(idle)) }),
              });
              return { taskArn: sandbox.taskArn, privateIp: sandbox.privateIp };
            }),
          );
        }

        if (url.pathname === "/list") {
          return yield* respond(sandboxes.list({ tags: { user: param("user") } }));
        }

        if (url.pathname === "/exec") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              yield* sandbox.files.write("/work/hello.ts", `console.log("hi " + Bun.argv[2])`);
              const run = yield* sandbox.exec("bun hello.ts sam", { cwd: "/work" });
              const failed = yield* sandbox.exec(["sh", "-c", "echo oops >&2; exit 3"]);
              const env = yield* sandbox.exec("echo $SANDBOX_GREETING/$EXTRA", {
                env: { EXTRA: "per call" },
              });
              return {
                run,
                failed,
                env: env.stdout,
                readBack: yield* sandbox.files.readText("/work/hello.ts"),
                entries: yield* sandbox.files.list("/work"),
              };
            }),
          );
        }

        if (url.pathname === "/hello") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              return { greeting: yield* sandbox.hello(param("name")) };
            }),
          );
        }

        if (url.pathname === "/process") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              const process = yield* sandbox.start(["sh", "-c", "echo one; sleep 1; echo two"]);
              const chunks = yield* Stream.runCollect(process.output);
              const exit = yield* process.wait;
              return {
                exitCode: exit.exitCode,
                stdout: Array.from(chunks)
                  .filter((chunk) => chunk.fd === "stdout")
                  .map((chunk) => decoder.decode(chunk.data))
                  .join(""),
              };
            }),
          );
        }

        if (url.pathname === "/pty") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              const pty = yield* sandbox.pty.open({ cols: 80, rows: 24 });
              const output = yield* pty.output.pipe(
                Stream.map((chunk) => decoder.decode(chunk)),
                Stream.mkString,
                Effect.forkScoped,
              );
              yield* pty.resize({ cols: 100, rows: 30 });
              // The shell exits, which ends the terminal's output.
              yield* pty.write("echo pty-$((6*7)); stty size; exit\n");
              return { output: yield* Fiber.join(output).pipe(Effect.timeout("20 seconds")) };
            }).pipe(Effect.scoped),
          );
        }

        if (url.pathname === "/port") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              // The Task's own port, which its program listens on.
              const main = yield* sandbox.getTcpPort(3000);
              const health = yield* main.fetch(HttpClientRequest.get("/health"));
              const echo = yield* main.fetch(HttpClientRequest.get("/some/path"));
              // A port the task definition never mapped: a server the host
              // starts inside the sandbox.
              const server = yield* sandbox.start([
                "bun",
                "-e",
                `Bun.serve({ port: 8080, fetch: (request) => new Response("from 8080 " + new URL(request.url).pathname) })`,
              ]);
              const other = yield* sandbox.getTcpPort(8080);
              const started = yield* other.fetch(HttpClientRequest.get("/started")).pipe(
                Effect.timeout("3 seconds"),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 10 }),
                Effect.flatMap((response) => response.text),
                Effect.ensuring(Effect.ignore(server.kill("SIGKILL"))),
              );
              return {
                url: main.url,
                health: health.status,
                echo: yield* echo.text,
                started,
              };
            }),
          );
        }

        if (url.pathname === "/unauthorized") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              // A port fetch carries no token, so the sandbox's methods
              // refuse it.
              const port = yield* sandbox.getTcpPort(3000);
              const exec = yield* port.fetch(
                HttpClientRequest.post("/__rpc__/sandbox.exec").pipe(
                  HttpClientRequest.bodyJsonUnsafe(["id"]),
                ),
              );
              const method = yield* port.fetch(
                HttpClientRequest.post("/__rpc__/hello").pipe(
                  HttpClientRequest.bodyJsonUnsafe(["sam"]),
                ),
              );
              return { exec: exec.status, method: method.status };
            }),
          );
        }

        if (url.pathname === "/kill") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* sandboxes.connect(param("taskArn"));
              yield* sandbox.kill();
              return { killed: sandbox.taskArn };
            }),
          );
        }

        if (url.pathname === "/connect") {
          return yield* respond(
            sandboxes.connect(param("taskArn")).pipe(
              Effect.map((sandbox) => ({ found: true, privateIp: sandbox.privateIp })),
              Effect.catchTag("EcsSandboxNotFound", () => Effect.succeed({ found: false })),
            ),
          );
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(AWS.ECS.CreateSandboxHttp)),
) {}
