import { makeWrite } from "@alchemy.run/redis/Client";
import * as Layer from "effect/Layer";
import { makeValkeyBinding } from "./RedisBinding.ts";
import { WriteValkey } from "./WriteValkey.ts";

/**
 * RESP implementation of {@link WriteValkey}.
 *
 * @layer
 * @provides Stackit.Valkey.WriteValkey
 */
export const WriteValkeyHttp = Layer.effect(
  WriteValkey,
  makeValkeyBinding({ makeClient: makeWrite }),
);
