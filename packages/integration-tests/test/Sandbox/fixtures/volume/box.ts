import * as Sandbox from "@alchemy.run/sandbox";

/** The machine commands run on; it holds no volume of its own. */
export class VolumeSandbox extends Sandbox.Sandbox<VolumeSandbox, { size: "small" }>()(
  "VolumeSandbox",
) {}
