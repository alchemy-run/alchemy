import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "prisma",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.PrismaAuth,
  ),
  cli: {
    provider: {
      name: "prisma",
      description: "Prisma contract tooling",
      load: Plugin.lazy(
        () => import("./Cli.ts"),
        (module) => module.prismaCommand,
      ),
    },
  },
});
