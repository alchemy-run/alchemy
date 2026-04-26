import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export class AlchemyContext extends EffectContext.Service<
  AlchemyContext,
  {
    dotAlchemy: string;
    updateStateStore: boolean;
  }
>()("alchemy/Context") {}

export const AlchemyContextLive = Layer.effect(
  AlchemyContext,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(process.cwd(), ".alchemy");
    yield* fs.makeDirectory(dir, { recursive: true });
    return {
      dotAlchemy: dir,
      updateStateStore: false,
    };
  }),
);
