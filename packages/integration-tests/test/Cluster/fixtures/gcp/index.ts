/** Every implementation this host's suite deploys. */
import * as Layer from "effect/Layer";
import ApproveLive from "./approve-live.ts";
import CheckoutLive from "./checkout-live.ts";
import CounterLive from "./counter-live.ts";
import GreetLive from "./greet-live.ts";
import GreeterLive from "./greeter-live.ts";
import Heartbeat from "./heartbeat.ts";
import JournalLive from "./journal-live.ts";
import LedgerLive from "./ledger-live.ts";
import NapLive from "./nap-live.ts";
import ParentLive from "./parent-live.ts";
import Tick from "./tick.ts";
import TurnstileLive from "./turnstile-live.ts";

export const Lives = Layer.mergeAll(
  CounterLive,
  GreeterLive,
  LedgerLive,
  TurnstileLive,
  JournalLive,
  GreetLive,
  NapLive,
  ApproveLive,
  CheckoutLive,
  ParentLive,
  // Declared inline, so the classes themselves deploy them.
  Layer.effectDiscard(Heartbeat),
  Layer.effectDiscard(Tick),
);
