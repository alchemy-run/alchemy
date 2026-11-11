import * as AWS from "@alchemy.run/aws";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import SandboxAgent from "./sandbox-agent.ts";
import { PlainIsolated, SandboxDockerfile, SandboxImage } from "./sandbox-image.ts";

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
 *
 * It creates sandboxes of three Tasks on one capacity provider: an Effect
 * program and two plain images. `?kind=image` picks the sandboxes of a public
 * image, `?kind=dockerfile` those of an image built from a Dockerfile.
 *
 * `/run` starts a task with `AWS.ECS.RunTask` instead, the way a host does
 * without `AWS.ECS.CreateSandbox`: no token, no tags, no handle.
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
    const images = yield* AWS.ECS.CreateSandbox(capacity, SandboxImage);
    const dockerfiles = yield* AWS.ECS.CreateSandbox(capacity, SandboxDockerfile);

    // The plain ECS operation, on a Task no sandbox binding targets and on
    // one that a sandbox binding does.
    const cluster = yield* SandboxCluster;
    const sandboxImage = yield* SandboxImage;
    const runPlain = yield* AWS.ECS.RunTask(cluster, PlainIsolated);
    const runImage = yield* AWS.ECS.RunTask(cluster, sandboxImage);
    const CapacityName = yield* capacity.name;
    const Subnets = yield* capacity.subnets;
    const ImageContainer = yield* sandboxImage.containerName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://host");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const kind = param("kind");
        const image = kind === "image";
        const pool = image ? images : kind === "dockerfile" ? dockerfiles : sandboxes;

        if (url.pathname === "/create") {
          const idle = url.searchParams.get("idle");
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* pool.create({
                tags: { user: param("user") },
                env: { SANDBOX_GREETING: "from the host" },
                startTimeout: "4 minutes",
                ...(idle === null ? {} : { idleTimeout: Duration.seconds(Number(idle)) }),
              });
              return { taskArn: sandbox.taskArn, privateIp: sandbox.privateIp };
            }),
          );
        }

        if (url.pathname === "/run") {
          return yield* respond(
            Effect.gen(function* () {
              const placement = {
                count: 1,
                capacityProviderStrategy: [{ capacityProvider: yield* CapacityName, weight: 1 }],
                networkConfiguration: { awsvpcConfiguration: { subnets: yield* Subnets } },
              };
              const response = image
                ? yield* runImage({
                    ...placement,
                    overrides: {
                      containerOverrides: [
                        {
                          name: yield* ImageContainer,
                          command: ["python3", "-c", "import sys; sys.exit(7)"],
                        },
                      ],
                    },
                  })
                : yield* runPlain(placement);
              return {
                taskArn: response.tasks?.[0]?.taskArn,
                failures: response.failures ?? [],
              };
            }),
          );
        }

        if (url.pathname === "/list") {
          return yield* respond(pool.list({ tags: { user: param("user") } }));
        }

        if (url.pathname === "/exec") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* pool.connect(param("taskArn"));
              // The image has Python and no Bun.
              const file = image ? "/work/hello.py" : "/work/hello.ts";
              yield* sandbox.files.write(
                file,
                image
                  ? `import sys; print("hi " + sys.argv[1])`
                  : `console.log("hi " + Bun.argv[2])`,
              );
              const run = yield* sandbox.exec(image ? "python3 hello.py sam" : "bun hello.ts sam", {
                cwd: "/work",
              });
              const failed = yield* sandbox.exec(["sh", "-c", "echo oops >&2; exit 3"]);
              const env = yield* sandbox.exec("echo $SANDBOX_GREETING/$EXTRA", {
                env: { EXTRA: "per call" },
              });
              return {
                run,
                failed,
                env: env.stdout,
                readBack: yield* sandbox.files.readText(file),
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
              const sandbox = yield* pool.connect(param("taskArn"));
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
              const sandbox = yield* pool.connect(param("taskArn"));
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

        if (url.pathname === "/image") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* images.connect(param("taskArn"));
              // Nothing of the agent's is on the image's PATH, and the image
              // cannot write to where the agent is mounted.
              const bun = yield* sandbox.exec("command -v bun");
              const mount = yield* sandbox.exec("touch /opt/alchemy/sandbox/probe");
              const python = yield* sandbox.exec(["python3", "-c", "print(6 * 7)"]);
              // The image's own process has exited, so the host starts a server.
              yield* sandbox.files.write("/srv/index.txt", "from 8080");
              const server = yield* sandbox.start([
                "python3",
                "-m",
                "http.server",
                "8080",
                "--directory",
                "/srv",
              ]);
              const port = yield* sandbox.getTcpPort(8080);
              const served = yield* port.fetch(HttpClientRequest.get("/index.txt")).pipe(
                Effect.timeout("3 seconds"),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 10 }),
                Effect.flatMap((response) => response.text),
                Effect.ensuring(Effect.ignore(server.kill("SIGKILL"))),
              );
              return { bun: bun.exitCode, mount, python: python.stdout, served };
            }),
          );
        }

        if (url.pathname === "/served") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* dockerfiles.connect(param("taskArn"));
              // A server the sandbox started by itself: the host only calls it.
              const port = yield* sandbox.getTcpPort(8080);
              const served = yield* port.fetch(HttpClientRequest.get("/index.txt")).pipe(
                Effect.timeout("3 seconds"),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 10 }),
                Effect.flatMap((response) => response.text),
              );
              const user = yield* sandbox.exec("id -un");
              return { served, user: user.stdout };
            }),
          );
        }

        if (url.pathname === "/unauthorized") {
          return yield* respond(
            Effect.gen(function* () {
              const sandbox = yield* pool.connect(param("taskArn"));
              // A port fetch carries no token, so the sandbox's methods
              // refuse it. An image's agent listens on its own port.
              const port = yield* sandbox.getTcpPort(image ? 2468 : 3000);
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
              const sandbox = yield* pool.connect(param("taskArn"));
              yield* sandbox.kill();
              return { killed: sandbox.taskArn };
            }),
          );
        }

        if (url.pathname === "/connect") {
          return yield* respond(
            pool.connect(param("taskArn")).pipe(
              Effect.map((sandbox) => ({ found: true, privateIp: sandbox.privateIp })),
              Effect.catchTag("EcsSandboxNotFound", () => Effect.succeed({ found: false })),
            ),
          );
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AWS.ECS.CreateSandboxHttp, AWS.ECS.RunTaskHttp))),
) {}
