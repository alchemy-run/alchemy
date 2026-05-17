import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const appName = process.env.PRISMA_NEXTJS_APP ?? "alchemy-prisma-nextjs";
const projectName = process.env.PRISMA_PROJECT ?? `${appName}-project`;
const devPort = Number(process.env.PRISMA_NEXTJS_DEV_PORT ?? "3000");

export default Alchemy.Stack(
  "PrismaNextjs",
  {
    providers: Prisma.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // Project is the top-level Prisma container. `createDatabase: false` keeps
    // this example explicit: the Postgres database below is owned as its own
    // Alchemy resource instead of being hidden inside project creation.
    const project = yield* Prisma.Project("Project", {
      name: projectName,
      createDatabase: false,
      region: "us-east-1",
    });

    // A branch is optional for many simple apps, but including it here shows
    // how preview/prod naming lines up with Compute services and databases.
    const branch = yield* Prisma.Branch("MainBranch", {
      project,
      gitName: "main",
      isDefault: true,
    });

    // `Postgres` is the product-shaped alias for `Database`.
    // It uses the same lifecycle provider as `Prisma.Database`.
    const postgres = yield* Prisma.Postgres("Postgres", {
      project,
      name: "main",
      region: "us-east-1",
      branchId: branch.branchId,
      isDefault: true,
      // In `alchemy dev`, Alchemy starts a local Prisma Postgres via
      // `@prisma/dev` and exposes matching connection-string attributes.
      dev: {
        provider: "@prisma/dev",
      },
    });

    // Connections return redacted connection strings. Passing those redacted
    // values into ComputeApp.env keeps secrets out of Alchemy state and logs.
    const connection = yield* Prisma.Connection("Connection", {
      database: postgres,
      name: "web",
    });

    // Standalone environment variables are useful for flags/config that are not
    // tied to a single app deployment. Database credentials are passed through
    // ComputeApp.env below so they can follow this service's deployment.
    const sharedFlag = yield* Prisma.EnvironmentVariable("SharedFlag", {
      project,
      class: "production",
      key: "NEXT_EXAMPLE_SHARED_FLAG",
      value: Redacted.make("project-level"),
    });

    const app = yield* Prisma.ComputeApp("NextApp", {
      project,
      serviceName: appName,
      regionId: "us-east-1",
      branchId: branch.branchId,
      path: ".",
      // `build: "auto"` detects Next.js, runs `next build`, uploads the
      // standalone server, and defaults the exposed HTTP port to 3000.
      build: "auto",
      // The Next standalone server respects PORT. Setting the same value here
      // makes the Compute service and local Next dev server line up.
      port: 3000,
      env: {
        DATABASE_URL:
          connection.pooledConnectionString ?? connection.connectionString,
        DIRECT_URL:
          connection.directConnectionString ?? connection.connectionString,
        PRISMA_PROJECT_ID: project.projectId,
        PRISMA_BRANCH_ID: branch.branchId,
        PRISMA_DATABASE_ID: postgres.databaseId,
        PRISMA_CONNECTION_ID: connection.connectionId,
        NEXT_EXAMPLE_FEATURE_FLAG: "enabled",
      },
      dev: {
        // `alchemy dev` runs this command and keeps the same env contract as
        // deploy. Database URLs come from the local `Prisma.Postgres` above.
        command: "bun run dev:next",
        port: devPort,
        env: {
          NEXT_EXAMPLE_FEATURE_FLAG: "local-dev",
          NEXT_EXAMPLE_SHARED_FLAG: "local-project-level",
        },
      },
      // After a successful promote, remove the previously promoted version.
      // This keeps the service tidy across repeated deploys.
      destroyOldVersion: true,
    });

    return {
      projectId: project.projectId,
      branchId: branch.branchId,
      databaseId: postgres.databaseId,
      connectionId: connection.connectionId,
      sharedFlagId: sharedFlag.environmentVariableId,
      computeServiceId: app.computeServiceId,
      computeVersionId: app.computeVersionId,
      url: app.url,
    };
  }),
);
