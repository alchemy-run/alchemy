import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { program } from "./program.ts";

export default class ForgejoWorker extends Cloudflare.Worker<ForgejoWorker>()(
  "ForgejoWorker",
  { main: import.meta.url },
  program.pipe(Effect.provide(Cloudflare.ForgejoBindings)),
) {}
