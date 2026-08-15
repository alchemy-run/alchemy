import { actions } from "astro:actions";
import * as React from "react";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";

interface Processed {
  count: number;
  last: string | null;
}

/**
 * React island for the canonical demo. The initial values are
 * server-rendered from the frontmatter's in-process `createClient`
 * calls; every browser interaction goes through Astro Actions — the
 * framework's own transport — whose handlers call the same backend.
 */
export default function VisitsCard(props: {
  initialVisits: number;
  initialProcessed: Processed;
}) {
  const [visits, setVisits] = React.useState(props.initialVisits);
  const [bumped, setBumped] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const [processed, setProcessed] = React.useState(props.initialProcessed);
  const [sending, setSending] = React.useState(false);

  const bump = async () => {
    // Optimistic: paint the increment immediately, then reconcile with
    // the server's authoritative count (roll back if the action fails).
    setVisits((n) => n + 1);
    try {
      const count = await actions.bump.orThrow();
      setVisits(count);
      setBumped(count);
    } catch {
      setVisits((n) => n - 1);
    }
  };

  const enqueue = async () => {
    const before = processed.count;
    setSending(true);
    try {
      await actions.enqueue.orThrow({ message: message || "hello queue" });
      // Bounded poll until the queue consumer's write becomes visible.
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const next = await actions.processed.orThrow();
        setProcessed(next);
        if (next.count > before) break;
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-6 grid max-w-md gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Visits</CardTitle>
          <CardDescription>
            Server-rendered visits: <span data-testid="count">{visits}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={bump}>Bump visits</Button>
          {bumped !== null && (
            <p className="mt-4 text-sm" data-testid="bumped">
              Client bump → {bumped}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
          <CardDescription>
            Enqueue a message; the consumer catches up asynchronously.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            placeholder="hello queue"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <Button onClick={enqueue} disabled={sending}>
            Send to queue
          </Button>
        </CardContent>
        <CardFooter>
          <p className="text-sm text-slate-500" data-testid="processed">
            Queue-processed:{" "}
            <span data-testid="processed-count">{processed.count}</span> — last:{" "}
            <span data-testid="processed-last">{processed.last ?? "—"}</span>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
