import * as Layer from "effect/Layer";
import { DeidService, DeidServiceProvider } from "./DeidService.ts";

export const resources = [DeidService];
export const layers = () => Layer.mergeAll(DeidServiceProvider());
