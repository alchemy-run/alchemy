import {
  Check,
  CornerDownLeft,
  FileDiff,
  Locate,
  MessageCircle,
  Reply,
  SquareArrowOutUpRight,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { steerThread, type ChannelMessage } from "@/lib/channel";
import { cn } from "@/lib/utils";

/**
 * A NOTIFICATION is a thread reaching the operator: a card in the
 * channel ("I need a decision", "this landed — look"). The operator
 * answers it where they stand — inline, on the card or in the bell —
 * and the words go to the thread's agent, quoting the card so the
 * agent knows which question was answered. Or they jump: to the card
 * itself in the channel, or into the thread (its review, when the
 * card names one).
 */

/** The answer as the thread's agent hears it: the card's headline
 *  quoted, then the operator's words. */
export const answerText = (title: string, text: string): string =>
  `> ${title}\n\n${text}`;

/**
 * The inline answer: a textarea and Send (⌘↵ / Ctrl↵ sends too). On
 * success it collapses into "Answered" — the reply lives in the
 * thread from here on.
 */
export const AnswerBox = ({
  thread,
  title,
  compact = false,
  onAnswered,
  onCancel,
}: {
  thread: string;
  title: string;
  /** The bell's tight column: smaller controls. */
  compact?: boolean;
  onAnswered?: () => void;
  onCancel?: () => void;
}) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setFailed(false);
    try {
      const response = await steerThread(thread, answerText(title, trimmed));
      if (!response.ok) throw new Error(response.statusText);
      setText("");
      onAnswered?.();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }, [text, sending, thread, title, onAnswered]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && onCancel !== undefined) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      data-answer-box
      aria-label={`Answer: ${title}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-1.5"
      // the card row underneath selects on click — typing is not a click
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Textarea
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Answer the thread…"
        aria-label="Your answer"
        rows={compact ? 2 : 3}
        className={cn(
          "min-h-0 resize-none text-[13px]",
          compact && "text-[12px]",
        )}
      />
      <div className="flex items-center gap-2">
        {failed && (
          <span className="text-[11px] text-brick">
            Could not send — try again.
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          ⌘↵
        </span>
        {onCancel !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-[12px]"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          className="h-7 gap-1 text-[12px]"
          disabled={text.trim().length === 0 || sending}
        >
          <CornerDownLeft className="size-3" />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
};

/** "Answered" — the reply went to the thread; a link to go see it. */
export const Answered = ({
  onOpenThread,
  compact = false,
}: {
  onOpenThread?: () => void;
  compact?: boolean;
}) => (
  <div
    data-answered
    className={cn(
      "flex items-center gap-1.5 text-muted-foreground",
      compact ? "text-[11px]" : "text-[12px]",
    )}
  >
    <Check className="size-3.5 text-primary" />
    Answered
    {onOpenThread !== undefined && (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpenThread();
        }}
        className="cursor-pointer text-mist hover:underline"
      >
        see the thread
      </button>
    )}
  </div>
);

/** What a notification's row can do, on the card and in the bell. */
export interface NotificationActions {
  /** The card in the channel — scroll to it and flash it. */
  onJumpToCard: (seq: number) => void;
  onOpenThread: (id: string) => void;
  onOpenReview: (
    thread: string,
    owner: string,
    repo: string,
    number: number,
  ) => void;
}

/** Into the thread — its review when the card names one. A card
 *  without a thread (a channel-agent approval) has nowhere to open;
 *  the jump-to-card action covers it. */
export const openCardTarget = (
  message: ChannelMessage & { card: NonNullable<ChannelMessage["card"]> },
  actions: Pick<NotificationActions, "onOpenThread" | "onOpenReview">,
): void => {
  const { card } = message;
  if (card.thread === undefined) return;
  if (card.review !== undefined) {
    actions.onOpenReview(
      card.thread,
      card.review.owner,
      card.review.repo,
      card.review.number,
    );
  } else {
    actions.onOpenThread(card.thread);
  }
};

/**
 * One row of the bell: the card's headline (click: jump to the card
 * in the channel), its first line, the thread's name — and the two
 * ways to act on it: Answer inline, or open the thread.
 */
export const NotificationRow = ({
  message,
  threadName,
  unseen,
  actions,
}: {
  message: ChannelMessage & { card: NonNullable<ChannelMessage["card"]> };
  threadName: string;
  /** Arrived since the bell was last opened — marked. */
  unseen: boolean;
  actions: NotificationActions;
}) => {
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState(false);
  const { card } = message;
  const Icon = card.review !== undefined ? FileDiff : MessageCircle;

  return (
    <div
      data-notification={message.id}
      data-unseen={unseen ? "" : undefined}
      className="flex flex-col gap-1.5 border-b border-border/60 px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-mist" />
        <button
          type="button"
          onClick={() => actions.onJumpToCard(message.seq)}
          title="Jump to the card in the channel"
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="flex items-center gap-1.5">
            {unseen && (
              <span
                aria-label="new"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
            <span className="truncate text-[13px] font-medium hover:underline">
              {card.title}
            </span>
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {message.text.split("\n")[0]}
          </span>
        </button>
        <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">
          {threadName}
        </span>
      </div>
      {answered ? (
        <Answered
          compact
          onOpenThread={
            card.thread === undefined
              ? undefined
              : () => actions.onOpenThread(card.thread!)
          }
        />
      ) : answering && card.thread !== undefined ? (
        <AnswerBox
          compact
          thread={card.thread}
          title={card.title}
          onAnswered={() => {
            setAnswering(false);
            setAnswered(true);
          }}
          onCancel={() => setAnswering(false)}
        />
      ) : (
        <div className="flex items-center gap-1 pl-5.5">
          {card.thread !== undefined && card.approval === undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
              onClick={() => setAnswering(true)}
              aria-label={`Answer: ${card.title}`}
            >
              <Reply className="size-3" />
              Answer
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => actions.onJumpToCard(message.seq)}
            aria-label={`Jump to the card: ${card.title}`}
          >
            <Locate className="size-3" />
            Card
          </Button>
          {card.thread !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
              onClick={() => openCardTarget(message, actions)}
              aria-label={
                card.review !== undefined
                  ? `Open the review: ${card.title}`
                  : `Open the thread: ${card.title}`
              }
            >
              <SquareArrowOutUpRight className="size-3" />
              {card.review !== undefined ? "Review" : "Thread"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
