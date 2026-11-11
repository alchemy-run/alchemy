/**
 * Process bootstrap for an `AWS.ECS.Task` built from an image that
 * `AWS.ECS.CreateSandbox` turns into sandboxes. The image has no program of
 * its own, so the generated entry imports this module and nothing else, and
 * the sandbox agent runs as the container's first process.
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
 * Serve the sandbox agent on a Bun HTTP server and start the Task's
 * `command`, which arrives as this process's arguments.
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
