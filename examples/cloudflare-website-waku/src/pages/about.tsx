export default function AboutPage() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl font-bold tracking-tight">About</h1>
      <p className="text-muted-foreground">
        This page is prerendered at build time (SSG) and served as a static
        asset.
      </p>
    </div>
  );
}

// Static: rendered at build time by waku's SSG step and served from assets.
export const getConfig = async () => ({ render: "static" }) as const;
