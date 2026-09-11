import { expect, test as base, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import pr147 from "../fixtures/pr-147.json" with { type: "json" };
import pr148 from "../fixtures/pr-148.json" with { type: "json" };
import type {
  ChannelCard,
  ChannelMessage,
  ThreadListing,
  ThreadState,
} from "../../ui/lib/channel.ts";
import type { ChangedFile } from "../../ui/lib/diff.ts";
import {
  CHANNEL_PATH,
  reviewPath,
  terminalPath,
  threadPath,
} from "../../ui/lib/routes.ts";

export { expect };
export { CHANNEL_PATH, reviewPath, terminalPath, threadPath };

/** The wall clock every `ui` test runs under — relative timestamps
 *  are computed against this, never against now. */
export const NOW = new Date("2026-08-21T12:00:00Z");

export const OWNER = "alchemy-run";
export const REPO_NAME = "test-alchemy";
export const REPO = `${OWNER}/${REPO_NAME}`;

type PullRequestView = typeof pr148;

/* ── the fixtures' diffs, split as GitHub pages them ──────────────── */

const diffOf = (number: number): string =>
  readFileSync(
    new URL(`../fixtures/pr-${number}.diff`, import.meta.url),
    "utf8",
  );

/** Split a fixture's unified diff into GitHub's per-file records:
 *  the header lines give the names and status, the hunks the patch. */
export const filesOf = (number: number): ChangedFile[] =>
  diffOf(number)
    .split(/^(?=diff --git )/m)
    .filter((block) => block.startsWith("diff --git "))
    .map((block) => {
      const lines = block.split("\n");
      const hunk = lines.findIndex((line) => line.startsWith("@@"));
      const header = hunk === -1 ? lines : lines.slice(0, hunk);
      const patch = hunk === -1 ? undefined : lines.slice(hunk).join("\n");
      const names = /^diff --git a\/(.+) b\/(.+)$/.exec(header[0]!)!;
      const renamed = header.some((line) => line.startsWith("rename to "));
      const status: ChangedFile["status"] = header.some((line) =>
        line.startsWith("new file"),
      )
        ? "added"
        : header.some((line) => line.startsWith("deleted file"))
          ? "removed"
          : renamed
            ? "renamed"
            : "modified";
      const count = (sign: string) =>
        patch === undefined
          ? 0
          : patch
              .split("\n")
              .filter(
                (line) =>
                  line.startsWith(sign) && !line.startsWith(sign.repeat(3)),
              ).length;
      return {
        filename: names[2]!,
        previousFilename: renamed ? names[1] : undefined,
        status,
        additions: count("+"),
        deletions: count("-"),
        patch,
        blobUrl: `https://github.com/${REPO}/blob/head/${names[2]}`,
      };
    });

type WebSocketRoute = Parameters<Parameters<Page["routeWebSocket"]>[1]>[0];

/**
 * The FAKE BACKEND — an in-memory model of the org Worker's surface,
 * answered from `page.route`: the channel log + directory (HTTP page
 * + `/channel` cursor socket), thread state (`/api/threads/:id` +
 * `/thread/:id` snapshot socket), pulls from the fixtures,
 * chat run sockets, terminals. Mutable so tests seed a scenario and
 * then assert on what the UI did to it.
 */
export class FakeApi {
  /* ── the channel ── */

  /** The log, seq-dense from 1. */
  messages: ChannelMessage[] = [];
  directory: ThreadListing[] = [];
  /** Every `POST /api/channel` text, in order. */
  posts: string[] = [];
  /** Every `POST /api/channel` that replied — `{ text, replyTo }`. */
  replies: Array<{ text: string; replyTo: string[] }> = [];
  /** The live `/channel` sockets (the app opens one). */
  private channelSockets: WebSocketRoute[] = [];

  private nextSeq = 1;

  seedMessage(
    partial: Partial<ChannelMessage> & { kind: ChannelMessage["kind"] },
  ): ChannelMessage {
    const seq = this.nextSeq++;
    const message: ChannelMessage = {
      id: `m-${seq}`,
      seq,
      at: NOW.getTime() - 3_600_000 + seq * 60_000,
      author: undefined,
      text: "",
      ...partial,
    };
    this.messages = [...this.messages, message];
    return message;
  }

  seedEvent(
    text: string,
    options: {
      author?: string;
      event?: string;
      ref?: string;
      thread?: string;
    } = {},
  ): ChannelMessage {
    return this.seedMessage({
      kind: "event",
      text,
      repo: REPO,
      event: options.event ?? "IssueOpened",
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
      ...(options.thread !== undefined ? { thread: options.thread } : {}),
      author:
        options.author === undefined ? undefined : { login: options.author },
    });
  }

  seedUser(text: string, login = "sam-goodwin"): ChannelMessage {
    return this.seedMessage({ kind: "user", text, author: { login } });
  }

  seedAgent(text: string): ChannelMessage {
    return this.seedMessage({ kind: "agent", text });
  }

  seedCard(card: ChannelCard, text: string): ChannelMessage {
    return this.seedMessage({ kind: "card", text, card });
  }

  /** Push a LIVE append to every subscribed channel socket. */
  pushMessage(
    partial: Partial<ChannelMessage> & { kind: ChannelMessage["kind"] },
  ): ChannelMessage {
    const message = this.seedMessage(partial);
    for (const socket of this.channelSockets) {
      socket.send(JSON.stringify({ type: "item", item: message }));
    }
    return message;
  }

  /** Every id `DELETE /api/channel/messages` named, in order. */
  deletedMessages: string[] = [];

  /** Delete messages and push the `remove` frame — what the Worker's
   *  DO does when the operator deletes rows. */
  removeMessages(ids: ReadonlyArray<string>): void {
    const drop = new Set(ids);
    const seqs = this.messages
      .filter((message) => drop.has(message.id))
      .map((message) => message.seq);
    if (seqs.length === 0) return;
    this.messages = this.messages.filter((message) => !drop.has(message.id));
    for (const socket of this.channelSockets) {
      socket.send(JSON.stringify({ type: "remove", seqs }));
    }
  }

  /** Amend a message in place and push the `update` frame. */
  amendMessage(seq: number, patch: Partial<ChannelMessage>): void {
    this.messages = this.messages.map((message) =>
      message.seq === seq ? { ...message, ...patch } : message,
    );
    const amended = this.messages.find((message) => message.seq === seq);
    if (amended === undefined) return;
    for (const socket of this.channelSockets) {
      socket.send(JSON.stringify({ type: "update", item: amended }));
    }
  }

  pushDirectory(): void {
    for (const socket of this.channelSockets) {
      socket.send(JSON.stringify({ type: "directory", rows: this.directory }));
    }
  }

  /* ── threads ── */

  threads: Record<string, ThreadState> = {};
  /** Every `POST /api/threads/:id/steer` body, keyed by thread. */
  steered: Array<{ thread: string; text: string }> = [];
  /** Every `POST /api/threads/:id/close`, in order. */
  closedThreads: string[] = [];
  /** Every `DELETE /api/threads/:id`, in order. */
  deletedThreads: string[] = [];
  /** When set, thread DELETEs answer only once this resolves — the
   *  real server tears down agents, worktrees, and the machine before
   *  answering, and the row stays in the directory until then. */
  private threadDeleteGate: Promise<void> | undefined;
  /** Hold every thread DELETE open; returns the release. */
  holdThreadDelete(): () => void {
    let release!: () => void;
    this.threadDeleteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  /** Every stop / resume / delete on a thread's agent, in order. */
  agentActions: Array<{
    thread: string;
    key: string;
    action: "stop" | "resume" | "delete";
  }> = [];
  /** When set, agent actions answer only once this resolves — the row
   *  shows the request in flight until then. */
  /** How many EN-MASSE requests landed (`…/agents/<verb>`) — the
   *  per-agent actions above are recorded for each key either way. */
  bulkRequests = 0;
  private agentActionGate: Promise<void> | undefined;
  /** Hold every agent action open; returns the release. */
  holdAgentActions(): () => void {
    let release!: () => void;
    this.agentActionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  private threadSockets: Record<string, WebSocketRoute[]> = {};

  /* ── models ── */

  /** The catalog `GET /api/models` serves — the real one's shape. */
  readonly models = [
    {
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      provider: "anthropic",
    },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1", provider: "anthropic" },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      provider: "anthropic",
    },
    { id: "gpt-5", label: "GPT-5", provider: "openai" },
    { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai" },
    {
      id: "deepseek-flash",
      label: "DeepSeek V4.1 Flash",
      provider: "deepseek",
    },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek" },
  ];
  readonly defaultModel = "claude-haiku-4-5";
  /** An engineer session's own pick (`Engineer:<key>`), `null` = default. */
  engineerModels: Record<string, string | null> = {};
  /** Every `PUT /api/chats/:id/model`, in order. */
  modelPicks: Array<{ session: string; model: string | null }> = [];

  seedThread(partial: Partial<ThreadState> & { id: string }): ThreadState {
    const state: ThreadState = {
      name: partial.id,
      title: "",
      status: "open",
      turn: "you",
      createdAt: NOW.getTime() - 3_600_000,
      updatedAt: NOW.getTime() - 60_000,
      assigned: [],
      agents: [],
      members: [],
      ...partial,
    };
    this.threads = { ...this.threads, [state.id]: state };
    this.directory = [
      ...this.directory.filter((row) => row.id !== state.id),
      {
        id: state.id,
        name: state.name,
        title: state.title,
        status: state.status,
        turn: state.turn,
        updatedAt: state.updatedAt,
      },
    ];
    return state;
  }

  /**
   * A directory row whose thread has NO state — the server answers
   * `/api/threads/:id` with 404 (its state was lost, or it was made
   * under an earlier storage layout) yet the rail still lists it. The
   * real server keeps letting it be deleted; so does this one.
   */
  seedOrphanRow(row: Partial<ThreadListing> & { id: string }): ThreadListing {
    const listing: ThreadListing = {
      name: row.id,
      title: "",
      status: "open",
      turn: "others",
      updatedAt: NOW.getTime() - 60_000,
      ...row,
    };
    this.directory = [
      ...this.directory.filter((entry) => entry.id !== listing.id),
      listing,
    ];
    return listing;
  }

  /** Amend a thread's state and push the snapshot to its sockets. */
  updateThread(id: string, patch: Partial<ThreadState>): void {
    const current = this.threads[id];
    if (current === undefined) return;
    const next = { ...current, ...patch };
    this.threads = { ...this.threads, [id]: next };
    for (const socket of this.threadSockets[id] ?? []) {
      socket.send(JSON.stringify({ type: "state", state: next }));
    }
  }

  /* ── pulls ── */

  prs: Record<number, PullRequestView> = { 148: pr148, 147: pr147 };
  /** Every `GET /api/pulls/…/:n` (the review's load), in order. */
  pullLoads: number[] = [];
  /** Every files page fetched, in order — the fake pages ONE file per
   *  page so any PR exercises the progressive load. */
  filePages: Array<{ number: number; page: number }> = [];
  /** Files served WITHOUT a patch (binary / too large upstream). */
  unrenderable = new Set<string>();
  /** Files reported HUGE (+1 200 lines) — collapsed behind a click. */
  large = new Set<string>();

  /* ── chat run sockets (`/attach/<term>/<key>`) ── */

  /** Durable observations per chat id, in seq order — what the socket
   *  replays when the transcript view subscribes. */
  transcripts: Record<string, unknown[]> = {};

  /** Every `DELETE /api/chats/:id/messages/:mid`, in order. */
  deletedChatMessages: Array<{ id: string; messageId: string }> = [];
  /** Every `POST /api/chats/:id/interrupt` — the stop button. */
  interrupted: string[] = [];
  private chatSockets: Record<string, WebSocketRoute[]> = {};

  private envelope(id: string, seq: number) {
    const at = id.indexOf(":");
    return {
      term: id.slice(0, at),
      key: id.slice(at + 1),
      seq,
      at: NOW.getTime() - 60_000 + seq * 1000,
    };
  }

  /**
   * A round IN FLIGHT in chat `id`: the user asked, the agent called
   * `name` — and nothing has come back yet. The transcript view sees
   * an open turn (the stop button shows) until an observation ends it.
   */
  /**
   * A round IN FLIGHT: the model called one tool and its handler is
   * still running — the `tool-call` row is durable (a view that opens
   * now sees the call), the sampling's `assistant` row has not landed.
   * Returns the call's id so a test can land the rest of the round
   * with {@link landOpenRound}.
   */
  seedOpenRound(
    id: string,
    turn: { ask: string; name: string; input: unknown },
  ): string {
    const rows = this.transcripts[id] ?? [];
    const seq = rows.length;
    const callId = `call-${seq + 1}`;
    this.transcripts[id] = [
      ...rows,
      { ...this.envelope(id, seq), type: "input", text: turn.ask },
      {
        ...this.envelope(id, seq + 1),
        type: "tool-call",
        tick: 0,
        toolCallId: callId,
        toolName: turn.name,
        input: turn.input,
      },
    ];
    return callId;
  }

  /** The rest of a {@link seedOpenRound} round, as the Worker writes it
   *  once the handler returns: the `assistant` row restating the call,
   *  then the call's result, then the quiescent reply. */
  landOpenRound(
    id: string,
    callId: string,
    turn: { name: string; input: unknown; output: unknown; reply: string },
  ): void {
    this.pushObservation(id, {
      type: "assistant",
      tick: 0,
      ms: 800,
      text: "",
      toolCalls: [{ id: callId, name: turn.name, input: turn.input }],
    });
    this.pushObservation(id, {
      type: "tool-result",
      toolCallId: callId,
      toolName: turn.name,
      output: turn.output,
      isFailure: false,
    });
    this.pushObservation(id, {
      type: "assistant",
      tick: 1,
      ms: 400,
      text: turn.reply,
      toolCalls: [],
    });
  }

  /** Append one durable observation to chat `id` and broadcast it to
   *  every attached view — what the Worker does as a round runs. */
  pushObservation(id: string, observation: Record<string, unknown>): void {
    const rows = this.transcripts[id] ?? [];
    const full = { ...this.envelope(id, rows.length), ...observation };
    this.transcripts[id] = [...rows, full];
    for (const ws of this.chatSockets[id] ?? []) {
      ws.send(
        JSON.stringify({
          type: "observation",
          durable: true,
          observation: full,
        }),
      );
    }
  }

  /**
   * One finished turn in chat `id`: the user asks, the agent calls one
   * tool (`name` with `input`, answered by `output`), and replies. The
   * shape every per-tool card is exercised through.
   */
  seedTool(
    id: string,
    turn: {
      ask: string;
      name: string;
      input: unknown;
      /** The tool's answer — the record of its out-fields (or a plain
       *  string for failures/legacy tools). */
      output: unknown;
      isFailure?: boolean;
      reply: string;
    },
  ): void {
    const at = id.indexOf(":");
    const envelope = (seq: number) => ({
      term: id.slice(0, at),
      key: id.slice(at + 1),
      seq,
      at: NOW.getTime() - 60_000 + seq * 1000,
    });
    const callId = `call-${(this.transcripts[id]?.length ?? 0) + 1}`;
    const rows = this.transcripts[id] ?? [];
    const seq = rows.length;
    this.transcripts[id] = [
      ...rows,
      { ...envelope(seq), type: "input", text: turn.ask },
      {
        ...envelope(seq + 1),
        type: "assistant",
        tick: 0,
        ms: 800,
        text: "",
        toolCalls: [{ id: callId, name: turn.name, input: turn.input }],
      },
      {
        ...envelope(seq + 2),
        type: "tool-result",
        toolCallId: callId,
        toolName: turn.name,
        output: turn.output,
        isFailure: turn.isFailure ?? false,
      },
      {
        ...envelope(seq + 3),
        type: "assistant",
        tick: 1,
        ms: 600,
        text: turn.reply,
        toolCalls: [],
      },
    ];
  }

  /**
   * One turn with a RUN of tool calls — the agent calls a tool once
   * per tick, `calls.length` ticks in a row, then replies. The shape
   * "make a worktree for each of these five pulls" takes, and what
   * the transcript folds into one line.
   */
  seedTools(
    id: string,
    turn: {
      ask: string;
      calls: ReadonlyArray<{
        name: string;
        input: unknown;
        output: unknown;
        isFailure?: boolean;
        /** Still running: a durable `tool-call` row, no result yet —
         *  the round has not landed, and there is no reply. */
        open?: boolean;
      }>;
      reply: string;
    },
  ): void {
    const at = id.indexOf(":");
    const envelope = (seq: number) => ({
      term: id.slice(0, at),
      key: id.slice(at + 1),
      seq,
      at: NOW.getTime() - 60_000 + seq * 1000,
    });
    const rows = [...(this.transcripts[id] ?? [])];
    rows.push({ ...envelope(rows.length), type: "input", text: turn.ask });
    let inFlight = false;
    turn.calls.forEach((call, tick) => {
      const callId = `call-${rows.length + 1}`;
      if (call.open) {
        inFlight = true;
        rows.push({
          ...envelope(rows.length),
          type: "tool-call",
          tick,
          toolCallId: callId,
          toolName: call.name,
          input: call.input,
        });
        return;
      }
      rows.push({
        ...envelope(rows.length),
        type: "assistant",
        tick,
        ms: 500,
        text: "",
        toolCalls: [{ id: callId, name: call.name, input: call.input }],
      });
      rows.push({
        ...envelope(rows.length),
        type: "tool-result",
        toolCallId: callId,
        toolName: call.name,
        output: call.output,
        isFailure: call.isFailure ?? false,
      });
    });
    if (!inFlight) {
      rows.push({
        ...envelope(rows.length),
        type: "assistant",
        tick: turn.calls.length,
        ms: 600,
        text: turn.reply,
        toolCalls: [],
      });
    }
    this.transcripts[id] = rows;
  }

  /** A turn where the agent runs `command` through `bash`. `stdout`
   *  may carry ANSI escapes — the point of seeding it. */
  seedBash(
    id: string,
    turn: {
      ask: string;
      command: string;
      exit?: number;
      stdout: string;
      stderr?: string;
      reply: string;
    },
  ): void {
    this.seedTool(id, {
      ask: turn.ask,
      name: "bash",
      input: { command: turn.command },
      output: {
        exitCode: turn.exit ?? 0,
        stdout: turn.stdout,
        stderr: turn.stderr ?? "",
      },
      reply: turn.reply,
    });
  }

  /** An input the session heard WITHOUT answering — a quiet delivery
   *  (`wake: false`): the thread's bookkeeping, a webhook event. */
  seedInput(id: string, text: string): void {
    const at = id.indexOf(":");
    const rows = this.transcripts[id] ?? [];
    const seq = rows.length;
    this.transcripts[id] = [
      ...rows,
      {
        term: id.slice(0, at),
        key: id.slice(at + 1),
        seq,
        at: NOW.getTime() - 60_000 + seq * 1000,
        type: "input",
        text,
      },
    ];
  }

  /** A plain exchange (no tool call) in chat `id`. */
  seedTurn(id: string, ask: string, reply: string): void {
    const at = id.indexOf(":");
    const envelope = (seq: number) => ({
      term: id.slice(0, at),
      key: id.slice(at + 1),
      seq,
      at: NOW.getTime() - 60_000 + seq * 1000,
    });
    const rows = this.transcripts[id] ?? [];
    const seq = rows.length;
    this.transcripts[id] = [
      ...rows,
      { ...envelope(seq), type: "input", text: ask },
      {
        ...envelope(seq + 1),
        type: "assistant",
        tick: 0,
        ms: 500,
        text: reply,
        toolCalls: [],
      },
    ];
  }

  readonly terminal = new FakeTerminal();

  /* ── install ── */

  async install(page: Page): Promise<void> {
    await page.route("**/api/**", (route) => this.handle(route));
    // nothing in the `ui` project leaves the machine: avatars, the
    // GitHub hover-card lookups, anything else on the public internet
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) =>
      route.abort(),
    );
    await page.routeWebSocket(/\/channel$/, (ws) => this.attachChannel(ws));
    await page.routeWebSocket(/\/thread\//, (ws) => this.attachThread(ws));
    await page.routeWebSocket(/\/attach\//, (ws) => this.attachChat(ws));
    await page.routeWebSocket(/\/terminal\//, (ws) =>
      this.terminal.attach(ws.url(), ws),
    );
  }

  private attachChannel(ws: WebSocketRoute) {
    this.channelSockets.push(ws);
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as {
        type: string;
        after?: number;
      };
      if (frame.type !== "subscribe") return;
      const after = frame.after ?? 0;
      const items = this.messages.filter((message) => message.seq > after);
      ws.send(JSON.stringify({ type: "batch", items, head: this.nextSeq - 1 }));
      ws.send(JSON.stringify({ type: "live", seq: this.nextSeq - 1 }));
      ws.send(JSON.stringify({ type: "directory", rows: this.directory }));
    });
  }

  private attachThread(ws: WebSocketRoute) {
    const path = decodeURIComponent(new URL(ws.url()).pathname);
    const id = path.slice("/thread/".length);
    this.threadSockets[id] = [...(this.threadSockets[id] ?? []), ws];
    const state = this.threads[id];
    if (state !== undefined) {
      ws.send(JSON.stringify({ type: "state", state }));
    }
  }

  private attachChat(ws: WebSocketRoute) {
    const path = decodeURIComponent(new URL(ws.url()).pathname);
    // /attach/<term>/<key…>
    const [, , term, ...rest] = path.split("/");
    const id = `${term}:${rest.join("/")}`;
    this.chatSockets[id] = [...(this.chatSockets[id] ?? []), ws];
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as { type: string };
      if (frame.type !== "subscribe") return;
      const rows = this.transcripts[id] ?? [];
      for (const observation of rows) {
        ws.send(
          JSON.stringify({ type: "observation", durable: true, observation }),
        );
      }
      ws.send(JSON.stringify({ type: "live", seq: rows.length }));
    });
  }

  /* ── the HTTP surface ── */

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (path === "/api/me") {
      return this.json(route, {
        login: "sam-goodwin",
        name: "Sam Goodwin",
        // the ui project aborts everything off-host — the fallback shows
        avatarUrl: "https://avatars.githubusercontent.com/u/0?v=4",
        url: "https://github.com/sam-goodwin",
      });
    }
    if (path === "/api/repos") {
      return this.json(route, [{ name: REPO, sessions: true }]);
    }

    if (path === "/api/channel" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const items = this.messages
        .filter((message) => message.seq > after)
        .slice(0, limit);
      const head = this.nextSeq - 1;
      const last = items[items.length - 1]?.seq;
      return this.json(route, {
        items,
        head,
        next: last !== undefined && last < head ? last : null,
      });
    }
    if (path === "/api/channel" && method === "POST") {
      const body = (request.postDataJSON() ?? {}) as {
        text?: string;
        replyTo?: string[];
      };
      const text = body.text ?? "";
      this.posts.push(text);
      const replyTo = body.replyTo ?? [];
      if (replyTo.length > 0) this.replies.push({ text, replyTo });
      this.pushMessage({
        kind: "user",
        text,
        author: { login: "sam-goodwin" },
        ...(replyTo.length > 0 ? { replyTo } : {}),
      });
      return this.json(route, {});
    }
    if (path === "/api/channel/directory") {
      return this.json(route, this.directory);
    }

    if (path === "/api/channel/messages" && method === "DELETE") {
      const body = (request.postDataJSON() ?? {}) as { ids?: string[] };
      const ids = body.ids ?? [];
      this.deletedMessages.push(...ids);
      this.removeMessages(ids);
      return this.json(route, { deleted: ids.length });
    }

    // the switches EN MASSE: POST …/agents/(stop|resume|delete) with
    // `{ keys }` (a selection) or nothing (every agent) — recorded as
    // one action per agent, exactly what the server's fan-out does
    const bulk = path.match(
      /^\/api\/threads\/([^/]+)\/agents\/(stop|resume|delete)$/,
    );
    if (bulk !== null && method === "POST") {
      this.bulkRequests += 1;
      const id = decodeURIComponent(bulk[1]!);
      const verb = bulk[2] as "stop" | "resume" | "delete";
      const state = this.threads[id];
      if (state === undefined) {
        return this.json(route, { error: `no thread ${id}` }, 404);
      }
      const body = (request.postDataJSON() ?? {}) as { keys?: string[] };
      const keys = body.keys ?? state.agents.map((entry) => entry.key);
      for (const key of keys) {
        this.agentActions.push({ thread: id, key, action: verb });
      }
      if (this.agentActionGate !== undefined) await this.agentActionGate;
      this.updateThread(id, {
        agents:
          verb === "delete"
            ? state.agents.filter((entry) => !keys.includes(entry.key))
            : state.agents.map((entry) => {
                if (!keys.includes(entry.key)) return entry;
                const { settledAt: _settled, ...rest } = entry;
                return verb === "stop"
                  ? { ...entry, state: "stopped", settledAt: NOW.getTime() }
                  : { ...rest, state: "running" };
              }),
      });
      return this.json(route, this.threads[id]);
    }

    // a thread's agents: POST …/agents/:key/(stop|resume), DELETE …/agents/:key
    const agent = path.match(
      /^\/api\/threads\/([^/]+)\/agents\/([^/]+)(\/(stop|resume))?$/,
    );
    if (agent !== null) {
      const id = decodeURIComponent(agent[1]!);
      const key = decodeURIComponent(agent[2]!);
      const verb = agent[4];
      const state = this.threads[id];
      const row = state?.agents.find((entry) => entry.key === key);
      if (state === undefined || row === undefined) {
        return this.json(route, { error: `no agent ${key}` }, 404);
      }
      if (verb === undefined && method === "DELETE") {
        this.agentActions.push({ thread: id, key, action: "delete" });
        if (this.agentActionGate !== undefined) await this.agentActionGate;
        this.updateThread(id, {
          agents: state.agents.filter((entry) => entry.key !== key),
        });
        return this.json(route, this.threads[id]);
      }
      if ((verb === "stop" || verb === "resume") && method === "POST") {
        this.agentActions.push({ thread: id, key, action: verb });
        if (this.agentActionGate !== undefined) await this.agentActionGate;
        const { settledAt: _settled, ...rest } = row;
        this.updateThread(id, {
          agents: state.agents.map((entry) =>
            entry.key === key
              ? verb === "stop"
                ? { ...entry, state: "stopped", settledAt: NOW.getTime() }
                : { ...rest, state: "running" }
              : entry,
          ),
        });
        return this.json(route, this.threads[id]);
      }
      return this.json(route, { error: "method not allowed" }, 405);
    }

    if (path === "/api/models") {
      return this.json(route, {
        models: this.models,
        default: this.defaultModel,
      });
    }

    // a session's model: a thread's from its state, an engineer's from
    // its own cell; PUT records the pick and answers the new one
    const chatModel = path.match(/^\/api\/chats\/([^/]+)\/model$/);
    if (chatModel !== null) {
      const session = decodeURIComponent(chatModel[1]!);
      const at = session.indexOf(":");
      const term = session.slice(0, at);
      const key = session.slice(at + 1);
      const body = (method === "PUT" ? (request.postDataJSON() ?? {}) : {}) as {
        model?: string | null;
      };
      if (term === "Thread") {
        const state = this.threads[key];
        if (state === undefined) {
          return this.json(route, { error: "unknown thread" }, 404);
        }
        if (method === "PUT") {
          this.modelPicks.push({ session, model: body.model ?? null });
          const { model: _model, ...rest } = state;
          this.updateThread(
            key,
            body.model === null || body.model === undefined
              ? { ...rest, model: undefined }
              : { model: body.model },
          );
        }
        return this.json(route, {
          model: this.threads[key]?.model ?? null,
          default: this.defaultModel,
        });
      }
      if (term === "Engineer") {
        if (method === "PUT") {
          this.modelPicks.push({ session, model: body.model ?? null });
          this.engineerModels[key] = body.model ?? null;
        }
        return this.json(route, {
          model: this.engineerModels[key] ?? null,
          default: this.defaultModel,
        });
      }
      return this.json(route, { error: "no model to pick" }, 404);
    }

    const thread = path.match(/^\/api\/threads\/([^/]+)(\/(close))?$/);
    if (thread !== null) {
      const id = decodeURIComponent(thread[1]!);
      const state = this.threads[id];
      if (
        state === undefined &&
        !(method === "DELETE" && thread[3] === undefined)
      ) {
        return this.json(route, { error: `unknown thread ${id}` }, 404);
      }
      if (thread[3] === "close" && method === "POST") {
        this.closedThreads.push(id);
        this.updateThread(id, { status: "closed" });
        return this.json(route, {});
      }
      if (method === "DELETE") {
        // the thread is erased; the rail learns over the directory
        // frame, the channel rows it placed lose their tag. A thread
        // with no state (an orphan row) is erased the same way — the
        // server's teardown drops the projections whatever it finds.
        this.deletedThreads.push(id);
        if (this.threadDeleteGate !== undefined) await this.threadDeleteGate;
        const { [id]: _dropped, ...rest } = this.threads;
        this.threads = rest;
        this.directory = this.directory.filter((row) => row.id !== id);
        this.messages = this.messages.map((message) =>
          message.thread === id && message.placed === true
            ? { ...message, thread: undefined, placed: undefined }
            : message,
        );
        this.pushDirectory();
        return this.json(route, { ok: true });
      }
      if (method === "POST") {
        // POST /api/threads/:id — steer: words into the thread agent
        const body = (request.postDataJSON() ?? {}) as { text?: string };
        this.steered.push({ thread: id, text: body.text ?? "" });
        return this.json(route, {});
      }
      return this.json(route, state);
    }

    const files = path.match(/^\/api\/pulls\/([^/]+)\/([^/]+)\/(\d+)\/files$/);
    if (files !== null) {
      const number = Number(files[3]);
      if (this.prs[number] === undefined) {
        return this.json(route, { error: `no pull request #${number}` }, 404);
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      this.filePages.push({ number, page });
      const all = filesOf(number).map((file) => ({
        ...file,
        patch: this.unrenderable.has(file.filename) ? undefined : file.patch,
        additions: this.large.has(file.filename) ? 1_200 : file.additions,
      }));
      const file = all[page - 1];
      return this.json(route, {
        files: file === undefined ? [] : [file],
        next: page < all.length ? page + 1 : null,
      });
    }

    const pull = path.match(/^\/api\/pulls\/([^/]+)\/([^/]+)\/(\d+)$/);
    if (pull !== null) {
      const number = Number(pull[3]);
      const view = this.prs[number];
      if (view === undefined) {
        return this.json(route, { error: `no pull request #${number}` }, 404);
      }
      this.pullLoads.push(number);
      return this.json(route, view);
    }

    const chatDelete = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (chatDelete !== null && method === "DELETE") {
      const id = decodeURIComponent(chatDelete[1]!);
      const body = (request.postDataJSON() ?? {}) as { ids?: string[] };
      for (const messageId of body.ids ?? []) {
        this.deletedChatMessages.push({ id, messageId });
        // redact the span the way the Worker does: `u-<seq>` takes the
        // one input, `a-<seq>` the burst up to the next input
        const seq = Number(messageId.split("-")[1]);
        const rows = (this.transcripts[id] ?? []) as Array<{
          seq: number;
          type: string;
        }>;
        const isBurst = messageId.startsWith("a-");
        const nextInput = rows.find(
          (row) => row.seq > seq && row.type === "input",
        )?.seq;
        this.transcripts[id] = rows.filter((row) =>
          isBurst
            ? row.seq < seq || (nextInput !== undefined && row.seq >= nextInput)
            : row.seq !== seq,
        );
      }
      return this.json(route, { deleted: (body.ids ?? []).length });
    }

    const chatInterrupt = path.match(/^\/api\/chats\/([^/]+)\/interrupt$/);
    if (chatInterrupt !== null && method === "POST") {
      const id = decodeURIComponent(chatInterrupt[1]!);
      this.interrupted.push(id);
      // the Worker aborts the round; the `aborted` observation ends the
      // turn for every attached view, then the session parks
      this.pushObservation(id, { type: "aborted", by: "operator" });
      this.pushObservation(id, { type: "parked" });
      return this.json(route, { ok: true });
    }

    const chat = path.match(/^\/api\/chats\/([^/]+)\/(messages|log)$/);
    if (chat !== null) {
      return this.json(route, { error: "transcripts ride the socket" }, 404);
    }

    return this.json(route, { error: `unhandled ${method} ${path}` }, 404);
  }
}

/**
 * The scripted MACHINE behind `/terminal/…`: mirrors the DO bridge's
 * wire protocol (text = JSON control, binary = bytes). On `open` it
 * narrates a resume, then emits a prompt — the UI's proof of life —
 * and echoes every keystroke so a test can see typed input arrive.
 */
export class FakeTerminal {
  /** Every socket that sent `open`, keyed by the URL's pty id. */
  opened: string[] = [];
  /** Keystrokes received, decoded, per pty id. */
  typed: Record<string, string> = {};
  /** Set to make `open` FAIL the way the DO bridge reports a machine
   *  that could not start: an `error` frame with this message, then
   *  every further frame is refused with "no pty". */
  failOpen: string | undefined;
  /** With `failOpen`: also close the socket after the error, so the
   *  viewer's reconnect path (a repaint from scratch) is exercised. */
  dropAfterError = false;

  attach(url: string, ws: WebSocketRoute) {
    const ptyId = new URL(url).searchParams.get("id") ?? "?";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const refuse = () =>
      ws.send(
        JSON.stringify({
          t: "error",
          message: `no pty '${ptyId}' — open it first`,
        }),
      );
    ws.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message) as { t: string };
        if (frame.t === "open") {
          this.opened.push(ptyId);
          ws.send(
            JSON.stringify({ t: "status", message: "resuming the machine" }),
          );
          if (this.failOpen !== undefined) {
            ws.send(JSON.stringify({ t: "error", message: this.failOpen }));
            refuse();
            // …and the socket drops, as when the DO gives up on the
            // machine — the viewer reconnects and reads the same again
            if (this.dropAfterError) setTimeout(() => ws.close(), 50);
            return;
          }
          ws.send(Buffer.from(encoder.encode("fake-machine:~$ ")));
        } else if (this.failOpen !== undefined) {
          refuse();
        }
        return;
      }
      if (this.failOpen !== undefined) {
        refuse();
        return;
      }
      const text = decoder.decode(message);
      this.typed[ptyId] = (this.typed[ptyId] ?? "") + text;
      ws.send(Buffer.from(encoder.encode(text)));
    });
  }
}

export const test = base.extend<{ api: FakeApi }>({
  api: [
    async ({ page }, use) => {
      const api = new FakeApi();
      await api.install(page);
      await page.clock.setFixedTime(NOW);
      await use(api);
    },
    // every test runs against the fake, whether or not it asserts on it
    { auto: true },
  ],
});

/** Load the app fresh — empty layout memory, `path` as the route. */
export const openApp = async (page: Page, path = CHANNEL_PATH) => {
  await page.goto(path);
  await page.evaluate(() => localStorage.clear());
  await page.goto(path, { waitUntil: "networkidle" });
};

export const sidebar = (page: Page) => page.getByRole("complementary");
export const main = (page: Page) => page.getByRole("main");
export const threadNav = (page: Page) =>
  page.getByRole("navigation", { name: "Threads" });
