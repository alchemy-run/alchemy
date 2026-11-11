// src/MyImage.ts
import * as AWS from "@alchemy.run/aws";

/**
 * The image every sandbox runs: a stock Python image, with no server and no
 * code of ours inside. `isolation: "isolated"` puts each task in its own
 * Nitro Sandbox, and `AWS.ECS.CreateSandbox` adds the agent that lets the
 * host run commands and use files in it.
 */
export const MyImage = AWS.ECS.Task("MyImage", {
  image: "python:3.12-slim",
  cpu: 1024,
  memory: 2048,
  isolation: "isolated",
});
