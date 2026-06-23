import * as Layer from "effect/Layer";
import { BuildProvider } from "./Build.ts";
import { DevProvider } from "./Dev.ts";
import { ExecProvider } from "./Exec.ts";

export const providers = () =>
  Layer.mergeAll(BuildProvider(), DevProvider(), ExecProvider());
