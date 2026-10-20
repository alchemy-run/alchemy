import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import WorkspaceWorker from "./worker.ts";
import TestWorkspaceLive from "./workspace.cloudflare.ts";

export const providers = Cloudflare.providers();
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "WorkspaceStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* WorkspaceWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(TestWorkspaceLive)),
);
