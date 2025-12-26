import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import type { To } from "../../policy.ts";
import { Worker } from "../worker/worker.ts";
import type { Database, DatabaseProps } from "./database.ts";

export interface Bind<B = Database<string, DatabaseProps>>
  extends Capability<"Cloudflare.D1.Database.Bind", B> {}

export const Bind = Binding<
  <B extends Database<string, DatabaseProps>>(
    database: B,
  ) => Binding<Worker, Bind<To<B>>>
>(Worker, "Cloudflare.D1.Database.Bind");

export const bindFromWorker = () =>
  Bind.provider.succeed({
    attach: ({ source }) => ({
      bindings: [
        {
          type: "d1",
          name: source.id,
          id: source.attr.databaseId,
        },
      ],
    }),
  });
