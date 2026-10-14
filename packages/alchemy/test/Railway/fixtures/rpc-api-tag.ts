import type * as Effect from "effect/Effect";
import { Service } from "@/Railway/Service.ts";

export class Api extends Service<Api>()("Api") {
  ping!: () => Effect.Effect<string>;
}
