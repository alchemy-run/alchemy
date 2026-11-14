import * as Cluster from "@alchemy.run/effect-cluster";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Auth } from "./Auth.ts";

export class Room extends Cluster.Entity<Room>()("Room", [
  Rpc.make("Join", { success: Schema.Int }).middleware(Auth),
  Rpc.make("Admit", { payload: { name: Schema.String }, success: Schema.Int }),
]) {}
