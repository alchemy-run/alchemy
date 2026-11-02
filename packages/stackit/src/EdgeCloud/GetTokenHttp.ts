import * as edge from "@distilled.cloud/stackit/edge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EDGE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetToken, type GetTokenRequest } from "./GetToken.ts";
import type { Instance } from "./Instance.ts";
import { tokenValue } from "./internal.ts";

/**
 * HTTP implementation of {@link GetToken}.
 *
 * @layer
 * @provides Stackit.EdgeCloud.GetToken
 */
export const GetTokenHttp = Layer.effect(
  GetToken,
  Effect.gen(function* () {
    const bindInstance = yield* makeInstanceHttpBinding({
      tag: "Stackit.EdgeCloud.GetToken",
      access: EDGE_ACCESS.mintCredential,
      operation: edge.getTokenByInstanceId,
    });
    return Effect.fn(function* (instance: Instance) {
      const getToken = yield* bindInstance(instance);
      return (request?: GetTokenRequest) =>
        getToken(request).pipe(Effect.map((response) => ({ token: tokenValue(response.token) })));
    });
  }),
);
