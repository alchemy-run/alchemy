import * as Layer from "effect/Layer";
import { SharedQuery, SharedQueryProvider } from "./SharedQuery.ts";

export const resources = [SharedQuery];
export const layers = () => Layer.mergeAll(SharedQueryProvider());
