import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "prisma",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.PrismaAuth,
  ),
  cli: {
    provider: {
      description: "Prisma contract tooling",
      load: Contributions.lazy(
        () => import("./Cli.ts"),
        (module) => module.prismaCommand,
      ),
    },
  },
});
