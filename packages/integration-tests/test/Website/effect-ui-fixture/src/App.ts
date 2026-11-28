import { Head, Router, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import { AppRoute } from "./routes.ts";

const countOf = (route: AppRoute): number => (route._tag === "NotFound" ? 0 : route.search.count);

export const AppMessage = UiSchema.TaggedEnum({
  ChangedRoute: { route: AppRoute },
  ClickedIncrement: {},
});

export const App = Html.component({
  name: "App",
  props: Schema.Struct({ route: AppRoute }),
  model: Schema.Struct({ route: AppRoute, count: Schema.Number }),
  message: AppMessage,
}).make({
  init: ($) => ({ route: $.props.route, count: countOf($.props.route) }),
  update: {
    ChangedRoute: ($, { route }) => $.evolve({ route, count: countOf(route) }),
    ClickedIncrement: ($) => $.evolve({ count: (count) => count + 1 }),
  },
  subscriptions: ({ model }) => [
    Router.subscription(AppRoute, model.route, (route) => AppMessage.ChangedRoute({ route })),
  ],
  head: ({ model }) => [Head.title(`Effect UI Fixture: ${model.route._tag}`)],
  view: (h, model) =>
    h.main.children(
      h.h1.attr("id", "page").children(model.route._tag),
      h.p.attr("id", "count").children(String(model.count)),
      h.button.attr("id", "increment").on("click", AppMessage.ClickedIncrement()).children("+"),
    ),
});
