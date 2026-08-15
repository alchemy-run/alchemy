import { useEffect, useState } from "react";
import { api } from "../lib/client.ts";
import { Button } from "./ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";

export default function VisitsCard() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    api((site) => site.visits())
      .then((visits) => setCount(visits.count))
      .catch(() => setCount(null));
  }, []);

  const bump = async () => {
    // Optimistic: bump the display immediately, then reconcile with the
    // count the server persisted (or re-read on failure).
    setCount((current) => (current ?? 0) + 1);
    try {
      const next = await api((site) => site.bump());
      setCount(next.count);
    } catch {
      const current = await api((site) => site.visits()).catch(() => null);
      setCount(current?.count ?? null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Visits</CardTitle>
        <CardDescription>
          A DynamoDB counter behind <code>GET /api/visits</code> and{" "}
          <code>POST /api/visits/bump</code> — schema-typed end to end.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-4xl font-bold tabular-nums">
          {count ?? "—"}
        </p>
      </CardContent>
      <CardFooter>
        <Button onClick={bump}>Bump visits</Button>
      </CardFooter>
    </Card>
  );
}
