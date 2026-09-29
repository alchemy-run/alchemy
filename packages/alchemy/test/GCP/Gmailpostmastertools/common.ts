import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_GMAILPOSTMASTERTOOLS;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
