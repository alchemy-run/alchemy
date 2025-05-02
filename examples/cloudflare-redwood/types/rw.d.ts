import { AppContext } from "../src/worker.js";

declare module "@redwoodjs/sdk/worker" {
  export interface DefaultAppContext extends AppContext {}
}
