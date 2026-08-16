// SSR on every request: proves the server renders, not a cached page.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>Next.js in a monorepo</h1>
      <p data-testid="marker">monorepo-nextjs-page</p>
    </main>
  );
}
