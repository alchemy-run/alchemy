import alchemy from "alchemy";
import { Project, Database, DatabaseConnection } from "alchemy/prisma/postgres";

const app = await alchemy("prisma-postgres-example", {
  password: process.env.ALCHEMY_PASSWORD ?? "dev-password",
});

export const project = await Project("project", {
  name: "prisma-postgres-example",
  region: "us-east-1",
  createDatabase: false,
});

export const database = await Database("database", {
  project,
  name: "primary",
  region: "us-east-1",
});

export const connection = await DatabaseConnection("connection", {
  database,
  name: "application",
});

console.log("Database URL", connection.connectionString.unencrypted);

await app.finalize();
