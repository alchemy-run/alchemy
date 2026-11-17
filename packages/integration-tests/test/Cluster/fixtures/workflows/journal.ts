/**
 * What the test workflows did, outside the engine: each activity appends an
 * entry here, so a test can check an activity ran once even though its
 * workflow replayed.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Journal extends Cluster.Entity<Journal>()("Journal", [
  Rpc.make("Append", { payload: { entry: Schema.String } }),
  Rpc.make("List", { success: Schema.Array(Schema.String) }),
]) {}
