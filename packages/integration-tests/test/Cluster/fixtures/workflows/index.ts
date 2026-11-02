/** Every workflow fixture's Layer, and the journal they record to. */
import * as Layer from "effect/Layer";
import ApproveLive from "./approve-live.ts";
import CheckoutLive from "./checkout-live.ts";
import GreetLive from "./greet-live.ts";
import JournalLive from "./journal-live.ts";
import NapLive from "./nap-live.ts";
import ParentLive from "./parent-live.ts";

export const WorkflowsLive = Layer.mergeAll(
  JournalLive,
  GreetLive,
  NapLive,
  ApproveLive,
  CheckoutLive,
  ParentLive,
);
