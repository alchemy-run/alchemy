import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import type { To } from "../../policy.ts";
import { Worker } from "../worker/worker.ts";
import type { Queue, QueueProps } from "./queue.ts";

export interface Bind<B = Queue<string, QueueProps>>
  extends Capability<"Cloudflare.Queue.Bind", B> {}

export const Bind = Binding<
  <B extends Queue<string, QueueProps>>(queue: B) => Binding<Worker, Bind<To<B>>>
>(Worker, "Cloudflare.Queue.Bind");

export const bindFromWorker = () =>
  Bind.provider.succeed({
    attach: ({ source }) => ({
      bindings: [
        {
          type: "queue",
          name: source.id,
          queue_name: source.attr.queueName,
        },
      ],
    }),
  });
