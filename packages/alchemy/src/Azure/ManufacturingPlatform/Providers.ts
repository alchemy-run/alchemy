import * as Layer from "effect/Layer";
import { DataService, DataServiceProvider } from "./DataService.ts";

export const resources = [DataService];
export const layers = () => Layer.mergeAll(DataServiceProvider());
