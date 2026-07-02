import type { UIFact, UIRegistry } from "alchemy/UI/UIProvider";
import { ExternalLink, X } from "lucide-react";
import { toCtx } from "../registry.ts";
import {
  CLOUD_COLORS,
  cloudOf,
  PLAN_COLORS,
  PLAN_LABELS,
  statusColor,
} from "../theme.ts";
import type { DashboardMeta, DashboardNode } from "../types.ts";
import { ResourceIcon } from "./Icon.tsx";

export function Inspector({
  node,
  registry,
  meta,
  onClose,
}: {
  node: DashboardNode;
  registry: UIRegistry;
  meta: DashboardMeta;
  onClose: () => void;
}) {
  const ui = registry.get(node.type);
  const ctx = toCtx(node, meta);
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? "#8b8b96";
  const facts = safe(() => ui?.facts?.(ctx)) ?? [];
  const link = safe(() => ui?.link?.(ctx));
  const consoleUrl = safe(() => ui?.consoleUrl?.(ctx));
  const Details = ui?.Details;

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col overflow-y-auto border-l border-[#26262f] bg-[#101016]">
      <div className="flex items-start gap-2.5 border-b border-[#26262f] p-4">
        <div className="mt-0.5">
          <ResourceIcon ui={ui} color={color} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-zinc-100">
            {node.logicalId}
          </h2>
          <p className="truncate text-[11px] text-zinc-500">{node.type}</p>
          {node.path.length > 0 && (
            <p className="truncate text-[11px] text-zinc-600">
              {node.path.join(" / ")}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {node.planAction && (
          <div
            className="rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: `${PLAN_COLORS[node.planAction]}55`,
              background: `${PLAN_COLORS[node.planAction]}14`,
              color: PLAN_COLORS[node.planAction],
            }}
          >
            Next deploy: {PLAN_LABELS[node.planAction] ?? node.planAction}
            {node.status === "pending" &&
              " — not deployed yet, defined in the stack file"}
            {node.planAction === "delete" &&
              node.status !== "pending" &&
              " — no longer in the stack file (orphaned)"}
          </div>
        )}
        <section className="space-y-1.5">
          <Fact
            fact={{ label: "status", value: node.status }}
            valueColor={statusColor(node.status)}
          />
          <Fact fact={{ label: "fqn", value: node.fqn, mono: true }} />
          {facts
            .filter((f) => f.value !== undefined)
            .map((f, i) => (
              <Fact key={i} fact={f} />
            ))}
        </section>

        {(link || consoleUrl) && (
          <section className="space-y-1.5">
            {link && <LinkRow href={link} label={link} />}
            {consoleUrl && (
              <LinkRow
                href={consoleUrl}
                label={`Open in ${cloudOf(node.type)} console`}
              />
            )}
          </section>
        )}

        {Details && (
          <section>
            <Details ctx={ctx} />
          </section>
        )}

        {node.bindings.length > 0 && (
          <section>
            <SectionTitle>Bindings</SectionTitle>
            <div className="space-y-1.5">
              {node.bindings.map((b, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-[#26262f] px-2.5 py-1.5"
                >
                  <div className="text-[12px] text-zinc-300">{b.sid}</div>
                  <JsonBlock value={b.data} />
                </div>
              ))}
            </div>
          </section>
        )}

        {node.attrs && Object.keys(node.attrs).length > 0 && (
          <section>
            <SectionTitle>Attributes</SectionTitle>
            <JsonBlock value={node.attrs} open />
          </section>
        )}

        {node.props && Object.keys(node.props).length > 0 && (
          <section>
            <SectionTitle>Properties</SectionTitle>
            <JsonBlock value={node.props} />
          </section>
        )}
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </h3>
  );
}

function Fact({ fact, valueColor }: { fact: UIFact; valueColor?: string }) {
  const value = String(fact.value ?? "");
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-zinc-500">{fact.label}</span>
      {fact.href ? (
        <a
          href={fact.href}
          target="_blank"
          rel="noreferrer"
          className="truncate text-indigo-400 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span
          className={`truncate text-zinc-200 ${fact.mono ? "font-mono text-[11px]" : ""}`}
          style={valueColor ? { color: valueColor } : undefined}
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function LinkRow({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 truncate text-[12px] text-indigo-400 hover:underline"
    >
      <ExternalLink size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function JsonBlock({ value, open }: { value: unknown; open?: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer text-[11px] text-zinc-600 hover:text-zinc-400">
        json
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-[#0b0b10] p-2 text-[10.5px] leading-relaxed text-zinc-400">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

const safe = <T,>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
