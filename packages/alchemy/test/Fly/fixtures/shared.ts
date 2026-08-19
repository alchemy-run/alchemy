import * as Fly from "@/Fly";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-fly-service";
export const API_PORT = 3000;

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

/**
 * Volume under {@link Site}. Callers must yield the App first so `app`
 * is resolved attributes — Fly.Volume is not a Platform and does not
 * transform Effect-valued refs.
 */
export const Data = (app: Fly.App) =>
  Fly.Volume("Data", {
    app,
    region: "iad",
    sizeGb: 1,
  });
