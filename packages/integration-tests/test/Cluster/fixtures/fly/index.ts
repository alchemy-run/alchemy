/** Every implementation this host's suite deploys. */
import * as Layer from "effect/Layer";
import ApproveLive from "./approve-live.ts";
import CheckoutLive from "./checkout-live.ts";
import CounterLive from "./counter-live.ts";
import GreetLive from "./greet-live.ts";
import GreeterLive from "./greeter-live.ts";
import HeartbeatLive from "./heartbeat-live.ts";
import JournalLive from "./journal-live.ts";
import NapLive from "./nap-live.ts";
import ParentLive from "./parent-live.ts";
import TickLive from "./tick-live.ts";

export const Lives = Layer.mergeAll(
  CounterLive,
  GreeterLive,
  JournalLive,
  GreetLive,
  NapLive,
  ApproveLive,
  CheckoutLive,
  ParentLive,
  HeartbeatLive,
  TickLive,
);
