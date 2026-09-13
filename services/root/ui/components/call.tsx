/**
 * A CALL's live view — the thread inside the thread. The transcript
 * streams over `/api/calls/:id/live` (subscribe by sending the call
 * id; a fresh snapshot arrives after every utterance) and the human
 * JOINS by posting: the message lands in the call's record and is
 * delivered to the member it addresses — the next ask carries it to
 * everyone else.
 */
import { MarkdownText } from "@/components/chat";
import { cn } from "@/lib/utils";
import { Loader2, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface CallUtterance {
  readonly seq: number;
  readonly author: string;
  readonly text: string;
  readonly at: number;
}

export interface CallView {
  readonly id: string;
  readonly topic: string;
  readonly initiator: string;
  readonly members: ReadonlyArray<string>;
  readonly open: boolean;
  readonly utterances: ReadonlyArray<CallUtterance>;
  readonly createdAt: number;
}

export const CallThread = ({ id }: { id: string }) => {
  const [call, setCall] = useState<CallView | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/api/calls/${encodeURIComponent(id)}/live`,
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ call: id }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          call?: CallView;
        };
        if (frame.type === "call" && frame.call?.id === id) {
          setCall(frame.call);
        }
      } catch {
        // a malformed frame is dropped; the next append re-snapshots
      }
    });
    return () => socket.close();
  }, [id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [call?.utterances.length]);

  const join = () => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    fetch(`/api/calls/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(to === undefined ? {} : { to }) }),
    })
      .then(() => setDraft(""))
      .finally(() => setSending(false));
  };

  if (call === undefined) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> joining the call…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-sm font-medium">{call.topic}</div>
        <div className="flex flex-wrap gap-1 pt-1 text-[11px] text-muted-foreground">
          {call.members.map((member) => (
            <button
              key={member}
              type="button"
              onClick={() => setTo(to === member ? undefined : member)}
              title={`address ${member}`}
              className={cn(
                "cursor-pointer rounded border border-border/60 px-1.5 font-mono",
                to === member && "border-moss bg-moss/10 text-foreground",
              )}
            >
              {member}
            </button>
          ))}
          {!call.open && <span className="px-1">closed</span>}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {call.utterances.map((utterance) => (
          <div key={utterance.seq} className="flex flex-col gap-0.5">
            <span className="font-mono text-[11px] font-medium">
              {utterance.author}
            </span>
            <div className="text-[13px]">
              <MarkdownText text={utterance.text} />
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-border p-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") join();
          }}
          placeholder={
            to === undefined
              ? `Say something (to ${call.initiator})…`
              : `Say something to ${to}…`
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
        />
        <button
          type="button"
          onClick={join}
          disabled={sending || draft.trim() === ""}
          aria-label="send into the call"
          className="flex size-8 cursor-pointer items-center justify-center rounded-md border border-border hover:bg-accent disabled:opacity-50"
        >
          <SendHorizontal className="size-4" />
        </button>
      </div>
    </div>
  );
};
