/** Every implementation the NixOS suite deploys. */
import * as Layer from "effect/Layer";
import GreeterLive from "./greeter-live.ts";
import Tick from "./tick.ts";

export const Lives = Layer.mergeAll(GreeterLive, Layer.effectDiscard(Tick));
