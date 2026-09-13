/** The app's own Effect HTTP endpoints. */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Unauthorized, User } from "./auth.ts";
import { Authenticated } from "./middleware.ts";

/** Who am I. Signed-in only. */
export const Me = HttpApiEndpoint.get("me", "/api/v1/me", {
  success: User,
  error: Unauthorized,
}).middleware(Authenticated);

export class AppRoutes extends HttpApiGroup.make("app").add(Me) {}
