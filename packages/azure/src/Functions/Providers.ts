import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Layer from "effect/Layer";
import { Function, FunctionProvider } from "./Function.ts";
import { LocalFunctionProvider } from "./LocalFunctionProvider.ts";

export const resources = [Function];
export const layers = () =>
  Layer.mergeAll(
    ProviderLayer.dual(Function, { live: FunctionProvider, local: LocalFunctionProvider }),
  );
