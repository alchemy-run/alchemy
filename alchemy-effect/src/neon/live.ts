import * as Layer from "effect/Layer";
import { NeonApi } from "./api.ts";
import { projectProvider } from "./project.provider.ts";

export const defaultProviders = () => Layer.mergeAll(projectProvider());

export const providers = () =>
  defaultProviders().pipe(Layer.provideMerge(NeonApi.Default()));
