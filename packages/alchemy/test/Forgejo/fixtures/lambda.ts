import * as Lambda from "@/AWS/Lambda/index.ts";
import * as Effect from "effect/Effect";
import { program } from "./program.ts";

export class ForgejoFunction extends Lambda.Function<ForgejoFunction>()(
  "ForgejoFunction",
) {}
export default ForgejoFunction.make(
  { main: import.meta.url, functionUrl: true },
  program.pipe(Effect.provide(Lambda.ForgejoBindings)),
);
