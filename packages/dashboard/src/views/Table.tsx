import type { TableRowView } from "alchemy/Dashboard/Projections";
import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { formatDuration } from "../format.ts";
import { setSelectedFqn, useProjection } from "../store.ts";
import {
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  statusColor,
} from "../theme.ts";

type SortKey = "fqn" | "type" | "status" | "plan" | "result" | "wait" | "run";

interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: "fqn", label: "Resource" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "plan", label: "Plan" },
  { key: "result", label: "Result" },
  { key: "wait", label: "Wait" },
  { key: "run", label: "Run" },
];

const fieldOf = (
  row: TableRowView,
  key: SortKey,
): string | number | undefined => {
  switch (key) {
    case "fqn":
      return row.fqn;
    case "type":
      return row.type;
    case "status":
      return row.status;
    case "plan":
      return row.planAction;
    case "result":
      return row.applyResult;
    case "wait":
      return row.waitMs;
    case "run":
      return row.runMs;
  }
};

const compareRows =
  (sort: Sort) =>
  (a: TableRowView, b: TableRowView): number => {
    const av = fieldOf(a, sort.key);
    const bv = fieldOf(b, sort.key);
    // undefined always sorts last, regardless of direction
    if (av === undefined && bv === undefined) {
      return a.fqn.localeCompare(b.fqn);
    }
    if (av === undefined) {
      return 1;
    }
    if (bv === undefined) {
      return -1;
    }
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return cmp !== 0 ? cmp * sort.dir : a.fqn.localeCompare(b.fqn);
  };

/**
 * The Table view: one sortable row per known fqn with plan/result and the
 * Buildkite-style wait/run timings from op spans. Sorting is view-local
 * component state; rows are memoized so a sort flip reuses them.
 */
export const TableView = memo(function TableView() {
  const rows = useProjection("table");
  const [sort, setSort] = useState<Sort>({ key: "fqn", dir: 1 });

  const sorted = useMemo(() => [...rows].sort(compareRows(sort)), [rows, sort]);

  const toggle = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );

  if (rows.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-zinc-600">
        This stack defines no resources
      </p>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-left text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-[#0b0b10] text-[11px] uppercase tracking-wider text-zinc-600">
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key} className="px-4 py-2 font-medium">
                <button
                  onClick={() => toggle(column.key)}
                  className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-zinc-300"
                >
                  {column.label}
                  {sort.key === column.key &&
                    (sort.dir === 1 ? (
                      <ChevronUp size={11} />
                    ) : (
                      <ChevronDown size={11} />
                    ))}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <TableRow key={row.fqn} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
});

const TableRow = memo(function TableRow({ row }: { row: TableRowView }) {
  return (
    <tr
      onClick={() => setSelectedFqn(row.fqn)}
      className="cursor-pointer border-t border-[#1c1c24] hover:bg-[#15151c]"
    >
      <td className="max-w-72 truncate px-4 py-2 font-mono text-[11.5px] text-zinc-200">
        {row.fqn}
      </td>
      <td className="px-4 py-2 text-zinc-500">{row.type ?? ""}</td>
      <td className="px-4 py-2">
        <span
          className="inline-flex items-center gap-1.5"
          style={{ color: statusColor(row.status) }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: statusColor(row.status) }}
          />
          {row.status}
        </span>
      </td>
      <td className="px-4 py-2">
        {row.planAction && (
          <span
            className="rounded px-1.5 py-px text-[11px] font-medium"
            style={{
              color: PLAN_COLORS[row.planAction],
              background: `${PLAN_COLORS[row.planAction]}1f`,
            }}
          >
            {PLAN_LABELS[row.planAction] ?? row.planAction}
          </span>
        )}
      </td>
      <td className="px-4 py-2">
        {row.applyResult && (
          <span
            className="rounded px-1.5 py-px text-[11px] font-medium"
            style={{
              color: "#0b0b10",
              background: RESULT_COLORS[row.applyResult],
            }}
          >
            {RESULT_LABELS[row.applyResult] ?? row.applyResult}
          </span>
        )}
      </td>
      <td className="px-4 py-2 font-mono text-[11px] text-zinc-500">
        {row.waitMs !== undefined ? formatDuration(row.waitMs) : ""}
      </td>
      <td className="px-4 py-2 font-mono text-[11px] text-zinc-400">
        {row.runMs !== undefined ? formatDuration(row.runMs) : ""}
      </td>
    </tr>
  );
});
