import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const applicationId =
  process.env.GCP_GAMESCONFIGURATION_APPLICATION_ID?.trim() ||
  process.env.GCP_GAMES_APPLICATION_ID?.trim() ||
  process.env.GCP_PLAY_GAMES_APPLICATION_ID?.trim();

export const probeApplicationId = applicationId ?? "1";
