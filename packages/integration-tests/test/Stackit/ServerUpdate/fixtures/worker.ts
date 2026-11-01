import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The newest public Ubuntu image of the region, resolved at plan. */
const ubuntuImage = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    return items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
  }).pipe(Effect.orDie),
);

export const Network = Stackit.IaaS.Network("UpdateBindingsNetwork", {
  ipv4: { prefix: "10.231.56.0/24" },
});

export const Host = Network.pipe(
  Effect.flatMap((network) =>
    Stackit.IaaS.Server("UpdateBindingsServer", {
      machineType: "g1.1",
      bootVolume: {
        size: 10,
        source: { type: "image", id: ubuntuImage },
        deleteOnTermination: true,
      },
      networking: { networkId: network.networkId },
      agent: { provisioned: true },
    }),
  ),
);

export const Updates = Host.pipe(
  Effect.flatMap((server) =>
    Stackit.ServerUpdate.Enablement("UpdateBindingsEnable", {
      serverId: server.serverId,
    }),
  ),
);

export const Weekly = Updates.pipe(
  Effect.flatMap((enablement) =>
    Stackit.ServerUpdate.Schedule("UpdateBindingsSchedule", {
      serverId: enablement.serverId,
      rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=WEEKLY;INTERVAL=1",
      enabled: false,
      maintenanceWindow: 1,
    }),
  ),
);

/**
 * A Cloudflare Worker with every Server Update binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class ServerUpdateBindingsWorker extends Cloudflare.Worker<ServerUpdateBindingsWorker>()(
  "StackitServerUpdateBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const server = yield* Host;
    const schedule = yield* Weekly;
    const network = yield* Network;
    const getService = yield* Stackit.ServerUpdate.GetService(server);
    const listSchedules = yield* Stackit.ServerUpdate.ListSchedules(server);
    const createUpdate = yield* Stackit.ServerUpdate.CreateUpdate(server);
    const getUpdate = yield* Stackit.ServerUpdate.GetUpdate(server);
    const listUpdates = yield* Stackit.ServerUpdate.ListUpdates(server);
    const getSchedule = yield* Stackit.ServerUpdate.GetSchedule(schedule);
    const updateSchedule = yield* Stackit.ServerUpdate.UpdateSchedule(schedule);
    const listPolicies = yield* Stackit.ServerUpdate.ListPolicies(network);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-service":
            return yield* respond(getService());
          case "/list-schedules":
            return yield* respond(listSchedules());
          case "/create-update":
            return yield* respond(createUpdate({ maintenanceWindow: 1 }));
          case "/get-update":
            return yield* respond(getUpdate({ updateId: param("id") }));
          case "/list-updates":
            return yield* respond(listUpdates());
          case "/get-schedule":
            return yield* respond(getSchedule());
          case "/update-schedule":
            return yield* respond(
              updateSchedule({
                name: param("name"),
                rrule: "DTSTART;TZID=Europe/Berlin:20260101T030000 RRULE:FREQ=DAILY;INTERVAL=1",
                enabled: false,
                maintenanceWindow: 2,
              }),
            );
          case "/list-policies":
            return yield* respond(listPolicies());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ServerUpdate.GetServiceHttp,
        Stackit.ServerUpdate.ListSchedulesHttp,
        Stackit.ServerUpdate.CreateUpdateHttp,
        Stackit.ServerUpdate.GetUpdateHttp,
        Stackit.ServerUpdate.ListUpdatesHttp,
        Stackit.ServerUpdate.GetScheduleHttp,
        Stackit.ServerUpdate.UpdateScheduleHttp,
        Stackit.ServerUpdate.ListPoliciesHttp,
      ),
    ),
  ),
) {}
