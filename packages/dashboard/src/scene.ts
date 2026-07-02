import { useEffect, useRef, useState } from "react";
import type { Scene } from "./types.ts";

/**
 * The dashboard's single data source: the server assembles the canonical
 * scene (state + plan + live apply session, joined server-side) and
 * streams it over SSE as full snapshots. This hook renders whatever the
 * latest scene says — no client-side merging.
 *
 * For a non-default stage the scene is fetched once on switch; SSE frames
 * for other stages are ignored (`scene.stage` tags every frame).
 */
export function useScene(stageOverride: string | undefined): {
  scene: Scene | undefined;
  error: string | undefined;
  decide: (id: string, approved: boolean) => void;
} {
  const [scene, setScene] = useState<Scene>();
  const [error, setError] = useState<string>();
  const stageRef = useRef(stageOverride);
  stageRef.current = stageOverride;

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (message) => {
      const msg = JSON.parse(message.data) as { kind: string; scene: Scene };
      if (msg.kind !== "scene") {
        return;
      }
      // accept frames for the stage we're looking at (no override = the
      // server's stage, which is what the stream carries by default)
      if (
        stageRef.current === undefined ||
        msg.scene.stage === stageRef.current
      ) {
        setScene((prev) =>
          prev === undefined || msg.scene.revision >= prev.revision
            ? msg.scene
            : prev,
        );
        setError(undefined);
      }
    };
    return () => source.close();
  }, []);

  // stage switch: fetch that stage's scene directly (retry — the serving
  // process can stall transiently while a deploy runs inside it)
  useEffect(() => {
    if (stageOverride === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(
            `/api/scene?stage=${encodeURIComponent(stageOverride)}`,
          );
          if (!res.ok) {
            throw new Error(`/api/scene -> ${res.status}`);
          }
          const next = (await res.json()) as Scene;
          if (!cancelled && stageRef.current === stageOverride) {
            setScene(next);
            setError(undefined);
          }
          return;
        } catch (e) {
          if (attempt === 3 && !cancelled) {
            setError(String(e));
          }
          await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stageOverride]);

  const decide = (id: string, approved: boolean) => {
    void fetch("/api/approval/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, approved }),
    }).catch(() => undefined);
  };

  return { scene, error, decide };
}
