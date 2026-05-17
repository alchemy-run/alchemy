import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getDashboardData } from "../prisma/queries";

const getRuntime = createServerFn({ method: "GET" }).handler(async () => {
  const dashboard = await getDashboardData(10);
  return {
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasDirectUrl: Boolean(process.env.DIRECT_URL),
    message: process.env.TANSTACK_MESSAGE ?? "missing message",
    sharedFlag: process.env.TANSTACK_SHARED_FLAG ?? "missing shared flag",
    projectId: process.env.PRISMA_PROJECT_ID ?? "missing project",
    branchId: process.env.PRISMA_BRANCH_ID ?? "missing branch",
    databaseId: process.env.PRISMA_DATABASE_ID ?? "missing database",
    connectionId: process.env.PRISMA_CONNECTION_ID ?? "missing connection",
    renderedAt: new Date().toISOString(),
    ...dashboard,
  };
});

export const Route = createFileRoute("/")({
  loader: () => getRuntime(),
  component: Home,
});

function Home() {
  const runtime = Route.useLoaderData();

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "48px 20px",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        background: "#f7f8fb",
        color: "#171923",
      }}
    >
      <section
        style={{
          width: "min(680px, 100%)",
          margin: "0 auto",
          display: "grid",
          gap: 20,
        }}
      >
        <div>
          <p
            style={{
              margin: "0 0 8px",
              color: "#4c6fff",
              fontSize: 13,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            Alchemy + Prisma
          </p>
          <h1 style={{ margin: 0, fontSize: 40, lineHeight: 1.05 }}>
            TanStack Start with Prisma Postgres
          </h1>
        </div>

        <dl
          style={{
            margin: 0,
            display: "grid",
            gap: 10,
            padding: 20,
            border: "1px solid #d9deea",
            borderRadius: 8,
            background: "#ffffff",
          }}
        >
          <RuntimeRow label="Message" value={runtime.message} />
          <RuntimeRow
            label="Database URL"
            value={String(runtime.hasDatabaseUrl)}
          />
          <RuntimeRow label="Direct URL" value={String(runtime.hasDirectUrl)} />
          <RuntimeRow label="Project" value={runtime.projectId} />
          <RuntimeRow label="Branch" value={runtime.branchId} />
          <RuntimeRow label="Database" value={runtime.databaseId} />
          <RuntimeRow label="Connection" value={runtime.connectionId} />
          <RuntimeRow label="Shared Flag" value={runtime.sharedFlag} />
          <RuntimeRow label="Seed Users" value={String(runtime.counts.users)} />
          <RuntimeRow label="Seed Posts" value={String(runtime.counts.posts)} />
          <RuntimeRow label="Rendered" value={runtime.renderedAt} />
          <RuntimeRow label="Health" value="/api/health" />
        </dl>

        <section
          style={{
            display: "grid",
            gap: 12,
          }}
        >
          <h2 style={{ margin: "12px 0 0", fontSize: 18 }}>Latest Posts</h2>
          <div
            style={{
              display: "grid",
              gap: 10,
            }}
          >
            {runtime.posts.map((post) => (
              <article
                key={post.id}
                style={{
                  padding: 16,
                  border: "1px solid #d9deea",
                  borderRadius: 8,
                  background: "#ffffff",
                }}
              >
                <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>
                  {post.title}
                </h3>
                <p style={{ margin: 0, color: "#4a5568", fontSize: 13 }}>
                  {post.excerpt}
                </p>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function RuntimeRow(props: Readonly<{ label: string; value: string }>) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px minmax(0, 1fr)",
        gap: 12,
        alignItems: "baseline",
      }}
    >
      <dt style={{ color: "#667085", fontSize: 13 }}>{props.label}</dt>
      <dd
        style={{
          margin: 0,
          minWidth: 0,
          overflowWrap: "anywhere",
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 13,
        }}
      >
        {props.value}
      </dd>
    </div>
  );
}
