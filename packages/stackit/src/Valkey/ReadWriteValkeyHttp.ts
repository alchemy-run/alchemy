import { makeReadWrite } from "@alchemy.run/redis/Client";
import * as Layer from "effect/Layer";
import { ReadWriteValkey } from "./ReadWriteValkey.ts";
import { makeValkeyBinding } from "./RedisBinding.ts";

/**
 * RESP implementation of {@link ReadWriteValkey}.
 *
 * @layer
 * @provides Stackit.Valkey.ReadWriteValkey
 */
export const ReadWriteValkeyHttp = Layer.effect(
  ReadWriteValkey,
  makeValkeyBinding({ makeClient: makeReadWrite }),
);
