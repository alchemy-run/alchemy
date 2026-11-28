import { Route } from "@effect/ui";
import { Effect, Schema } from "effect";

// `?count=` gives a render something request-shaped: a prerendered page
// shows the count it was built with, a server render shows the query's.
const search = {
  count: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
};

export const AppRoute = Route.union({
  Home: Route.make("/", { search }),
  About: Route.make("/about", { search }),
  Counter: Route.make("/counter/:id", { params: { id: Schema.Int }, search }),
  NotFound: Route.make("/*"),
});
export type AppRoute = typeof AppRoute.Type;
