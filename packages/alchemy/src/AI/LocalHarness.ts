import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type { Container } from "../Cloudflare/Containers/Container.ts";
import type { ContainerApplication } from "../Cloudflare/Containers/ContainerApplication.ts";
import { Worker } from "../Cloudflare/Workers/Worker.ts";
import { WorkerEnvironment } from "../Cloudflare/Workers/WorkerRuntime.ts";
import { Harness, SessionError } from "./Session.ts";
import { connectHarness } from "./SessionRpcs.ts";

/**
 * Provides `AI.Harness` by running a container's program **on this
 * machine** under `alchemy dev`, instead of in a container per session.
 *
 * The Sandbox's bundled program runs as one local process (restarted on
 * code changes) and serves every session. Each session works in its own
 * `git worktree` of each mounted repository, under
 * `.alchemy/worktrees/<session>/`, with the repository's dependencies and
 * build outputs already in place. The Durable Object reaches the process
 * over HTTP. Use the same Sandbox as `Cloudflare.ContainerHarness`, so dev
 * and deploy run the same program.
 *
 * ### Developing locally, deploying to containers
 * **Example:** Pick the harness with `ALCHEMY_DEV`
 * ```typescript
 * const HarnessLive = Layer.unwrap(
 *   Effect.gen(function* () {
 *     return (yield* Alchemy.ALCHEMY_DEV)
 *       ? AI.LocalHarness(Sandbox)
 *       : Cloudflare.ContainerHarness(Sandbox);
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Harness
 * @category AI
 */
export const LocalHarness = <C extends Container.Decl.Any>(container: C): Layer.Layer<Harness> =>
  Layer.effect(
    Harness,
    Effect.gen(function* () {
      const id = (container as unknown as { "~alchemy/Id": string })["~alchemy/Id"];
      const name = `ALCHEMY_LOCAL_HARNESS_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Run the container's program on this machine, and hand its URL to
        // the Worker hosting this Durable Object.
        const application = (yield* (
          container as unknown as { Application: Effect.Effect<ContainerApplication> }
        ).Application) as ContainerApplication;
        yield* application.bind`LocalHarness`({ devHost: true });
        const worker = yield* Worker;
        yield* worker.bind`${name}`({
          bindings: [
            { type: "plain_text", name, text: application.devHostUrl as unknown as string },
          ],
        });
        return Effect.die(new Error("AI.LocalHarness connects only at runtime"));
      }
      const env = yield* WorkerEnvironment;
      const http = yield* HttpClient.HttpClient;
      return Effect.suspend(() => {
        const url = env[name] as string | undefined;
        return url
          ? connectHarness(http, { url })
          : Effect.fail(
              new SessionError({
                message: `${name} is not bound: is the Sandbox's program running locally?`,
              }),
            );
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer)) as Layer.Layer<Harness>;
