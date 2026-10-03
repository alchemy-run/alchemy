import * as Layer from "effect/Layer";
import { Pool, PoolProvider } from "./Pool.ts";

export const resources = [Pool];
export const layers = () => Layer.mergeAll(PoolProvider());
