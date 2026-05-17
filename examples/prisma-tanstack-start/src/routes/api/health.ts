import { createFileRoute } from "@tanstack/react-router";
import { getDashboardData } from "../../prisma/queries";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const dashboard = await getDashboardData(10);
        return Response.json({
          ok: true,
          hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
          hasDirectUrl: Boolean(process.env.DIRECT_URL),
          message: process.env.TANSTACK_MESSAGE ?? null,
          sharedFlag: process.env.TANSTACK_SHARED_FLAG ?? null,
          projectId: process.env.PRISMA_PROJECT_ID ?? null,
          branchId: process.env.PRISMA_BRANCH_ID ?? null,
          databaseId: process.env.PRISMA_DATABASE_ID ?? null,
          connectionId: process.env.PRISMA_CONNECTION_ID ?? null,
          counts: dashboard.counts,
          renderedAt: new Date().toISOString(),
        });
      },
    },
  },
});
