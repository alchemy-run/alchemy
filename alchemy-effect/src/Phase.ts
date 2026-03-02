import * as ServiceMap from "effect/ServiceMap";

export class Phase extends ServiceMap.Service<Phase, "plan" | "runtime">()(
  "Alchemy::Phase",
) {}
