import * as Lambda from "@/AWS/Lambda/index.ts";
import { RepositoryEventSourceLambda } from "alchemy/Forgejo/RepositoryEventSourceLambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBindings } from "./http.ts";
import { program } from "./program.ts";

export class ForgejoFunction extends Lambda.Function<ForgejoFunction>()(
  "ForgejoFunction",
) {}
export default ForgejoFunction.make(
  { main: import.meta.url, functionUrl: true },
  program.pipe(
    Effect.provide(Layer.mergeAll(HttpBindings, RepositoryEventSourceLambda)),
  ),
);
