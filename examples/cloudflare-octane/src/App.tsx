import { useEffect, useState } from "octane";

export function App() {
  const [count, setCount] = useState(0);
  const [visits, setVisits] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/visits")
      .then((response) => response.json())
      .then((body: { visits: number | null }) => setVisits(body.visits))
      .catch(() => setVisits(null));
  }, []);
  return (
    <main>
      <h1>Octane on Cloudflare Workers</h1>
      <p>Server-rendered by Octane, deployed by Alchemy.</p>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>
      <p>{visits === null ? "visit count needs a deployed KV binding" : `visits: ${visits}`}</p>
    </main>
  );
}
