import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import { Action } from "../../Action.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { findZoneByName, isZoneId } from "./lookup.ts";
import { toZoneAttributes } from "./Zone.ts";

/**
 * Look up an existing Cloudflare Zone by id (`32-hex`) or domain name
 * (`example.com`). Returns an `Output` with the same shape as a managed
 * {@link Zone} so downstream resources can consume it interchangeably.
 *
 * The underlying lookup is deduplicated per `lookup` string — calling
 * `importZone("example.com")` twice in the same stack runs the API call
 * exactly once.
 */
export const importZone = (lookup: string) =>
  ImportZoneAction(lookup, { lookup });

const ImportZoneAction = Action(
  "Cloudflare.ZoneRef",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const get = yield* zones.getZone;
    return Effect.fn(function* (input: { lookup: string }) {
      const lookup = input.lookup;
      if (isZoneId(lookup)) {
        const result = yield* get({ zoneId: lookup });
        return toZoneAttributes(result, accountId);
      }
      const match = yield* findZoneByName({ accountId, name: lookup });
      if (!match) {
        return yield* Effect.fail(
          new Error(`Cloudflare zone not found for ${lookup}`),
        );
      }
      const result = yield* get({ zoneId: match.id });
      return toZoneAttributes(result, accountId);
    });
  }),
);
