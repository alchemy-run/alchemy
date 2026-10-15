import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "doppler",
  auth: () => import("./AuthProvider.ts").then((module) => module.DopplerAuth),
});
