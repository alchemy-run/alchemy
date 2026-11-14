import * as Daytona from "@alchemy.run/daytona";

/** A long-lived sandbox the Worker connects to with ConnectSandbox. */
export const DevBox = Daytona.Sandbox("BindingsDevBox", {
  labels: { purpose: "bindings-test" },
  autoStopInterval: "15 minutes",
});

/** A volume the Worker mounts into sandboxes it creates, through MountVolume. */
export const BindingsCache = Daytona.Volume("BindingsCache", {});
