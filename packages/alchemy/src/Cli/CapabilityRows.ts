import { reach, type Permission, type Term } from "../CapabilityGraph.ts";

/** One line of a runtime's terms, as a plan draws them. */
export interface CapabilityRow {
  /**
   * `Term` heads a term: a process, a tool, a policy. Under it, `Reaches`
   * sums up every binding a process reaches, `Reference` points at a term
   * defined elsewhere, and `Binding` is a binding the term may use itself.
   */
  readonly kind: "Term" | "Reaches" | "Reference" | "Binding";
  /** Indentation below the first row of its group. */
  readonly depth: number;
  readonly label: string;
  /** A term's kind, a reference's relation, or what a binding is bound to and reached through. */
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

/** Terms that are defined by the model they belong to, and only pointed at here. */
const isPiece = (term: Term) => term.kind === "Domain";

/**
 * A runtime's terms as a plan draws them, by what hosts them. Every term is
 * drawn once: a process first, with the bindings it reaches and a reference
 * to each term it uses, then the tools, policies and other terms, each with
 * the bindings it may use itself.
 */
export const capabilityGroups = (terms: ReadonlyArray<Term>): ReadonlyArray<CapabilityGroup> => {
  const byId = new Map(terms.map((term) => [term.id, term]));
  const groups = new Map<string | undefined, Array<CapabilityRow>>();
  const drawn = [
    ...terms.filter((term) => term.kind === "Process"),
    ...terms.filter((term) => term.kind !== "Process" && !isPiece(term)),
  ];
  for (const term of drawn) {
    let rows = groups.get(term.host);
    if (rows === undefined) groups.set(term.host, (rows = []));
    rows.push({ kind: "Term", depth: 0, label: term.name, detail: term.kind, key: term.id });
    if (term.kind === "Process") {
      const reached = [...new Set(reach(terms, term.id).map((each) => each.binding))].sort();
      if (reached.length > 0) {
        rows.push({
          kind: "Reaches",
          depth: 1,
          label: reached.join(", "),
          key: `${term.id}>reaches`,
        });
      }
    }
    for (const reference of term.references) {
      const to = byId.get(reference.to);
      if (to === undefined) continue;
      rows.push({
        kind: "Reference",
        depth: 1,
        label: isPiece(to) ? to.name : `${to.kind} ${to.name}`,
        ...(reference.relation === "uses" ? {} : { detail: reference.relation }),
        key: `${term.id}>${reference.relation}|${to.id}`,
      });
    }
    for (const permission of term.bindings) {
      rows.push({
        kind: "Binding",
        depth: 1,
        label: permission.binding,
        detail: [
          permission.targets.join(", "),
          permission.via.length === 0 ? "" : `via ${permission.via.join(" > ")}`,
        ]
          .filter((part) => part !== "")
          .join(" "),
        key: `${term.id}>${rowOf(permission)}`,
      });
    }
  }
  return [...groups].map(([host, rows]) => ({ host, rows }));
};
