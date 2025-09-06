import * as Context from "effect/Context";
import type { Bindings } from "../cloudflare/bindings.ts";

export class Env extends Context.Tag("Env")<Env, Bindings.Runtime>() {}
