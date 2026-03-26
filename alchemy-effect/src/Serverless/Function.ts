import type { Scope } from "effect/Scope";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { ExecutionContext } from "../ExecutionContext.ts";

import { Platform } from "../Platform.ts";
import * as Serverless from "./ExecutionContext.ts";

// services provided at runtime
type RuntimeServices =
  | ExecutionContext
  | Serverless.Context
  | HttpClient
  | Scope;

export interface Function extends Platform<Serverless.ExecutionContext> {}

export const Function = Platform<Function>();
