import { createApiClient, type Api } from "@neondatabase/api-client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class NeonApi extends Context.Tag("Neon.Api")<NeonApi, Api<unknown>>() {
  static Default = () =>
    Layer.effect(
      NeonApi,
      Effect.sync(() => {
        const apiKey = process.env.NEON_API_KEY;
        if (!apiKey) {
          throw new Error(
            "NEON_API_KEY environment variable is required for Neon API",
          );
        }
        return createApiClient({ apiKey });
      }),
    );
}
