import type { HttpEffect } from "alchemy-effect/Http";
import { type Auth } from "better-auth";
import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

export class BetterAuth extends ServiceMap.Service<
  BetterAuth,
  {
    auth: Effect.Effect<Auth<any>>;
    fetch: HttpEffect;
  }
>()("BetterAuth") {}
