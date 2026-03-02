import * as ServiceMap from "effect/ServiceMap";
import type { Function } from "./Function.ts";

export class FunctionRuntime extends ServiceMap.Service<
  FunctionRuntime,
  Function
>()("AWS.Lambda.Runtime") {}
