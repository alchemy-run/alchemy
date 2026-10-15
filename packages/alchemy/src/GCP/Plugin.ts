import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "gcp",
  auth: () => import("./AuthProvider.ts").then((module) => module.GcpAuth),
});
