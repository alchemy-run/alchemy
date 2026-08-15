"use client";

import { useState, useTransition } from "react";
import { enqueueJob, getProcessed } from "./actions";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Input } from "./components/ui/input";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The async leg's browser side: `enqueueJob` sends to the queue through
// its server action and returns immediately — the sibling consumer
// Lambda catches up out of band. After a send, poll `getProcessed`
// (bounded, once per second) until the count moves so the catch-up —
// queue → consumer → DynamoDB → UI — is visible.
export default function QueueCard({
  initial,
}: {
  initial: { count: number; last: string | null };
}) {
  const [processed, setProcessed] = useState(initial);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();

  const send = () =>
    startTransition(async () => {
      const before = (await getProcessed()).count;
      await enqueueJob(text || "hello queue");
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const next = await getProcessed();
        setProcessed(next);
        if (next.count > before) break;
      }
    });

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Queue</CardTitle>
        <CardDescription data-testid="processed">
          Queue-processed:{" "}
          <span data-testid="processed-count">{processed.count}</span> — last:{" "}
          <span data-testid="processed-last">{processed.last ?? "—"}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Input
          placeholder="hello queue"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button variant="secondary" disabled={pending} onClick={send}>
          {pending ? "Waiting…" : "Send to queue"}
        </Button>
      </CardContent>
    </Card>
  );
}
