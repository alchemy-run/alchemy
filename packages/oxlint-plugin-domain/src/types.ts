/**
 * The small part of the oxlint JS plugin API these rules use. oxlint does not
 * export its `Rule` / `Context` types, so the plugin declares the shape it
 * relies on.
 */

/** An ESTree node, as oxlint hands it to a visitor. */
export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly parent?: Node;
  // ESTree nodes carry many kind-specific fields.
  readonly [key: string]: any;
}

export interface Diagnostic {
  readonly node: Node;
  readonly messageId: string;
  readonly data?: Record<string, string | number>;
}

export interface Context {
  readonly id: string;
  readonly filename: string;
  readonly physicalFilename: string;
  readonly cwd: string;
  readonly options: ReadonlyArray<unknown>;
  readonly sourceCode: { readonly text: string };
  report(diagnostic: Diagnostic): void;
}

export type Visitor = Record<string, (node: Node) => void>;

export interface Rule {
  readonly meta: {
    readonly type: "problem" | "suggestion" | "layout";
    readonly docs: { readonly description: string; readonly url?: string };
    readonly messages: Record<string, string>;
    readonly schema?: ReadonlyArray<unknown>;
  };
  create(context: Context): Visitor;
}
