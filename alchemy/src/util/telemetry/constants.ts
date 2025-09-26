import envPaths from "env-paths";

export const CONFIG_DIR = envPaths("alchemy", { suffix: "" }).config;

export const TELEMETRY_DISABLED =
  !!process.env.ALCHEMY_TELEMETRY_DISABLED || !!process.env.DO_NOT_TRACK;

export const TELEMETRY_API_URL =
  process.env.ALCHEMY_TELEMETRY_API_URL ?? "https://telemetry.alchemy.run";
export const SUPPRESS_TELEMETRY_ERRORS =
  !!process.env.ALCHEMY_TELEMETRY_SUPPRESS_ERRORS;
