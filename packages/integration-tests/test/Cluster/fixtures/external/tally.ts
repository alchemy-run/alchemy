/** An existing Effect Cluster codebase's entity, written without Alchemy. */
import { Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export const Tally = Entity.make("Tally", [
  Rpc.make("Add", { payload: { amount: Schema.Int }, success: Schema.Int }),
]);
