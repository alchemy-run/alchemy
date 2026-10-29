import * as Celld from "@alchemy.run/celld";

/** One node behind public ingress, so the suite drives the Worker over HTTP. */
export class WorkflowCells extends Celld.Fleet<WorkflowCells>()("WorkflowCells", {
  instances: 1,
  retainStorage: false,
  ingress: true,
}) {}
