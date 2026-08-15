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
import { Input } from "./ui/input.tsx";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function QueueCard() {
  const [text, setText] = useState("");
  const [processed, setProcessed] = useState<{
    count: number;
    last: string | null;
  } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api((site) => site.processed())
      .then(setProcessed)
      .catch(() => setProcessed(null));
  }, []);

  const enqueue = async () => {
    // `POST /api/queue` sends to SQS and returns immediately — the
    // consumer on the same backend Lambda catches up out of band, so poll
    // (bounded) until the processed count moves.
    const before = processed?.count ?? 0;
    setSending(true);
    try {
      await api((site) =>
        site.enqueue({ payload: { message: text || "hello queue" } }),
      );
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const next = await api((site) => site.processed());
        setProcessed(next);
        if (next.count > before) break;
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Queue</CardTitle>
        <CardDescription>
          <code>POST /api/queue</code> enqueues to SQS; the consumer runs on
          the same backend and the client polls{" "}
          <code>/api/queue/processed</code> until it catches up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Input
            placeholder="hello queue"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={sending}
          />
          <Button onClick={enqueue} disabled={sending}>
            {sending ? "Sending…" : "Send to queue"}
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Queue-processed:{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {processed?.count ?? "—"}
          </span>{" "}
          — last:{" "}
          <span className="font-semibold text-foreground">
            {processed?.last ?? "—"}
          </span>
        </p>
      </CardFooter>
    </Card>
  );
}
