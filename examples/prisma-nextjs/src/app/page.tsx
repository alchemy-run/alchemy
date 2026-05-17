export const dynamic = "force-dynamic";

const mask = (value: string | undefined) => {
  if (!value) return "missing";
  if (value.length <= 14) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 10)}...${value.slice(-4)}`;
};

export default function Home() {
  // These values are injected by Prisma.ComputeApp.env at deploy time and by
  // ComputeApp.dev.env during `alchemy dev`. Server components can read them at
  // request time, so they do not need to be NEXT_PUBLIC_* build-time variables.
  const runtime = {
    projectId: process.env.PRISMA_PROJECT_ID,
    branchId: process.env.PRISMA_BRANCH_ID,
    databaseId: process.env.PRISMA_DATABASE_ID,
    connectionId: process.env.PRISMA_CONNECTION_ID,
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    featureFlag: process.env.NEXT_EXAMPLE_FEATURE_FLAG,
    sharedFlag: process.env.NEXT_EXAMPLE_SHARED_FLAG,
  };

  const rows = [
    ["Project", runtime.projectId ?? "missing"],
    ["Branch", runtime.branchId ?? "missing"],
    ["Database", runtime.databaseId ?? "missing"],
    ["Connection", runtime.connectionId ?? "missing"],
    ["DATABASE_URL", mask(runtime.databaseUrl)],
    ["DIRECT_URL", mask(runtime.directUrl)],
    ["App flag", runtime.featureFlag ?? "missing"],
    ["Shared flag", runtime.sharedFlag ?? "missing"],
  ] as const;

  return (
    <main className="shell">
      <section className="intro">
        <p className="eyebrow">Alchemy + Prisma</p>
        <h1>Next.js running on Prisma Compute</h1>
        <p>
          This example provisions a Prisma project, branch, Postgres database,
          connection, environment variable, and Compute service from one Alchemy
          stack.
        </p>
      </section>

      <section className="panel" aria-label="Runtime bindings">
        <div className="panelHeader">
          <h2>Runtime bindings</h2>
          <a href="/api/health">Health JSON</a>
        </div>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label} className="row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
