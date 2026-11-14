import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import {
  Batches,
  Counts,
  CountWriter,
  CountWriterLive,
  GroupId,
  Ping,
  Pinger,
  Pongs,
  PongWriterLive,
} from "./batches.ts";

const BatchesLive = Batches.layer(Layer.mergeAll(PongWriterLive, CountWriterLive)).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * `POST /ping/<group>/<id>[?slow=true]` sends a ping; `GET /pongs/<group>` lists the group's pongs.
 * `POST /count/<group>/<id>?n=<n>` sends a ping, waits for `CountWriter.caughtUp`, then lists the group's counts.
 */
const ROUTE = /^\/(ping|pongs|count)\/([^/]+)(?:\/([^/]+))?$/;

export default class DomainBatchesWorker extends Cloudflare.Worker<DomainBatchesWorker>()(
  "DomainBatchesWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const pingers = yield* Pinger;
    const pongs = yield* Pongs;
    const counts = yield* Counts;
    const progress = yield* CountWriter.Progress;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const route = ROUTE.exec(url.pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const group = GroupId.make(decodeURIComponent(route[2]!));
        if (route[1] === "count") {
          const id = decodeURIComponent(route[3]!);
          // One command id per ping: a retried request waits for the same receipt.
          const receipt = yield* pingers.send(id, new Ping({ group, slow: false }), {
            commandId: `count-${group}-${id}-${url.searchParams.get("n") ?? "1"}`,
          });
          yield* progress.caughtUp(receipt, { timeout: "60 seconds" }).pipe(Effect.orDie);
          const { entries } = yield* counts.list(group);
          return yield* HttpServerResponse.json(
            entries.map((entry) => [entry.event.ping, entry.event.count]),
          );
        }
        if (route[1] === "ping") {
          yield* pingers.send(
            decodeURIComponent(route[3]!),
            new Ping({ group, slow: url.searchParams.get("slow") === "true" }),
          );
          return HttpServerResponse.text("ok");
        }
        const { entries } = yield* pongs.list(group);
        return yield* HttpServerResponse.json(entries.map((entry) => entry.event.ping));
      }),
    };
  }).pipe(Effect.provide(BatchesLive)),
) {}
