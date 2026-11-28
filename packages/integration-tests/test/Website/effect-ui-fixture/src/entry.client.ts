import { Router } from "@effect/ui";
import { BrowserHost, BrowserRouter, HtmlHydrate } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { App } from "./App.ts";
import { AppRoute } from "./routes.ts";

const container = document.getElementById("app")!;
const state = document.getElementById("state");

// A server-rendered or prerendered page carries its state; a browser-only
// build mounts into the empty shell.
const Main = (
  state === null
    ? BrowserHost.mount(App, Router.props(AppRoute), container)
    : HtmlHydrate.hydrate(App, Router.props(AppRoute), container, JSON.parse(state.textContent!))
).pipe(Layer.provide(BrowserRouter.layer({ routes: AppRoute, base: import.meta.env.BASE_URL })));

Layer.launch(Main).pipe(Effect.runFork);
