import * as ServiceMap from "effect/ServiceMap";
import { GenericService } from "./Util/service.ts";

export interface Self<
  R extends { Type: string } = { Type: string },
> extends ServiceMap.ServiceClass<Self<R>, `Self<${R["Type"]}>`, R> {}

export const Self = GenericService<{
  <R extends { Type: string }>(type: R["Type"]): Self<R>;
}>()("Alchemy::Self");
