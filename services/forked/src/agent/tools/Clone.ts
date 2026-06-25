import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Sandbox } from "../Sandbox.ts";

export const url = AI.Parameter("url", S.String)`
The git remote URL to clone.`;

export const dir = AI.Parameter("dir")(S.String.pipe(S.optional))`
The directory to clone into, relative to the workspace root. Defaults to the
workspace root.`;

export class Clone extends AI.Tool<Clone>()("clone")`
Clone a git repository from ${url} into ${dir}. Use this to pull down a post's
repository before working on it.` {}

export const CloneLive = Layer.effect(
  Clone,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    return Effect.fn("clone")(function* (params) {
      const { url, dir } = params as { url: string; dir?: string };
      return yield* sandbox.clone(url, dir);
    });
  }),
);
