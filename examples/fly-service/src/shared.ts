import * as Fly from "alchemy/Fly";
import * as Redacted from "effect/Redacted";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-fly-worker";
export const API_PORT = 3000;
export const SECRET_NAME = "FLY_EXAMPLE_MARKER";

/**
 * Parent App both Services share. Each Service is its own Machine
 * (not systemd-on-a-box). Name is generated; `enableSubdomains` is
 * create-only.
 */
export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

/**
 * Volume {@link Worker} mounts at {@link VOLUME_PATH}. Fly attaches a
 * Volume to one Machine — the same volume on two Services is invalid.
 */
export const Data = Fly.Volume("Data", {
  app: Site,
  region: "iad",
  sizeGb: 1,
});

/**
 * App secret {@link Api} reads via {@link Fly.ReadSecret}. Fly also
 * injects it into Machines as an env var named {@link SECRET_NAME}.
 */
export const Marker = Fly.Secret("Marker", {
  app: Site,
  name: SECRET_NAME,
  value: Redacted.make(MARKER),
});

/**
 * Shared IPv4 so `{app}.fly.dev` answers. Dedicated IPv4 is billed.
 */
export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});
