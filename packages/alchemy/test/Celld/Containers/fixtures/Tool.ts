import { Container } from "@/Celld/Containers/Container.ts";
import type * as Effect from "effect/Effect";

export class Tool extends Container<
  Tool,
  {
    ping(): Effect.Effect<string>;
  }
>()("Tool", { runtime: "bun", ociRuntime: "runsc", maxInstances: 4 }) {}
