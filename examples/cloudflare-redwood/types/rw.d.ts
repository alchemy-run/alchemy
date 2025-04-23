import { AppContext } from "../src/worker";

declare module "@redwoodjs/sdk/worker" {
  export interface DefaultAppContext extends AppContext {}
}
