import * as Context from "effect/Context";

export class App extends Context.Tag("App")<
  App,
  {
    appName: string;
    stage: string;
  }
>() {}
