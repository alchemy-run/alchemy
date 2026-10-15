import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "prisma",
  auth: () => import("./AuthProvider.ts").then((module) => module.PrismaAuth),
  cli: {
    provider: () => import("./Cli.ts").then((module) => module.prismaCommand),
  },
});
