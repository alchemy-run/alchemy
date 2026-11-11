/**
 * Process bootstrap of the sandbox agent that `AWS.ECS.CreateSandbox` runs in
 * a Task that is only an image. The agent is an image of its own: ECS mounts
 * it into the Task's container when a task starts, so the Task's image is
 * never changed. The generated entry imports this module and nothing else,
 * and the agent runs as the container's first process.
 */
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { runProcess } from "alchemy/Runtime/Bootstrap";
import { runSandboxAgent } from "alchemy/SandboxAgent";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

/**
 * Serve the sandbox agent on a Bun HTTP server and start the image's own
 * process: its `ENTRYPOINT` and `CMD`, or the Task's `command` in place of
 * the `CMD`. It arrives as this process's arguments.
 */
export const bootstrap = (): Promise<void> =>
  runProcess(
    "Sandbox",
    runSandboxAgent(process.argv.slice(2)).pipe(
      Effect.provide(
        BunHttpServer().pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              BunServices.layer,
              FetchHttpClient.layer,
              Logger.layer([Logger.consolePretty()]),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
