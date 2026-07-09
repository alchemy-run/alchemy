/**
 * The Ask protocol's surface (designs/ai/chat-apps.md §2.1): a parked
 * MID-EXECUTION tool waiting on a human. Renders from the `data-ask`
 * part and reconciles in place on its stable part id — pending shows
 * approve/deny, answered shows the verdict. Answering goes through the
 * control plane (`POST /api/asks/:id`); the state flip arrives as a
 * kernel fact through the stream, never from the click (the click only
 * disables the buttons).
 */
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircleIcon, HandIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";

export type AskData = {
  askId: string;
  status: "pending" | "answered";
  payload: { kind: "approval" | "question"; text: string; options?: string[] };
  verdict?: string;
};

const answerAsk = (askId: string, verdict: "approved" | "denied" | "answered", text?: string) =>
  fetch(`/api/asks/${encodeURIComponent(askId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict, ...(text !== undefined && { text }) }),
  });

export function AskCard({ data }: { data: AskData }) {
  const [submitted, setSubmitted] = useState(false);
  const pending = data.status === "pending";

  const answer = (verdict: "approved" | "denied", text?: string) => {
    setSubmitted(true);
    void answerAsk(data.askId, verdict, text);
  };

  return (
    <Card className="my-2 w-full max-w-md gap-3 border-amber-500/40 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <HandIcon className="size-4 text-amber-600" />
          {pending ? (
            <Shimmer>Approval needed</Shimmer>
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {data.verdict === "denied" ? (
                <XCircleIcon className="size-4 text-red-600" />
              ) : (
                <CheckCircleIcon className="size-4 text-green-600" />
              )}
              {data.verdict}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-sm">{data.payload.text}</CardContent>
      {pending && (
        <CardFooter className="gap-2 px-4">
          {data.payload.kind === "question" && data.payload.options ? (
            data.payload.options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                disabled={submitted}
                onClick={() => answer("approved", option)}
              >
                {option}
              </Button>
            ))
          ) : (
            <>
              <Button size="sm" disabled={submitted} onClick={() => answer("approved")}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={submitted}
                onClick={() => answer("denied")}
              >
                Deny
              </Button>
            </>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
