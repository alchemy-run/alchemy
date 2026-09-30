import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import type { Sandbox } from "./worker.ts";

/**
 * A Durable Object-managed container (`schedulingPolicy: "durable_object"`):
 * the application carries no image. Two named images are published with the
 * Worker, and the `Sandbox` Durable Object picks one per request through
 * `ctx.container.images` — one Durable Object per image, so each runs the
 * image it was asked for.
 */
export const DurableObjectContainerWorker = Cloudflare.Worker(
  "DurableObjectContainerWorker",
  {
    main: path.resolve(import.meta.dirname, "worker.ts"),
    env: {
      SANDBOX: Cloudflare.Container<Sandbox>("SANDBOX", {
        className: "Sandbox",
        schedulingPolicy: "durable_object",
        images: {
          echo: { image: "mendhak/http-https-echo:latest" },
          whoami: { image: "traefik/whoami:latest" },
        },
        observability: { logs: { enabled: true } },
      }),
    },
  },
);

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "DurableObjectContainerStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* DurableObjectContainerWorker;
      return {
        url: worker.url.as<string>(),
        accountId: worker.accountId,
      };
    }),
  );
