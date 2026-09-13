import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsksApi } from "./chat/AsksApi.ts";
import { CallsApi } from "./chat/CallsApi.ts";
import { Interrupt } from "./chat/Interrupt.ts";
import { Models } from "./chat/Models.ts";
import { PostMessage } from "./chat/PostMessage.ts";
import { Transcript } from "./chat/Transcript.ts";
import { ChannelsApi } from "./chat/ChannelsApi.ts";
import { TasksApi } from "./engineering/TasksApi.ts";
import { StatusApi } from "./github/StatusApi.ts";
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
    yield* Models,
    yield* CallsApi,
    yield* AsksApi,
    yield* TasksApi,
    yield* ChannelsApi,
    yield* DecideApi,
    yield* ExecApi,
    yield* StatusApi,
  );
});
