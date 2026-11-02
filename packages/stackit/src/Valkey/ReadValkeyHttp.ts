import { makeRead } from "@alchemy.run/redis/Client";
import * as Layer from "effect/Layer";
import { ReadValkey } from "./ReadValkey.ts";
import { makeValkeyBinding } from "./RedisBinding.ts";

/**
 * RESP implementation of {@link ReadValkey}.
 *
 * @layer
 * @provides Stackit.Valkey.ReadValkey
 */
export const ReadValkeyHttp = Layer.effect(ReadValkey, makeValkeyBinding({ makeClient: makeRead }));
