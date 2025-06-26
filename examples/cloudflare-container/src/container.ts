import { Container } from "@cloudflare/containers";
import type { worker } from "../alchemy.run.ts";

export class MyContainer extends Container {
  declare env: typeof worker.Env;

  defaultPort = 8080; // The default port for the container to listen on
  sleepAfter = "3m"; // Sleep the container if no requests are made in this timeframe

  envVars = {
    MESSAGE: "I was passed in via the container class!",
  };

  override onStart() {
    console.log("Container successfully started");
  }

  override onStop() {
    console.log("Container successfully shut down");
  }

  override onError(error: unknown) {
    console.log("Container error:", error);
  }
}
