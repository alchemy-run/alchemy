import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const packageName =
  process.env.GCP_ANDROIDPUBLISHER_PACKAGE_NAME?.trim() ||
  process.env.GCP_PLAY_PACKAGE_NAME?.trim();

export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_ANDROIDPUBLISHER && !!packageName;

export const probePackageName = packageName ?? "com.alchemy.missing.app";
