import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { StageConfig } from "./stage.ts";

export interface AppProps {
  name: string;
  stage: string;
  config: StageConfig;
}

export class App extends Context.Tag("App")<App, AppProps>() {}

export const app = (input: AppProps) => Layer.succeed(App, App.of(input));

export const make = app;
