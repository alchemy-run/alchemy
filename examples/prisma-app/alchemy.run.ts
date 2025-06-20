import alchemy from "alchemy";
import { PrismaProject } from "alchemy/prisma";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";
const app = await alchemy("prisma-app", {
  stage: BRANCH_PREFIX || undefined,
});

export const project = await PrismaProject(`prisma-project${BRANCH_PREFIX}`, {
  name: `My Prisma Project${BRANCH_PREFIX ? ` ${BRANCH_PREFIX}` : ""}`,
  description: "A Prisma project created with Alchemy",
  region: "us-east-1",
  private: false,
});

console.log("Prisma Project created:");
console.log("ID:", project.id);
console.log("Name:", project.name);
console.log("Description:", project.description);
console.log("Created At:", project.createdAt);
console.log("Environments:", project.environments.length);

await app.finalize();
