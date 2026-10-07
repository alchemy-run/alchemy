import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

// Shared by the backend (src/api.ts) and the frontend client (src/lib/api.ts).
export const Greeting = Schema.Struct({
  message: Schema.String,
  platform: Schema.String,
  /** When the API served this response. Changes on every call. */
  servedAt: Schema.String,
});
export type Greeting = typeof Greeting.Type;

export class GreetingGroup extends HttpApiGroup.make("Greeting").add(
  HttpApiEndpoint.get("greeting", "/api/greeting", { success: Greeting }),
) {}

export class GreetingApi extends HttpApi.make("GreetingApi").add(GreetingGroup) {}
