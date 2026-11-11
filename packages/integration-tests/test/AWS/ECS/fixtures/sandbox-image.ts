import * as AWS from "@alchemy.run/aws";

/**
 * A sandbox that is only an image: no Effect program, no server and no Bun
 * inside. `AWS.ECS.CreateSandbox` adds the sandbox agent to it, with the
 * agent's own runtime, so the host drives it like any other sandbox.
 */
export const SandboxImage = AWS.ECS.Task("EcsSandboxImage", {
  image: "python:3.12-slim",
  cpu: 1024,
  memory: 2048,
  isolation: "isolated",
});
