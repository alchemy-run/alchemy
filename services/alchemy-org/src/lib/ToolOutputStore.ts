import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface OutputArtifact {
  readonly id: string;
  readonly append: (chunk: string) => Effect.Effect<void, string>;
}

export class ToolOutputStore extends Context.Service<
  ToolOutputStore,
  {
    readonly create: (label: string) => Effect.Effect<OutputArtifact, string>;
    readonly read: (id: string) => Effect.Effect<string, string>;
    readonly size: (id: string) => Effect.Effect<number, string>;
  }
>()("alchemy-org/ToolOutputStore") {}

