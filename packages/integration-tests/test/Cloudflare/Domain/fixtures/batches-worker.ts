import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Answer,
  AnswererLive,
  Batches,
  GroupId,
  Ping,
  PingCount,
  Pinger,
  Pongs,
  PongWriterLive,
  Reset,
} from "./batches.ts";

const BatchesLive = Batches.layer(Layer.mergeAll(PongWriterLive, AnswererLive)).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * `POST /ping/<group>/<id>[?slow=true&reset=<object>&answer=<how>&commandId=<id>]`
 * sends a ping; `GET /pongs/<group>` lists the group's pongs and
 * `GET /count/<group>` how many pings its {@link PingCount} has seen.
 */
const ROUTE = /^\/(ping|pongs|count)\/([^/]+)(?:\/([^/]+))?$/;

export default class DomainBatchesWorker extends Cloudflare.Worker<DomainBatchesWorker>()(
  "DomainBatchesWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const pingers = yield* Pinger;
    const pongs = yield* Pongs;
    const counts = yield* PingCount;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const route = ROUTE.exec(url.pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const group = GroupId.make(decodeURIComponent(route[2]!));
        if (route[1] === "ping") {
          const commandId = url.searchParams.get("commandId");
          yield* pingers.send(
            new Ping({
              id: decodeURIComponent(route[3]!),
              group,
              slow: url.searchParams.get("slow") === "true",
              reset: yield* Schema.decodeUnknownEffect(Reset)(
                url.searchParams.get("reset") ?? "none",
              ).pipe(Effect.orDie),
              answer: yield* Schema.decodeUnknownEffect(Answer)(
                url.searchParams.get("answer") ?? "none",
              ).pipe(Effect.orDie),
            }),
            commandId === null ? undefined : { commandId },
          );
          return HttpServerResponse.text("ok");
        }
        if (route[1] === "count") {
          const count = yield* counts.get(group);
          return yield* HttpServerResponse.json(
            Option.match(count, {
              onNone: () => 0,
              onSome: (s) => s.pings,
            }),
          );
        }
        const { entries } = yield* pongs.list(group);
        return yield* HttpServerResponse.json(entries.map((entry) => entry.event.ping));
      }),
    };
  }).pipe(Effect.provide(BatchesLive)),
) {}
