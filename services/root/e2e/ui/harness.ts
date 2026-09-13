import { expect, test as base, type Page, type Route } from "@playwright/test";
import type { AskNode } from "../../ui/components/ask-thread.tsx";
import type { CallView } from "../../ui/components/call.tsx";
import type { HeldInbound } from "../../ui/components/triage.tsx";

export { expect };
export type { AskNode, CallView, HeldInbound };

/** The wall clock every `ui` test runs under — relative timestamps
 *  are computed against this, never against now. */
export const NOW = new Date("2026-08-21T12:00:00Z");

/** The Root channel's session id — the Head's one session. */
export const ROOT_CHAT = "Head:root";

/** The engineering manager's session id — the right pane's feed
 *  (mirrors `MANAGER_CHAT` in ui/components/engineering.tsx; the
 *  component keeps its constant un-importable here because the module
 *  pulls the whole chat surface through vite-only aliases). */
export const MANAGER_CHAT = "EngineeringManager:root::engineering-manager";

type WebSocketRoute = Parameters<Parameters<Page["routeWebSocket"]>[1]>[0];

/* ── the task ledger (engineering.tsx, shape mirrored — the
 *    component keeps its Task interface private) ─────────────────── */

export interface TaskRow {
  id: string;
  title: string;
  items: Array<{ ref: string; kind: "issue" | "pull" | "request" }>;
  status: "todo" | "working" | "review" | "done";
  assignee?: string;
  workspace?: string;
  notes: string[];
  updatedAt: number;
}

/* ── proposals (src/proposals/Proposals.ts, shape mirrored) ───────── */

export type ProposalKind = "comment" | "push" | "open_pull" | "merge" | "close";
export type ProposalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "failed";

export interface ProposalRow {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  summary: string;
  detail: string;
  payload: Record<string, unknown> & { kind: ProposalKind };
  proposer: { term: string; key: string };
  task?: string;
  outcome?: string;
  createdAt: number;
  decidedAt?: number;
}

/**
 * The FAKE BACKEND — an in-memory model of the Worker's surface,
 * answered from `page.route`: the Root channel's session socket
 * (`/attach/:term/:key`), its snapshot + model routes, the human's
 * post door (`POST /api/root`), ask trees, calls (HTTP + live
 * socket), proposals, terminals. Mutable so tests seed a scenario
 * and then assert on what the UI did to it.
 */
export class FakeApi {
  /* ── the Root post door ── */

  /** Every text the human posted into the Root channel, in order —
   *  `POST /api/root` bodies AND the session socket's `submit` frames
   *  for `Head:root` (the composer speaks over the socket; the HTTP
   *  door is the API's other entrance and records the same way). */
  root: { posted: string[] } = { posted: [] };

  /* ── chat sessions (`/attach/<term>/<key>`) ── */

  /** Durable observations per chat id, in seq order — what the socket
   *  replays when the transcript view subscribes. */
  transcripts: Record<string, unknown[]> = {};
  /** Every socket `submit`, in order — `{ id, text }`. */
  submits: Array<{ id: string; text: string }> = [];
  /** Every `DELETE /api/chats/:id/messages`, flattened. */
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

  /** A plain exchange (no tool call) in chat `id`. */
  seedTurn(id: string, ask: string, reply: string): void {
    const rows = this.transcripts[id] ?? [];
    const seq = rows.length;
    this.transcripts[id] = [
      ...rows,
      { ...this.envelope(id, seq), type: "input", text: ask },
      {
        ...this.envelope(id, seq + 1),
        type: "assistant",
        tick: 0,
        ms: 500,
        text: reply,
        toolCalls: [],
      },
    ];
  }

  /** An input the session heard WITHOUT answering — a quiet delivery
   *  (`wake: false`): bookkeeping, a webhook event. */
  seedInput(id: string, text: string): void {
    const rows = this.transcripts[id] ?? [];
    this.transcripts[id] = [
      ...rows,
      { ...this.envelope(id, rows.length), type: "input", text },
    ];
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
      /** What the agent thought before calling the tool. */
      reasoning?: string;
    },
  ): void {
    const rows = this.transcripts[id] ?? [];
    const seq = rows.length;
    const callId = `call-${seq + 1}`;
    this.transcripts[id] = [
      ...rows,
      { ...this.envelope(id, seq), type: "input", text: turn.ask },
      {
        ...this.envelope(id, seq + 1),
        type: "assistant",
        tick: 0,
        ms: 800,
        text: "",
        ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
        toolCalls: [{ id: callId, name: turn.name, input: turn.input }],
      },
      {
        ...this.envelope(id, seq + 2),
        type: "tool-result",
        toolCallId: callId,
        toolName: turn.name,
        output: turn.output,
        isFailure: turn.isFailure ?? false,
      },
      {
        ...this.envelope(id, seq + 3),
        type: "assistant",
        tick: 1,
        ms: 600,
        text: turn.reply,
        toolCalls: [],
      },
    ];
  }

  /**
   * A round IN FLIGHT: the model called one tool and its handler is
   * still running — the `tool-call` row is durable, the sampling's
   * `assistant` row has not landed. Returns the call's id so a test
   * can land the rest of the round with {@link landOpenRound}.
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
   *  once the handler returns. */
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

  /* ── models ── */

  /** The catalog `GET /api/models` serves — the real one's shape. */
  readonly models = [
    { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
    {
      id: "claude-fable-5-1",
      label: "Claude Fable 5.1",
      provider: "anthropic",
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      provider: "anthropic",
    },
    { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai" },
    {
      id: "deepseek-flash",
      label: "DeepSeek V4.1 Flash",
      provider: "deepseek",
    },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek" },
  ];
  readonly defaultModel = "claude-haiku-4-5";
  /** A session's own pick, keyed by chat id; `null` = the default.
   *  Only `Head:*` and `Engineer:*` sessions have a model to pick
   *  (src/chat/Models.ts) — anything else answers 404. */
  sessionModels: Record<string, string | null> = {};
  /** Every `PUT /api/chats/:id/model`, in order. */
  modelPicks: Array<{ session: string; model: string | null }> = [];

  /* ── asks ── */

  /** Seedable ask TREES, keyed by the root ask's id —
   *  `GET /api/asks/:id/tree` answers the node verbatim. */
  asks: Record<string, AskNode> = {};

  seedAskTree(root: AskNode): AskNode {
    this.asks = { ...this.asks, [root.id]: root };
    return root;
  }

  /* ── calls ── */

  /** Seedable call views, keyed by id. */
  calls: Record<string, CallView> = {};
  /** Every `POST /api/calls/:id` body, in order. */
  callPosts: Array<{ id: string; text: string; to?: string }> = [];
  private callSockets: Record<string, WebSocketRoute[]> = {};

  seedCall(view: CallView): CallView {
    this.calls = { ...this.calls, [view.id]: view };
    return view;
  }

  /** Replace a call's view and push the `call` frame to every
   *  subscribed live socket — what the DO does after each utterance. */
  pushCall(view: CallView): void {
    this.calls = { ...this.calls, [view.id]: view };
    for (const socket of this.callSockets[view.id] ?? []) {
      socket.send(JSON.stringify({ type: "call", call: view }));
    }
  }

  /* ── triage (src/engineering/TriageApi.ts) ── */

  /** The valve: the mode, the held queue (oldest first), and what the
   *  UI did to it — each release records its seqs (or `"all"` for a
   *  bodyless release), each mode PUT records the requested mode. */
  triage: {
    mode: "manual" | "auto";
    held: HeldInbound[];
    released: Array<number[] | "all">;
    modeSets: Array<"manual" | "auto">;
  } = { mode: "manual", held: [], released: [], modeSets: [] };

  private nextHeldSeq = 1;

  seedHeld(
    partial: Partial<HeldInbound> & { text: string },
  ): HeldInbound {
    const seq = partial.seq ?? this.nextHeldSeq++;
    this.nextHeldSeq = Math.max(this.nextHeldSeq, seq + 1);
    const item: HeldInbound = {
      kind: "issue",
      at: NOW.getTime() - 3_600_000 + seq * 60_000,
      ...partial,
      seq,
    };
    this.triage.held = [...this.triage.held, item];
    return item;
  }

  /* ── the task ledger ── */

  /** Seedable ledger rows — `GET /api/tasks` serves them verbatim;
   *  the engineering pane groups them by status itself. */
  tasks: TaskRow[] = [];

  seedTask(
    partial: Partial<TaskRow> & { id: string; title: string },
  ): TaskRow {
    const row: TaskRow = {
      items: [],
      status: "todo",
      notes: [],
      updatedAt: NOW.getTime() - 120_000,
      ...partial,
    };
    this.tasks = [...this.tasks.filter((task) => task.id !== row.id), row];
    return row;
  }

  /* ── proposals ── */

  proposals: Record<string, ProposalRow> = {};
  /** Every `POST /api/proposals/:id`, in order. */
  decisions: Array<{
    id: string;
    decision: "approve" | "deny";
    reason?: string;
  }> = [];

  seedProposal(
    partial: Partial<ProposalRow> & { id: string; kind: ProposalKind },
  ): ProposalRow {
    const row: ProposalRow = {
      status: "pending",
      summary: "",
      detail: "",
      payload: { kind: partial.kind },
      proposer: { term: "Engineer", key: "root::e-0000" },
      createdAt: NOW.getTime() - 600_000,
      ...partial,
    };
    this.proposals = { ...this.proposals, [row.id]: row };
    return row;
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
    await page.routeWebSocket(/\/attach\//, (ws) => this.attachChat(ws));
    await page.routeWebSocket(/\/api\/calls\/[^/]+\/live$/, (ws) =>
      this.attachCall(ws),
    );
    await page.routeWebSocket(/\/terminal\//, (ws) =>
      this.terminal.attach(ws.url(), ws),
    );
  }

  /* ── the session socket ── */

  private attachChat(ws: WebSocketRoute) {
    const path = decodeURIComponent(new URL(ws.url()).pathname);
    // /attach/<term>/<key…>
    const [, , term, ...rest] = path.split("/");
    const id = `${term}:${rest.join("/")}`;
    this.chatSockets[id] = [...(this.chatSockets[id] ?? []), ws];
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as {
        type: string;
        input?: unknown;
        fromSeq?: number | "live";
      };
      // a submit is admitted as a durable input row and broadcast —
      // the durable echo is how the sender's optimistic message
      // learns its `u-<seq>` id (exactly what the Worker does)
      if (frame.type === "submit") {
        const text = String(frame.input ?? "");
        this.submits.push({ id, text });
        if (id === ROOT_CHAT) this.root.posted.push(text);
        this.pushObservation(id, { type: "input", text });
        return;
      }
      if (frame.type !== "subscribe") return;
      const rows = this.transcripts[id] ?? [];
      const from = frame.fromSeq === "live" ? rows.length : (frame.fromSeq ?? 0);
      for (const observation of rows.slice(from)) {
        ws.send(
          JSON.stringify({ type: "observation", durable: true, observation }),
        );
      }
      ws.send(JSON.stringify({ type: "live", seq: rows.length }));
    });
  }

  /* ── the call socket ── */

  private attachCall(ws: WebSocketRoute) {
    // /api/calls/<id>/live — the client re-states the id in its first
    // frame ({ call: id }); subscribe it and answer the snapshot
    const path = decodeURIComponent(new URL(ws.url()).pathname);
    const id = path.slice("/api/calls/".length, -"/live".length);
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as { call?: string };
      if (frame.call !== id) return;
      this.callSockets[id] = [...(this.callSockets[id] ?? []), ws];
      const view = this.calls[id];
      if (view !== undefined) {
        ws.send(JSON.stringify({ type: "call", call: view }));
      }
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

    if (path === "/api/root" && method === "POST") {
      const body = (request.postDataJSON() ?? {}) as { text?: string };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        return this.json(route, { error: "text required" }, 400);
      }
      this.root.posted.push(text);
      return this.json(route, { ok: true }, 202);
    }

    if (path === "/api/models") {
      return this.json(route, {
        models: this.models,
        default: this.defaultModel,
      });
    }

    // a session's model pick — only Head/Engineer sessions have one
    const chatModel = path.match(/^\/api\/chats\/([^/]+)\/model$/);
    if (chatModel !== null) {
      const session = decodeURIComponent(chatModel[1]!);
      const term = session.slice(0, session.indexOf(":"));
      if (term !== "Head" && term !== "Engineer") {
        return this.json(route, { error: "no model to pick" }, 404);
      }
      if (method === "PUT") {
        const body = (request.postDataJSON() ?? {}) as {
          model?: string | null;
        };
        this.modelPicks.push({ session, model: body.model ?? null });
        this.sessionModels[session] = body.model ?? null;
      }
      return this.json(route, {
        model: this.sessionModels[session] ?? null,
        default: this.defaultModel,
      });
    }

    // ask trees: GET /api/asks (roots) + GET /api/asks/:id/tree
    if (path === "/api/asks" && method === "GET") {
      return this.json(route, { asks: Object.values(this.asks) });
    }
    const askTree = path.match(/^\/api\/asks\/([^/]+)\/tree$/);
    if (askTree !== null && method === "GET") {
      const tree = this.asks[decodeURIComponent(askTree[1]!)];
      return tree === undefined
        ? this.json(route, { error: "no such ask" }, 404)
        : this.json(route, tree);
    }

    // calls: GET snapshot, POST the human's join
    const call = path.match(/^\/api\/calls\/([^/]+)$/);
    if (call !== null) {
      const id = decodeURIComponent(call[1]!);
      const view = this.calls[id];
      if (view === undefined) {
        return this.json(route, { error: "no such call" }, 404);
      }
      if (method === "POST") {
        const body = (request.postDataJSON() ?? {}) as {
          text?: string;
          to?: string;
        };
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (text.length === 0) {
          return this.json(route, { error: "text required" }, 400);
        }
        this.callPosts.push({
          id,
          text,
          ...(body.to === undefined ? {} : { to: body.to }),
        });
        const seq =
          view.utterances.reduce((max, u) => Math.max(max, u.seq), 0) + 1;
        const next: CallView = {
          ...view,
          utterances: [
            ...view.utterances,
            { seq, author: "human", text, at: NOW.getTime() },
          ],
        };
        // the record grows AND every attached viewer hears it — the
        // client ignores the POST's body and renders from the socket
        this.pushCall(next);
        return this.json(route, next);
      }
      return this.json(route, view);
    }

    // the triage valve: the held queue, the release, the mode
    if (path === "/api/triage" && method === "GET") {
      return this.json(route, {
        mode: this.triage.mode,
        held: this.triage.held,
      });
    }
    if (path === "/api/triage/release" && method === "POST") {
      const body = (request.postDataJSON() ?? {}) as { seqs?: unknown };
      const seqs = Array.isArray(body.seqs)
        ? body.seqs.filter((seq): seq is number => typeof seq === "number")
        : undefined;
      if (seqs === undefined) {
        // none named = release EVERYTHING held
        this.triage.released.push("all");
        const released = this.triage.held.length;
        this.triage.held = [];
        return this.json(route, { released });
      }
      this.triage.released.push(seqs);
      const drop = new Set(seqs);
      const released = this.triage.held.filter((item) =>
        drop.has(item.seq),
      ).length;
      this.triage.held = this.triage.held.filter(
        (item) => !drop.has(item.seq),
      );
      return this.json(route, { released });
    }
    if (path === "/api/triage/mode" && method === "PUT") {
      const body = (request.postDataJSON() ?? {}) as { mode?: unknown };
      if (body.mode !== "manual" && body.mode !== "auto") {
        return this.json(
          route,
          { error: 'mode must be "manual" or "auto"' },
          400,
        );
      }
      this.triage.modeSets.push(body.mode);
      this.triage.mode = body.mode;
      return this.json(route, { mode: body.mode });
    }

    // the engineering ledger
    if (path === "/api/tasks" && method === "GET") {
      return this.json(route, { tasks: this.tasks });
    }

    // proposals: the queue, one row, the decision
    if (path === "/api/proposals" && method === "GET") {
      const status = url.searchParams.get("status");
      const rows = Object.values(this.proposals).filter(
        (row) => status === null || row.status === status,
      );
      return this.json(route, { proposals: rows });
    }
    const proposal = path.match(/^\/api\/proposals\/([^/]+)$/);
    if (proposal !== null) {
      const id = decodeURIComponent(proposal[1]!);
      const row = this.proposals[id];
      if (method === "POST") {
        const body = (request.postDataJSON() ?? {}) as {
          decision?: unknown;
          reason?: unknown;
        };
        if (body.decision !== "approve" && body.decision !== "deny") {
          return this.json(
            route,
            { error: 'decision must be "approve" or "deny"' },
            400,
          );
        }
        if (row === undefined) {
          return this.json(route, { error: "no such proposal" }, 404);
        }
        const reason =
          typeof body.reason === "string" ? body.reason : undefined;
        this.decisions.push({
          id,
          decision: body.decision,
          ...(reason === undefined ? {} : { reason }),
        });
        if (row.status === "pending") {
          // deny marks denied; approve executes worker-doable kinds
          // and parks push/open_pull as approved (DecideApi.ts)
          const status: ProposalStatus =
            body.decision === "deny"
              ? "denied"
              : row.kind === "push" || row.kind === "open_pull"
                ? "approved"
                : "executed";
          const next: ProposalRow = {
            ...row,
            status,
            decidedAt: NOW.getTime(),
            ...(body.decision === "deny"
              ? {
                  outcome:
                    reason === undefined ? "denied" : `denied — ${reason}`,
                }
              : {}),
          };
          this.proposals = { ...this.proposals, [id]: next };
          return this.json(route, next);
        }
        return this.json(route, row);
      }
      return row === undefined
        ? this.json(route, { error: "no such proposal" }, 404)
        : this.json(route, row);
    }

    // the transcript snapshot: answered 404 so the view falls back to
    // a full replay over the session socket — the fake's transcripts
    // are observations, and the client's own translator projects them
    const chat = path.match(/^\/api\/chats\/([^/]+)\/(messages|log)$/);
    if (chat !== null && method === "GET") {
      return this.json(route, { error: "transcripts ride the socket" }, 404);
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
  /** The socket PATHS that sent `open` (`/terminal/<term>/<key>`) —
   *  which session's machine each terminal addressed. */
  sockets: string[] = [];
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
          this.sockets.push(new URL(url).pathname);
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

/** Load the app fresh — empty layout memory, `path` as the route.
 *  The first visit lands on the bare channel (no overlay) so storage
 *  can be cleared without mounting `path`'s overlay twice — a double
 *  mount would dial the terminal/call sockets once per mount and
 *  double every "opened" count the test asserts on. */
export const openApp = async (page: Page, path = "/") => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto(path, { waitUntil: "networkidle" });
};
