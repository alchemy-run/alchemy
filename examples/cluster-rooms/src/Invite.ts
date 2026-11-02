import * as Cluster from "@alchemy.run/effect-cluster";
import * as Schema from "effect/Schema";
import { DurableDeferred } from "effect/workflow";

export const Answer = DurableDeferred.make("answer", { success: Schema.Boolean });

export class Invite extends Cluster.Workflow<Invite>()("Invite", {
  payload: { room: Schema.String, guest: Schema.String },
  success: Schema.Boolean,
  idempotencyKey: ({ room, guest }) => `${room}/${guest}`,
}) {}
