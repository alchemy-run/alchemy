import * as Boat from "@alchemy.run/boat";

/** The declared sandbox the Worker reaches through `ConnectSandbox`. */
export const BindingBox = Boat.Sandbox("BindingBox", {
  type: "small",
  noEnv: true,
  ttlSeconds: 1800,
});
