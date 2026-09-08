/**
 * The CHANNEL vocabulary as the Worker speaks it — mirrored from
 * `src/channel/Channel.ts` / `src/thread/Threads.ts` so the UI's types
 * match the wire without importing server code into the bundle.
 */

/* ── messages ─────────────────────────────────────────────────────── */

export interface ChannelAuthor {
  readonly login: string;
}

export type ChannelMessageKind = "event" | "user" | "agent" | "card";

export interface ChannelCard {
  readonly thread: string;
  readonly title: string;
  readonly review?: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
}

export interface ChannelMessage {
  readonly id: string;
  readonly seq: number;
  readonly at: number;
  readonly kind: ChannelMessageKind;
  readonly author: ChannelAuthor | undefined;
  /** Markdown. Pills are `[label](anchor://…)` links. */
  readonly text: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly event?: string;
  readonly thread?: string;
  readonly placed?: boolean;
  readonly card?: ChannelCard;
  /** The messages this one answers (an inline reply) — ids. */
  readonly replyTo?: ReadonlyArray<string>;
}

/* ── the directory (the rail) ─────────────────────────────────────── */

export type Turn = "you" | "agents" | "others" | "idle";

export interface ThreadDirectoryRow {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly status: "open" | "closed";
  readonly turn: Turn;
  readonly updatedAt: number;
}

/* ── thread state (the `/thread/:id` socket) ──────────────────────── */

export interface ThreadEntity {
  readonly ref: string;
  readonly kind: "issue" | "pull";
  readonly state: string;
  readonly title: string;
  readonly worktree?: string;
}

export interface ThreadAgentRow {
  readonly key: string;
  readonly kind: "engineer";
  readonly brief: string;
  readonly cwd?: string;
  readonly state: "running" | "done" | "failed" | "stopped";
  readonly startedAt: number;
  readonly settledAt?: number;
}

export interface ThreadState {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly status: "open" | "closed";
  readonly turn: Turn;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entities: ReadonlyArray<ThreadEntity>;
  readonly agents: ReadonlyArray<ThreadAgentRow>;
  readonly members: ReadonlyArray<string>;
}

/** The thread agent's session term — its chat socket is
 *  `/attach/Thread/<id>`, its transcript `/api/chats/Thread:<id>/…`. */
export const THREAD_TERM = "Thread";

export const threadSessionId = (id: string): string => `${THREAD_TERM}:${id}`;

/** A spawned engineer's session term — the thread's `spawn` tool
 *  dispatches `Engineer` under the key it records in `agents`, so the
 *  subagent's transcript is `/api/chats/Engineer:<key>/…`. */
export const ENGINEER_TERM = "Engineer";

export const engineerSessionId = (key: string): string =>
  `${ENGINEER_TERM}:${key}`;

/* ── entity refs ──────────────────────────────────────────────────── */

/** Parse `owner/repo#N`; `undefined` when it is not one. */
export const parseEntityRef = (
  ref: string,
): { owner: string; repo: string; number: number } | undefined => {
  const match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (match === null) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]!),
  };
};

/* ── anchors (review pills) ───────────────────────────────────────── */

/**
 * An ANCHOR names lines of a pull request's diff:
 * `anchor://owner/repo/pull/N/path/to/file#L10-L20@sha`. Rendered
 * inside markdown as an ordinary link (`[label](anchor://…)`), so the
 * model reads it and no custom message format exists.
 */
export interface Anchor {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** The head sha the lines were read at, when known. */
  readonly sha?: string;
}

export const formatAnchor = (anchor: Anchor): string =>
  `anchor://${anchor.owner}/${anchor.repo}/pull/${anchor.number}/${anchor.path}` +
  `#L${anchor.start}${anchor.end !== anchor.start ? `-L${anchor.end}` : ""}` +
  (anchor.sha === undefined ? "" : `@${anchor.sha}`);

export const parseAnchor = (href: string): Anchor | undefined => {
  const match =
    /^anchor:\/\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(.+?)#L(\d+)(?:-L(\d+))?(?:@([0-9a-f]+))?$/.exec(
      href,
    );
  if (match === null) return undefined;
  const start = Number(match[5]);
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
    path: match[4]!,
    start,
    end: match[6] === undefined ? start : Number(match[6]),
    ...(match[7] === undefined ? {} : { sha: match[7] }),
  };
};

/** The pill's label: `file.ts:10-20`. */
export const anchorLabel = (anchor: Anchor): string => {
  const name = anchor.path.split("/").pop() ?? anchor.path;
  return anchor.start === anchor.end
    ? `${name}:${anchor.start}`
    : `${name}:${anchor.start}-${anchor.end}`;
};

/* ── API calls ────────────────────────────────────────────────────── */

/** Post to the channel; `replyTo` names the messages it answers. */
export const postChannel = (
  text: string,
  replyTo: ReadonlyArray<string> = [],
): Promise<Response> =>
  fetch("/api/channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      replyTo.length === 0 ? { text } : { text, replyTo },
    ),
  });

export const steerThread = (id: string, text: string): Promise<Response> =>
  fetch(`/api/threads/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

/** Delete a thread — its state, its agent sessions, its machine. The
 *  channel rows it placed stay (untagged); the rail drops it over the
 *  socket's next `directory` frame. */
export const deleteThread = (id: string): Promise<Response> =>
  fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Delete channel messages (a selection) — every open view drops them
 *  over the socket's `remove` frame. */
export const deleteChannelMessages = (
  ids: ReadonlyArray<string>,
): Promise<Response> =>
  fetch("/api/channel/messages", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });

/** Delete chat messages (a thread's transcript rows) by UIMessage id
 *  — the server redacts the whole burst behind each. */
export const deleteChatMessages = (
  sessionId: string,
  ids: ReadonlyArray<string>,
): Promise<Response> =>
  fetch(`/api/chats/${encodeURIComponent(sessionId)}/messages`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });

/** The stop button: abort the session's round in flight. The session
 *  stays alive — the next message opens a fresh round. */
export const interruptChat = (sessionId: string): Promise<Response> =>
  fetch(`/api/chats/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
  });

/* ── a thread's agents: the operator's switches ── */

const agentUrl = (threadId: string, key: string) =>
  `/api/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(key)}`;

/** STOP an agent — its session settles, its command in flight is cut;
 *  the row reads stopped. Resumable. */
export const stopAgent = (threadId: string, key: string): Promise<Response> =>
  fetch(`${agentUrl(threadId, key)}/stop`, { method: "POST" });

/** RESUME a stopped (or finished) agent — it takes input again from
 *  its pane; nothing runs until it is told something. */
export const resumeAgent = (
  threadId: string,
  key: string,
): Promise<Response> =>
  fetch(`${agentUrl(threadId, key)}/resume`, { method: "POST" });

/** DELETE an agent — its session and transcript are erased and its
 *  row leaves the thread. The thread's machine stays. */
export const deleteAgent = (
  threadId: string,
  key: string,
): Promise<Response> => fetch(agentUrl(threadId, key), { method: "DELETE" });
