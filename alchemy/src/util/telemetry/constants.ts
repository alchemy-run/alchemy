import xdgAppPaths from "xdg-app-paths";

const xdg = xdgAppPaths("alchemy");

export const CONFIG_DIR = xdg.config();
export const STATE_DIR = xdg.state();

export const TELEMETRY_DISABLED =
  !!process.env.ALCHEMY_TELEMETRY_DISABLED || !!process.env.DO_NOT_TRACK;

// TODO(sam): replace with permanent URL
export const INGEST_URL =
  process.env.ALCHEMY_TELEMETRY_URL ??
  "https://bc6398b3703c4615972fda998c8d09f1.pipelines.cloudflare.com";
