import { expect, test as base, type Page, type Route } from "@playwright/test";
import pr147 from "../fixtures/pr-147.json" with { type: "json" };
import pr148 from "../fixtures/pr-148.json" with { type: "json" };

export { expect };

/** The wall clock every `ui` test runs under — relative timestamps
 *  ("2 days ago") are computed against this, never against now. */
export const NOW = new Date("2026-08-21T12:00:00Z");

/** The agents' proposal shape, as `GET /api/proposals` reports it
 *  (mirrors ui/components/proposals.tsx). */
export interface Proposal {
  id: string;
  session: { term: string; key: string };
  repo: string;
  number: number | undefined;
  summary: string;
  payload:
    | {
        kind: "review";
        number: number;
        verdict: "approve" | "request_changes" | "comment";
        body: string;
        comments: Array<{
          path: string;
          line: number;
          start_line?: number;
          body: string;
        }>;
      }
    | { kind: "comment"; number: number; body: string }
    | { kind: "merge"; number: number; method: "merge" | "squash" | "rebase" }
    | {
        kind: "pull_request";
        title: string;
        body: string;
        head: string;
        base: string;
      };
  at: number;
  status: "pending" | "accepted" | "rejected" | "failed";
  resolvedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  reason: string | undefined;
}

export const REPO = "alchemy-run/test-alchemy";

type PullRequestView = typeof pr148;

/** A directory row as `GET /api/chats` reports it. */
export interface ChatRow {
  id: string;
  term: string;
  key: string;
  status: "idle" | "running" | "settled" | "error";
  ticks: number;
  createdAt: number;
  updatedAt: number;
}

interface BoardPull {
  number: number;
  title: string;
  state: string;
  updatedAt: number;
  session?: { id: string; status: ChatRow["status"] };
}

/**
 * The FAKE BACKEND — a tiny in-memory model of the org Worker's HTTP
 * surface, answered from `page.route`. Mutable so tests can seed a
 * scenario (existing sessions, a bot review in flight, the bot offline)
 * and then assert on what the UI did to it (which keys it opened,
 * which PRs it pulled onto the machine).
 */
export class FakeApi {
  chats: ChatRow[] = [];
  prs: Record<number, PullRequestView> = { 148: pr148, 147: pr147 };
  board: { repo: string; prs: BoardPull[] } = {
    repo: REPO,
    prs: [
      { number: 148, title: pr148.title, state: "open", updatedAt: 0 },
      { number: 147, title: pr147.title, state: "open", updatedAt: 0 },
    ],
  };
  /** `POST /api/prs/:n/review` answers 503 while the bot is offline. */
  reviewBotOnline = false;
  /** Every `POST /api/prs/:n/checkout`, in order. */
  checkouts: number[] = [];
  /** Every `POST /api/chats/:id` (session/thread opened), in order. */
  opened: string[] = [];
  /** Every `DELETE /api/chats/:id`, in order. */
  deleted: string[] = [];
  /** Every `POST /api/prs/:n/review`, in order. */
  reviewsRequested: number[] = [];
  /** The agents' PROPOSALS (src/services/Proposals.ts) — seed pending
   *  ones to exercise the inbox; `accept`/`reject` resolve them here
   *  exactly as the Worker would (an accept "lands" at a fake URL). */
  proposals: Proposal[] = [];
  /** Every `POST /api/proposals/:id/{accept,reject}`, in order. */
  resolved: Array<{ id: string; verb: "accept" | "reject"; reason?: string }> =
    [];

  seedChat(id: string, status: ChatRow["status"] = "idle"): ChatRow {
    const at = id.indexOf(":");
    const row: ChatRow = {
      id,
      term: id.slice(0, at),
      key: id.slice(at + 1),
      status,
      ticks: 0,
      createdAt: NOW.getTime() - 60_000,
      updatedAt: NOW.getTime() - 60_000,
    };
    this.chats = [...this.chats.filter((c) => c.id !== id), row];
    return row;
  }

  /** A pending proposal from the bot's review session on PR `number`. */
  seedProposal(
    number: number,
    payload: Proposal["payload"],
    summary: string,
  ): Proposal {
    const row: Proposal = {
      id: `proposal-${this.proposals.length + 1}`,
      session: { term: "ReviewBot", key: `${REPO}#${number}` },
      repo: REPO,
      number: payload.kind === "pull_request" ? undefined : payload.number,
      summary,
      payload,
      at: NOW.getTime() - 30_000,
      status: "pending",
      resolvedAt: undefined,
      result: undefined,
      error: undefined,
      reason: undefined,
    };
    this.proposals = [row, ...this.proposals];
    return row;
  }

  async install(page: Page): Promise<void> {
    await page.route("**/api/**", (route) => this.handle(route));
    // nothing in the `ui` project leaves the machine: avatars, the
    // GitHub hover-card lookups, anything else on the public internet
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) =>
      route.abort(),
    );
    // the chat socket: replays the seeded transcript on `subscribe`,
    // then goes quiet (no agent behind it)
    await page.routeWebSocket(/\/attach\//, (ws) => this.attachChat(ws));
    // the terminal socket: a scripted "machine" — see `FakeTerminal`
    await page.routeWebSocket(/\/terminal\//, (ws) =>
      this.terminal.attach(ws.url(), ws),
    );
  }

  readonly terminal = new FakeTerminal();

  /** Durable observations per chat id, in seq order — what the socket
   *  replays when the transcript view subscribes. */
  transcripts: Record<string, unknown[]> = {};

  private attachChat(ws: WebSocketRoute) {
    const path = decodeURIComponent(new URL(ws.url()).pathname);
    // /attach/<term>/<key…>
    const [, , term, ...rest] = path.split("/");
    const id = `${term}:${rest.join("/")}`;
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as { type: string };
      if (frame.type !== "subscribe") return;
      const rows = this.transcripts[id] ?? [];
      for (const observation of rows) {
        ws.send(JSON.stringify({ type: "observation", durable: true, observation }));
      }
      ws.send(JSON.stringify({ type: "live", seq: rows.length }));
    });
  }

  /**
   * One finished turn in chat `id`: the user asks, the agent runs
   * `command` through `bash`, and answers `reply`. `stdout` may carry
   * ANSI escapes — the point of seeding it.
   */
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
    this.seedChat(id);
    const at = id.indexOf(":");
    const envelope = (seq: number) => ({
      term: id.slice(0, at),
      key: id.slice(at + 1),
      seq,
      at: NOW.getTime() - 60_000 + seq * 1000,
    });
    const callId = `call-${(this.transcripts[id]?.length ?? 0) + 1}`;
    const output =
      `exit: ${turn.exit ?? 0}\n--- stdout ---\n${turn.stdout || "(no output)"}` +
      `\n--- stderr ---\n${turn.stderr || "(no output)"}`;
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
        toolCalls: [{ id: callId, name: "bash", input: { command: turn.command } }],
      },
      {
        ...envelope(seq + 2),
        type: "tool-result",
        toolCallId: callId,
        toolName: "bash",
        output,
        isFailure: false,
      },
      { ...envelope(seq + 3), type: "assistant", tick: 1, ms: 600, text: turn.reply, toolCalls: [] },
    ];
  }

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

    if (path === "/api/repos") {
      return this.json(route, [{ name: REPO, sessions: true, reviews: true }]);
    }
    if (path === "/api/board/stream") {
      // no SSE from the fake — the UI falls back to polling /api/board
      return route.abort();
    }
    if (path === "/api/board") return this.json(route, this.board);
    if (path === "/api/proposals") {
      const status = url.searchParams.get("status");
      const number = url.searchParams.get("number");
      return this.json(
        route,
        this.proposals.filter(
          (row) =>
            (status === null || row.status === status) &&
            (number === null || row.number === Number(number)),
        ),
      );
    }
    const proposal = path.match(/^\/api\/proposals\/([^/]+)\/(accept|reject)$/);
    if (proposal !== null && method === "POST") {
      const id = decodeURIComponent(proposal[1]!);
      const verb = proposal[2] as "accept" | "reject";
      const body = (request.postDataJSON() ?? {}) as { reason?: string };
      const row = this.proposals.find((entry) => entry.id === id);
      if (row === undefined) {
        return this.json(route, { error: "unknown proposal" }, 404);
      }
      this.resolved.push({ id, verb, ...(body.reason ? { reason: body.reason } : {}) });
      const next: Proposal =
        verb === "accept"
          ? {
              ...row,
              status: "accepted",
              resolvedAt: NOW.getTime(),
              result: `https://github.com/${row.repo}/pull/${row.number ?? 149}`,
            }
          : { ...row, status: "rejected", resolvedAt: NOW.getTime(), reason: body.reason };
      this.proposals = this.proposals.map((entry) =>
        entry.id === id ? next : entry,
      );
      return this.json(route, next);
    }

    if (path === "/api/chats" && method === "GET") {
      return this.json(route, this.chats);
    }
    const chat = path.match(
      /^\/api\/chats\/([^/]+)(\/(messages|log|stop|resume))?$/,
    );
    if (chat !== null) {
      const id = decodeURIComponent(chat[1]!);
      const sub = chat[3];
      if (sub === "messages" || sub === "log") {
        return this.json(route, { error: "transcripts ride the socket" }, 404);
      }
      if (sub === "stop" || sub === "resume") {
        this.chats = this.chats.map((row) =>
          row.id === id
            ? { ...row, status: sub === "stop" ? "settled" : "running" }
            : row,
        );
        return this.json(route, {});
      }
      if (method === "POST") {
        this.opened.push(id);
        if (!this.chats.some((row) => row.id === id)) this.seedChat(id);
        return this.json(route, {});
      }
      if (method === "DELETE") {
        this.deleted.push(id);
        this.chats = this.chats.filter((row) => row.id !== id);
        return this.json(route, {});
      }
    }

    const pull = path.match(/^\/api\/prs\/(\d+)(\/(checkout|review))?$/);
    if (pull !== null) {
      const number = Number(pull[1]);
      const view = this.prs[number];
      if (view === undefined) {
        return this.json(route, { error: `no pull request #${number}` }, 404);
      }
      if (pull[3] === undefined) return this.json(route, view);
      if (pull[3] === "checkout") {
        this.checkouts.push(number);
        return this.json(route, {
          key: `${REPO}#${number}`,
          branch: view.checkoutRef,
          root: "/workspace",
          ref: view.checkoutRef,
          headSha: view.head.sha,
        });
      }
      this.reviewsRequested.push(number);
      if (!this.reviewBotOnline) {
        return this.json(route, { error: "review bot is not deployed" }, 503);
      }
      const id = `ReviewBot:${REPO}#${number}`;
      this.seedChat(id, "running");
      this.board = {
        ...this.board,
        prs: this.board.prs.map((row) =>
          row.number === number
            ? { ...row, session: { id, status: "running" } }
            : row,
        ),
      };
      return this.json(route, {});
    }

    return this.json(route, { error: `unhandled ${method} ${path}` }, 404);
  }
}

type WebSocketRoute = Parameters<Parameters<Page["routeWebSocket"]>[1]>[0];

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

  attach(url: string, ws: WebSocketRoute) {
    const ptyId = new URL(url).searchParams.get("id") ?? "?";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    ws.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message) as { t: string };
        if (frame.t === "open") {
          this.opened.push(ptyId);
          ws.send(
            JSON.stringify({ t: "status", message: "resuming the machine" }),
          );
          ws.send(Buffer.from(encoder.encode("fake-machine:~$ ")));
        }
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

/** Load the app fresh — empty layout memory, `hash` as the route. */
export const openApp = async (page: Page, hash = "") => {
  await page.goto(`/${hash}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/${hash}`, { waitUntil: "networkidle" });
};

export const sidebar = (page: Page) => page.getByRole("complementary");
export const main = (page: Page) => page.getByRole("main");

/** The strip of tabs above the session's views. */
export const tabStrip = (page: Page) =>
  page.getByRole("tablist", { name: "Session tabs" });

export const tab = (page: Page, name: string | RegExp) =>
  tabStrip(page).getByRole("tab", { name });

export const encodeHash = (id: string) => `#${encodeURIComponent(id)}`;

/** Matches a page URL whose hash routes to `id`. */
export const routedTo = (id: string) =>
  new RegExp(`${encodeHash(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
