import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const applicationId =
  process.env.GCP_GAMESCONFIGURATION_APPLICATION_ID?.trim() ||
  process.env.GCP_GAMES_APPLICATION_ID?.trim() ||
  process.env.GCP_PLAY_GAMES_APPLICATION_ID?.trim();

export const probeApplicationId = applicationId ?? "1";
