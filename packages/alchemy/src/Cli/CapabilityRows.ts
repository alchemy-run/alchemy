import type { Permission, Term } from "../CapabilityGraph.ts";

/** One line of a runtime's terms, as a plan draws them. */
export interface CapabilityRow {
  /**
   * `Process` and `Tool` head a term. `Reference` points at a term drawn
   * elsewhere or not at all (a piece of a Domain model). `Binding` is a
   * binding the term above may use. `Unused` names the tools no process uses.
   */
  readonly kind: "Process" | "Tool" | "Reference" | "Binding" | "Unused";
  /** Indentation below the first row of its group. */
  readonly depth: number;
  readonly label: string;
  readonly detail?: string;
  /** Unique within the runtime. */
  readonly key: string;
}

/** The rows of what one host runs: a Durable Object, or the runtime itself (`host` undefined). */
export interface CapabilityGroup {
  readonly host: string | undefined;
  readonly rows: ReadonlyArray<CapabilityRow>;
}

const rowOf = (permission: Permission) => `${permission.binding}|${permission.targets.join(",")}`;

/**
 * A runtime's terms as the tree a plan draws, by what hosts them. A process
 * heads a tree: under it, what it refers to of a Domain model, the processes
 * it uses, and its tools with the bindings each may use. A term is drawn
 * under every process that uses it. Tools no process uses are named on one line.
 */
export const capabilityGroups = (terms: ReadonlyArray<Term>): ReadonlyArray<CapabilityGroup> => {
  const byId = new Map(terms.map((term) => [term.id, term]));
  const usedBy = (kinds: ReadonlyArray<string> | undefined) =>
    new Set(
      terms
        .filter((term) => kinds === undefined || kinds.includes(term.kind))
        .flatMap((term) => term.references.map((reference) => reference.to)),
    );
  const processes = terms.filter((term) => term.kind === "Process");
  const used = usedBy(undefined);
  const loose = terms.filter((term) => term.kind === "Tool" && !used.has(term.id));
  // With no process, the tools are what there is to draw.
  const roots =
    processes.length === 0 ? loose : processes.filter((term) => !usedBy(["Process"]).has(term.id));
  const unused = processes.length === 0 ? [] : loose;

  const draw = (
    term: Term,
    depth: number,
    path: ReadonlyArray<string>,
    out: Array<CapabilityRow>,
  ): void => {
    const here = [...path, term.id];
    const key = here.join(">");
    out.push({ kind: term.kind === "Process" ? "Process" : "Tool", depth, label: term.name, key });
    const targets = term.references.flatMap((reference) => {
      const to = byId.get(reference.to);
      return to === undefined ? [] : [{ reference, to }];
    });
    const drawn = (kind: string) =>
      targets.filter(({ to }) => to.kind === kind && !here.includes(to.id));
    // A reference: the term is defined elsewhere, or was drawn on the way here.
    for (const { reference, to } of targets) {
      if (to.kind === "Process" || to.kind === "Tool") {
        if (!here.includes(to.id)) continue;
      }
      out.push({
        kind: "Reference",
        depth: depth + 1,
        label: to.kind === "Process" || to.kind === "Tool" ? `${to.kind} ${to.name}` : to.name,
        ...(reference.relation === "uses" ? {} : { detail: reference.relation }),
        key: `${key}>${reference.relation}|${to.id}`,
      });
    }
    // A binding one of the terms below may use is shown there.
    const below = new Set(
      [...drawn("Process"), ...drawn("Tool")].flatMap(({ to }) => to.bindings.map(rowOf)),
    );
    for (const permission of term.bindings) {
      if (below.has(rowOf(permission))) continue;
      out.push({
        kind: "Binding",
        depth: depth + 1,
        label: permission.binding,
        detail: [
          permission.targets.join(", "),
          permission.via.length === 0 ? "" : `via ${permission.via.join(" > ")}`,
        ]
          .filter((part) => part !== "")
          .join(" "),
        key: `${key}>${rowOf(permission)}`,
      });
    }
    for (const { to } of [...drawn("Process"), ...drawn("Tool")]) draw(to, depth + 1, here, out);
  };

  const groups = new Map<string | undefined, Array<CapabilityRow>>();
  const rowsOf = (host: string | undefined) => {
    let rows = groups.get(host);
    if (rows === undefined) groups.set(host, (rows = []));
    return rows;
  };
  for (const root of roots) draw(root, 0, [], rowsOf(root.host));
  const idle = new Map<string | undefined, Array<string>>();
  for (const term of unused) idle.set(term.host, [...(idle.get(term.host) ?? []), term.name]);
  for (const [host, names] of idle) {
    rowsOf(host).push({
      kind: "Unused",
      depth: 0,
      label: names.join(", "),
      key: `unused>${host ?? ""}`,
    });
  }
  return [...groups].map(([host, rows]) => ({ host, rows }));
};
