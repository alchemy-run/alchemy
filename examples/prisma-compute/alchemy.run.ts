import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

const serviceName =
  process.env.PRISMA_COMPUTE_SERVICE ?? "alchemy-prisma-compute-example";
const projectName = process.env.PRISMA_PROJECT ?? `${serviceName}-project`;
const greeting = process.env.GREETING ?? "hello from Prisma Compute";

export default Alchemy.Stack(
  "PrismaCompute",
  {
    providers: Prisma.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", {
      name: projectName,
      createDatabase: false,
    });

    const app = yield* Prisma.ComputeApp("App", {
      project: project.projectId,
      serviceName,
      path: ".",
      build: {
        command: "bun build src/server.ts --target bun --outdir dist",
        outdir: "dist",
        entrypoint: "server.js",
      },
      port: 8080,
      env: {
        GREETING: greeting,
      },
      dev: {
        command: "bun run dev:server",
        port: 8787,
        env: {
          GREETING: process.env.GREETING ?? "hello from alchemy dev",
        },
      },
      destroyOldVersion: true,
    });

    return {
      projectId: project.projectId,
      computeServiceId: app.computeServiceId,
      computeVersionId: app.computeVersionId,
      url: app.url,
    };
  }),
);
