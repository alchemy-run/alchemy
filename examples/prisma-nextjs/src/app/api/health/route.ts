import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  // Keep health checks secret-safe: expose presence/IDs, never raw connection
  // strings. This route is useful for smoke tests after deploy.
  return NextResponse.json({
    ok: true,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasDirectUrl: Boolean(process.env.DIRECT_URL),
    projectId: process.env.PRISMA_PROJECT_ID ?? null,
    databaseId: process.env.PRISMA_DATABASE_ID ?? null,
    connectionId: process.env.PRISMA_CONNECTION_ID ?? null,
    featureFlag: process.env.NEXT_EXAMPLE_FEATURE_FLAG ?? null,
    sharedFlag: process.env.NEXT_EXAMPLE_SHARED_FLAG ?? null,
  });
}
