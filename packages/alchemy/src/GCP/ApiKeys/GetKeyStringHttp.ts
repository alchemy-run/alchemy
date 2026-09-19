import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetKeyString } from "./GetKeyString.ts";
import type { Key } from "./Key.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetKeyString}.
 *
 * @layer
 * @provides GCP.ApiKeys.GetKeyString
 */
export const GetKeyStringHttp = Layer.effect(
  GetKeyString,
  Effect.gen(function* () {
    const getKeyStringProjectsLocationsKeys =
      yield* apikeys.getKeyStringProjectsLocationsKeys;
    return Effect.fn(function* <K extends Key>(key: K) {
      yield* bindGcpHost({
        tag: "GCP.ApiKeys.GetKeyString",
        resource: key,
        iam: [{ role: defaultRoleFor("GCP.ApiKeys.GetKeyString") }],
      });
      const name = yield* key.name;
      return Effect.fn(`GCP.ApiKeys.GetKeyString(${key.LogicalId})`)(
        function* () {
          return yield* getKeyStringProjectsLocationsKeys({
            name: yield* name,
          });
        },
      );
    });
  }),
);
