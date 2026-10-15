import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "infisical",
  auth: () => import("./AuthProvider.ts").then((module) => module.InfisicalAuth),
});
