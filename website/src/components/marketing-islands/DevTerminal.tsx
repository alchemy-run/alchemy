import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

interface Resource {
  id: string;
  type: string;
  bindings: string[];
}
const DEV_INITIAL: Resource[] = [
  { id: "Bucket", type: "Cloudflare.R2Bucket", bindings: [] },
  { id: "KV", type: "Cloudflare.KVNamespace", bindings: [] },
  { id: "Api", type: "Cloudflare.Worker", bindings: ["Bucket", "KV"] },
];

type Status = "detected" | "starting" | "reloading" | "ready";
interface Row extends Resource {
  status: Status;
  lastMs?: number;
  isNew?: boolean;
}

interface Event {
  kind: "info" | "change" | "reload" | "rebind" | "ready";
  text: string;
}

export default function DevTerminal({ title = "~/my-app" }: { title?: string }) {
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);

  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const typeCmd = async (text: string) => {
      setCmd(""); setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(36 + Math.random() * 24);
      }
      await sleep(180);
      setCaret(false);
    };

    const updateRow = (id: string, patch: Partial<Row>) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    const pushEvent = (ev: Event) =>
      setEvents((es) => {
        const next = [...es, ev];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

    const startResource = async (id: string, status: Status, ms: number) => {
      if (aborted()) return;
      updateRow(id, { status });
      await sleep(ms);
      if (aborted()) return;
      updateRow(id, { status: "ready", lastMs: ms });
    };

    const run = async () => {
      while (!aborted()) {
        setRows([]); setUrl(null); setEvents([]);
        await typeCmd("alchemy dev");
        if (aborted()) return;
        await sleep(360);

        for (const r of DEV_INITIAL) {
          if (aborted()) return;
          setRows((rs) => [...rs, { ...r, status: "detected" }]);
          await sleep(160);
        }
        await sleep(220);
        if (aborted()) return;

        await Promise.all([
          startResource("Bucket", "starting", 700),
          (async () => { await sleep(140); await startResource("KV", "starting", 620); })(),
          (async () => { await sleep(320); await startResource("Api", "starting", 950); })(),
        ]);
        if (aborted()) return;

        setUrl("http://localhost:1337");
        pushEvent({ kind: "ready", text: "ready in 1.2s · watching for changes" });
        await sleep(1800);

        if (aborted()) return;
        pushEvent({ kind: "change", text: "~ src/Api.ts changed" });
        updateRow("Api", { status: "reloading" });
        await sleep(620);
        if (aborted()) return;
        updateRow("Api", { status: "ready", lastMs: 84 });
        pushEvent({ kind: "reload", text: "↻ Api hot-reloaded in 84ms" });
        await sleep(1700);

        if (aborted()) return;
        pushEvent({ kind: "change", text: "+ src/Queue.ts added" });
        await sleep(280);
        setRows((rs) => [
          ...rs,
          { id: "Queue", type: "Cloudflare.Queue", bindings: [], status: "detected", isNew: true },
        ]);
        await sleep(280);
        if (aborted()) return;
        await startResource("Queue", "starting", 720);
        if (aborted()) return;

        updateRow("Api", { bindings: ["Bucket", "KV", "Queue"], status: "reloading" });
        pushEvent({ kind: "rebind", text: "↻ Api rebinding (+1 binding)" });
        await sleep(620);
        if (aborted()) return;
        updateRow("Api", { status: "ready", lastMs: 92 });
        pushEvent({ kind: "reload", text: "↻ Api hot-reloaded in 92ms" });
        await sleep(2600);
      }
    };

    run();
    return () => { cancelRef.current = true; };
  }, []);

  const anyInFlight = rows.some((r) => r.status === "starting" || r.status === "reloading");
  const spinner = useSpinner(anyInFlight);
  const accent = "var(--alc-accent-bright)";

  const renderRow = (r: Row) => {
    let icon: string, iconColor: string, statusWord: string | null = null, statusColor = "";
    if (r.status === "detected") {
      icon = "+"; iconColor = "var(--alc-success)";
    } else if (r.status === "starting") {
      icon = spinner; iconColor = "var(--alc-success)";
      statusWord = "starting"; statusColor = "var(--alc-success)";
    } else if (r.status === "reloading") {
      icon = spinner; iconColor = "var(--alc-warn)";
      statusWord = "reloading"; statusColor = "var(--alc-warn)";
    } else {
      icon = "✓"; iconColor = accent;
      statusWord = r.lastMs ? `ready · ${r.lastMs}ms` : "ready (local)";
      statusColor = "var(--alc-code-comment)";
    }
    const bcount = r.bindings.length;
    return (
      <Line key={r.id} style={{ transition: "opacity 200ms ease" }}>
        <span style={{ color: iconColor, width: "1.2em", display: "inline-block", transition: "color 200ms ease" }}>{icon}</span>
        <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>{r.id}</span>
        <span style={{ color: "var(--alc-code-comment)" }}>{` (${r.type})`}</span>
        {bcount > 0 && (
          <span style={{ color: "var(--alc-code-type)" }}>{` (${bcount} bindings)`}</span>
        )}
        {statusWord && (
          <span style={{ color: statusColor, marginLeft: 6, transition: "color 200ms ease" }}>{statusWord}</span>
        )}
        {r.isNew && r.status !== "ready" && (
          <span style={{ color: "var(--alc-success)", marginLeft: 6, fontStyle: "italic" }}>new</span>
        )}
      </Line>
    );
  };

  const renderEvent = (e: Event, i: number) => {
    const colorByKind: Record<Event["kind"], string> = {
      info: "var(--alc-code-comment)",
      change: "var(--alc-warn)",
      reload: "var(--alc-accent-bright)",
      rebind: "var(--alc-warn)",
      ready: "var(--alc-accent-bright)",
    };
    return (
      <Line key={`${i}-${e.text}`}>
        <span style={{ color: colorByKind[e.kind] }}>{e.text}</span>
      </Line>
    );
  };

  return (
    <TermChrome title={title} badge="DEV" badgeColor={accent} bodyMinHeight={332}>
      <Line>
        <span style={{ color: accent }}>$ </span>
        {cmd}
        {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
      </Line>
      {rows.length > 0 && (
        <>
          <Line> </Line>
          {rows.map(renderRow)}
        </>
      )}
      {url && (
        <>
          <Line> </Line>
          <Line>
            <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
            <span style={{ color: accent }}>{url}</span>
          </Line>
        </>
      )}
      {events.length > 0 && (
        <>
          <Line> </Line>
          {events.map(renderEvent)}
        </>
      )}
    </TermChrome>
  );
}
