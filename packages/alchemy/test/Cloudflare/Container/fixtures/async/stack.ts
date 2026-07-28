import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import type { AsyncEchoObject } from "./worker.ts";

/**
 * A Container bound directly in an async Worker's `env` (issue #953): the
 * Container IS the Durable Object binding plus its ContainerApplication.
 * The class implementation ships inside the worker script (from
 * `@cloudflare/containers`); `className` names the exported class since it
 * differs from the binding name (`ECHO`).
 */
export const AsyncContainerWorker = Cloudflare.Worker("AsyncContainerWorker", {
  main: path.resolve(import.meta.dirname, "worker.ts"),
  env: {
    ECHO: Cloudflare.Container<AsyncEchoObject>("AsyncEchoContainer", {
      className: "AsyncEchoObject",
      image: "mendhak/http-https-echo:latest",
      observability: { logs: { enabled: true } },
    }),
  },
});

export default Alchemy.Stack(
  "AsyncContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* AsyncContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
