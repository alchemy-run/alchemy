import * as Celld from "@/Celld";

/** The fleet: infrastructure only — nodes + bucket via the registered host. */
export class Cells extends Celld.Fleet<Cells>()("Cells", {
  instances: 1,
}) {}
