import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PostsApi } from "./chat/PostsApi.ts";
import { CallsApi } from "./chat/CallsApi.ts";
import { Interrupt } from "./chat/Interrupt.ts";
import { PostMessage } from "./chat/PostMessage.ts";
import { Transcript } from "./chat/Transcript.ts";
import { ChannelsApi } from "./chat/ChannelsApi.ts";
import { IssuesApi } from "./forge/IssuesApi.ts";
import { PullsApi } from "./forge/PullsApi.ts";
import { SeedApi } from "./forge/SeedApi.ts";
import { SyncApi } from "./forge/Sync.ts";
import { StatusApi } from "./github/StatusApi.ts";
import { OrgApi } from "./OrgApi.ts";
import { TreeApi } from "./forge/TreeApi.ts";
import { SwarmApi } from "./SwarmApi.ts";
import { DecideApi } from "./proposals/DecideApi.ts";
import { ExecApi } from "./sandbox/ExecApi.ts";

/**
 * THE API — a composition, not a file. Every route lives in its own
 * domain-named file beside the domain it serves (chat/, engineering/,
 * proposals/, sandbox/, github/); this is just the sum. Each route is
 * free to be implemented anywhere — today one Worker serves all of
 * them (ApiWorker.ts); an ApiLambda.ts would provide the same Api
 * different physics.
 *
 * The SOCKETS (`/attach/:term/:key`, `/terminal/:term/:key`,
 * `/api/calls/:id/live`) are WebSocket upgrades and ride the host's
 * fetch prelude (ApiWorker.ts), not the router.
 */
export const Api = Effect.gen(function* () {
  return Layer.mergeAll(
    yield* PostMessage,
    yield* Transcript,
    yield* Interrupt,
    yield* CallsApi,
    yield* PostsApi,
    yield* ChannelsApi,
    yield* DecideApi,
    yield* ExecApi,
    yield* SeedApi,
    yield* SyncApi,
    yield* IssuesApi,
    yield* PullsApi,
    yield* StatusApi,
    yield* OrgApi,
    yield* SwarmApi,
    yield* TreeApi,
  );
});
