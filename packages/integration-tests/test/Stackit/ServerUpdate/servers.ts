import * as Stackit from "@alchemy.run/stackit";
import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Effect from "effect/Effect";
import { MACHINE_TYPE } from "../IaaS/compute.ts";

/** The server every suite here patches, with the agent STACKIT's image may need. */
export const updatedServer = (prefix: string, imageId: string, cidr: string) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network(`${prefix}Network`, { ipv4: { prefix: cidr } });
    return yield* Stackit.IaaS.Server(`${prefix}Server`, {
      machineType: MACHINE_TYPE,
      bootVolume: { size: 10, source: { type: "image", id: imageId }, deleteOnTermination: true },
      networking: { networkId: network.networkId },
      agent: { provisioned: true },
    });
  });

export const DAILY = "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1";
export const WEEKLY = "DTSTART;TZID=Europe/Berlin:20260101T030000 RRULE:FREQ=WEEKLY;INTERVAL=1";

export interface Target {
  readonly projectId: string;
  readonly region: string;
  readonly serverId: string;
}

/** Out of band: the service's switch, with a missing server or service as off. */
export const serviceEnabled = (target: Target) =>
  serverUpdate.getServiceResource(target).pipe(
    Effect.map(({ enabled }) => enabled === true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );
