import * as Cloudflare from "@/Cloudflare/index.ts";
import { RepositoryEventSourceCloudflare } from "alchemy/Forgejo/RepositoryEventSourceCloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBindings } from "./http.ts";
import { program } from "./program.ts";

export default class ForgejoWorker extends Cloudflare.Worker<ForgejoWorker>()(
  "ForgejoWorker",
  { main: import.meta.url },
  program.pipe(
    Effect.provide(
      Layer.mergeAll(HttpBindings, RepositoryEventSourceCloudflare),
    ),
  ),
) {}
