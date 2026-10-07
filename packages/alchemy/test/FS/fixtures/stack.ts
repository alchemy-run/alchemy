import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cloudflare from "@/Cloudflare";
import * as Git from "@/Git/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
import TestGitHost from "../../Git/fixtures/stack.ts";
import MountBoxLive from "./container.runtime.ts";
import MountWorker from "./worker.ts";

export const providers = Layer.mergeAll(
  Cloudflare.providers(),
  Git.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "FSMountStack",
  { providers, state },
  Effect.gen(function* () {
    const host = yield* TestGitHost;
    const worker = yield* MountWorker;
    return { url: worker.url.as<string>(), gitUrl: host.url.as<string>() };
  }).pipe(Effect.provide(MountBoxLive)),
);
