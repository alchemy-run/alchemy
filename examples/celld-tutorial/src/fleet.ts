import * as Celld from "@alchemy.run/celld";

export class Cells extends Celld.Fleet<Cells>()("Cells", {
  instances: 1,
  ingress: true,
  retainStorage: false,
}) {}
