import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "aws",
  auth: () => import("./AuthProvider.ts").then((module) => module.AwsAuth),
  stateStores: {
    aws: {
      description: "S3 state store in the profile's AWS account",
      layer: () => import("./StateStore/State.ts").then((module) => module.state()),
    },
  },
  cli: {
    provider: () => import("./Cli.ts").then((module) => module.awsCommand),
  },
  testServices: () => import("./Local/TestServices.ts").then((module) => module.testServices()),
});
