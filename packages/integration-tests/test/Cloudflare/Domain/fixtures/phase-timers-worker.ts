import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Alarm, Alarms, ArmAlarm, DisarmAlarm, Pulse, StartPulse } from "./phase-timers.ts";

const AlarmsLive = Alarms.layer(Layer.empty).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * `POST /arm/<id>`, `POST /disarm/<id>` and `GET /state/<id>` answer an alarm's
 * state; `POST /pulse/<id>` and `GET /beats/<id>` answer a pulse's.
 */
const ROUTE = /^\/(arm|disarm|state|pulse|beats)\/([^/]+)$/;

export default class DomainPhaseTimersWorker extends Cloudflare.Worker<DomainPhaseTimersWorker>()(
  "DomainPhaseTimersWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const alarms = yield* Alarm;
    const pulses = yield* Pulse;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = ROUTE.exec(new URL(request.url, "http://localhost").pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const id = decodeURIComponent(route[2]!);
        if (route[1] === "pulse") yield* pulses.send(id, new StartPulse());
        if (route[1] === "pulse" || route[1] === "beats")
          return yield* HttpServerResponse.json(yield* pulses.state(id));
        if (route[1] === "arm") yield* alarms.send(id, new ArmAlarm());
        if (route[1] === "disarm") yield* alarms.send(id, new DisarmAlarm());
        return yield* HttpServerResponse.json(yield* alarms.state(id));
      }),
    };
  }).pipe(Effect.provide(AlarmsLive)),
) {}
