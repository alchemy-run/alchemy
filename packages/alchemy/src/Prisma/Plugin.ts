import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "prisma",
  auth: () => import("./AuthProvider.ts").then((module) => module.PrismaAuth),
  cli: {
    commands: [
      {
        name: "prisma",
        description: "Generate Prisma Effect bindings and schemas",
        load: () => import("./Cli.ts").then((module) => module.prismaCommand),
      },
    ],
  },
});
