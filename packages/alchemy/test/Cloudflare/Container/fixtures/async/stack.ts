import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as path from "pathe";

/**
 * Container backing the async Worker's `AsyncEchoObject` class. The class
 * implementation ships inside the worker script (from `@cloudflare/containers`),
 * so the stack only declares the application and attaches it to the Durable
 * Object binding via the `container` prop (issue #953).
 */
const EchoContainer = Cloudflare.Container("AsyncEchoContainer", {
  image: "mendhak/http-https-echo:latest",
  observability: { logs: { enabled: true } },
});

export default Alchemy.Stack(
  "AsyncContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("AsyncContainerWorker", {
      main: path.resolve(import.meta.dirname, "worker.ts"),
      env: {
        ECHO: Cloudflare.DurableObject("AsyncEchoObject", {
          container: EchoContainer,
        }),
      },
    });
    return { url: worker.url.as<string>() };
  }),
);
