/**
 * The BOARD's data: the Registry's one `board()` payload — tasks in
 * status columns, groups, the triage tray, entity snapshots, pending
 * approvals — fetched once and kept live over the `/board` WebSocket
 * (every Registry write pushes a fresh snapshot).
 */

import { useEffect, useState } from "react";

export type EntityKind = "issue" | "pull";
export type EntityState = "open" | "closed" | "merged" | "draft";

export interface BoardEntity {
  readonly ref: string;
  readonly kind: EntityKind;
  readonly state: EntityState;
  readonly title: string;
  readonly author?: string;
  readonly labels: ReadonlyArray<string>;
  readonly updatedAt: number;
}

export interface BoardGroup {
  readonly id: string;
  readonly name: string;
  readonly purpose?: string;
  readonly refs: ReadonlyArray<string>;
}

export type TaskStatus =
  | "todo"
  | "dispatched"
  | "in_review"
  | "blocked"
  | "done";

export interface BoardTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly note?: string;
  readonly refs: ReadonlyArray<string>;
  readonly updatedAt: number;
  readonly pendingApprovals: number;
}

export interface BoardApproval {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly threadId?: string;
  readonly taskId?: string;
}

export interface BoardView {
  readonly tasks: ReadonlyArray<BoardTask>;
  readonly groups: ReadonlyArray<BoardGroup>;
  readonly triage: ReadonlyArray<BoardEntity>;
  readonly entities: ReadonlyArray<BoardEntity>;
  readonly approvals: ReadonlyArray<BoardApproval>;
}

export const TASK_COLUMNS: ReadonlyArray<{
  status: TaskStatus;
  label: string;
}> = [
  { status: "todo", label: "To do" },
  { status: "dispatched", label: "Dispatched" },
  { status: "in_review", label: "In review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

/** Move a task on the board (the drag's landing). */
export const moveTask = (id: string, status: TaskStatus): Promise<Response> =>
  fetch(`/api/board/tasks/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });

/** The board, fetched then LIVE: the socket pushes a snapshot after
 *  every Registry write; a dropped socket retries with backoff. */
export const useBoard = (): BoardView | undefined => {
  const [board, setBoard] = useState<BoardView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;

    void fetch("/api/board")
      .then(async (response) =>
        response.ok ? ((await response.json()) as BoardView) : undefined,
      )
      .then((view) => {
        if (live && view !== undefined) setBoard(view);
      })
      .catch(() => {});

    const connect = () => {
      if (!live) return;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/board/live`);
      socket.onopen = () => {
        backoff = 1000;
        // any message asks for a snapshot — the subscribe ping
        socket?.send(JSON.stringify({ type: "subscribe" }));
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as {
            type: string;
            board?: BoardView;
          };
          if (frame.type === "board" && frame.board !== undefined) {
            setBoard(frame.board);
          }
        } catch {
          // a malformed frame is dropped; the next write pushes again
        }
      };
      socket.onclose = () => {
        if (!live) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
    };
    connect();

    return () => {
      live = false;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    };
  }, []);
  return board;
};
