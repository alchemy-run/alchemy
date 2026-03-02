import * as ServiceMap from "effect/ServiceMap";

export class Reporter extends ServiceMap.Service<
  Reporter,
  {
    report: (event: Event) => void;
  }
>()("Reporter") {}
