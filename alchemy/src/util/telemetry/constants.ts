import { createXdgAppPaths } from "../xdg-paths.js";

const xdg = createXdgAppPaths("alchemy");

export const CONFIG_DIR = xdg.config();
export const STATE_DIR = xdg.state();

export const TELEMETRY_DISABLED =
  !!process.env.ALCHEMY_TELEMETRY_DISABLED || !!process.env.DO_NOT_TRACK;

// TODO(sam): replace with permanent URL
export const INGEST_URL =
  process.env.ALCHEMY_TELEMETRY_URL ??
  "https://5fbb5d5ca66f44b685468684cfceb325.pipelines.cloudflare.com";
