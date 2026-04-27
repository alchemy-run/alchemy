import * as Layer from "effect/Layer";
import { SecretProvider } from "./Secret.ts";
import { VariableProvider } from "./Variable.ts";

export const providers = () =>
  Layer.mergeAll(SecretProvider(), VariableProvider());
