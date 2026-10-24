import * as Layer from "effect/Layer";
import { Function, FunctionProvider } from "./Function.ts";

export const resources = [Function];
export const layers = () => Layer.mergeAll(FunctionProvider());
