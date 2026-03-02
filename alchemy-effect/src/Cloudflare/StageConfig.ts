import * as ServiceMap from "effect/ServiceMap";

export class StageConfig extends ServiceMap.Service<
  StageConfig,
  {
    account?: string;
  }
>()("StageConfig") {}
