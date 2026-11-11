import * as AWS from "@alchemy.run/aws";

/**
 * A sandbox that is only a public image: no Effect program, no server and no
 * Bun inside. `AWS.ECS.CreateSandbox` mounts the sandbox agent into its
 * container when a sandbox starts, so the host drives it like any other
 * sandbox and the image is not changed.
 *
 * The image's own process is `python3`, which exits at once without a
 * terminal. The sandbox outlives it.
 */
export const SandboxImage = AWS.ECS.Task("EcsSandboxImage", {
  image: "python:3.12-slim",
  cpu: 1024,
  memory: 2048,
  isolation: "isolated",
});

/**
 * A sandbox built from `sandbox-dockerfile/Dockerfile`, whose image has an
 * `ENTRYPOINT`, a `CMD` and a user of its own. Its sandboxes run the
 * `ENTRYPOINT` as that user, with this `command` in place of the `CMD`.
 */
export const SandboxDockerfile = AWS.ECS.Task("EcsSandboxDockerfile", {
  context: `${import.meta.dirname}/sandbox-dockerfile`,
  command: ["8080", "--directory", "/srv"],
  cpu: 1024,
  memory: 2048,
  isolation: "isolated",
});

/**
 * An isolated Task no `AWS.ECS.CreateSandbox` targets: ECS as AWS ships it.
 * Its task definition has the image's container and nothing else, and a task
 * started with `AWS.ECS.RunTask` runs `command` in its own Nitro Sandbox.
 */
export const PlainIsolated = AWS.ECS.Task("EcsPlainIsolated", {
  image: "python:3.12-slim",
  command: ["python3", "-c", "import time; print('plain'); time.sleep(20)"],
  cpu: 1024,
  memory: 2048,
  isolation: "isolated",
});
