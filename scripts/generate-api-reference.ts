import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  type SourceFile,
  type JSDoc,
  type PropertySignature,
} from "ts-morph";

// ── Configuration ──────────────────────────────────────────────────────────

const config = {
  srcRoot: path.join(import.meta.dir, "../alchemy-effect/src"),
  outRoot: path.join(import.meta.dir, "../alchemy-effect/docs"),
  tsConfig: path.join(import.meta.dir, "../alchemy-effect/tsconfig.json"),

  includeDirs: ["AWS", "Cloudflare"],

  excludeFile(baseName: string): boolean {
    if (baseName === "index.ts") return true;
    if (/^[a-z]/.test(baseName)) return true;
    return false;
  },
};

// ── Types ──────────────────────────────────────────────────────────────────

interface FileEntry {
  relativePath: string;
  absolutePath: string;
  outputPath: string;
}

interface PropertyDoc {
  name: string;
  type: string;
  optional: boolean;
  description: string;
  defaultValue: string | undefined;
}

interface ExampleBlock {
  title: string;
  body: string;
}

interface ExampleSection {
  title: string;
  examples: ExampleBlock[];
}

interface ReferenceSection {
  heading: string;
  summary?: string;
  properties: PropertyDoc[];
}

interface PageDoc {
  title: string;
  relativePath: string;
  summary: string;
  sections: ExampleSection[];
  reference: ReferenceSection[];
}

// ── Discovery ──────────────────────────────────────────────────────────────

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  for (const dir of config.includeDirs) {
    const dirPath = path.join(config.srcRoot, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      const baseName = path.basename(file);
      if (!baseName.endsWith(".ts") && !baseName.endsWith(".tsx")) continue;
      if (baseName.endsWith(".d.ts")) continue;
      if (config.excludeFile(baseName)) continue;

      const relativePath = path.join(dir, file);
      entries.push({
        relativePath,
        absolutePath: path.join(config.srcRoot, relativePath),
        outputPath: path.join(
          config.outRoot,
          relativePath.replace(/\.tsx?$/, ".md"),
        ),
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

// ── JSDoc Parsing ──────────────────────────────────────────────────────────

function getJsDocBlocks(node: Node): JSDoc[] {
  const getter = (node as Node & { getJsDocs?: () => JSDoc[] }).getJsDocs;
  return getter ? getter.call(node) : [];
}

function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

interface ParsedJSDoc {
  summary: string;
  defaultValue?: string;
  sections: ExampleSection[];
}

function parseJSDoc(node: Node): ParsedJSDoc {
  const docs = getJsDocBlocks(node);
  if (docs.length === 0)
    return { summary: "", defaultValue: undefined, sections: [] };

  const clean = cleanDocComment(docs.map((d) => d.getText()).join("\n"));
  const lines = clean.split("\n");

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  let defaultValue: string | undefined;
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleBlock | undefined;

  const flushExample = () => {
    if (!currentExample) return;
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = { title: "Examples", examples: [] };
      sections.push(currentSection);
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  for (const line of lines) {
    const tag = line.trimEnd().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = (rest ?? "").trim();
      switch (name) {
        case "default":
          defaultValue = value || undefined;
          break;
        case "section":
          flushExample();
          currentSection = { title: value || "Examples", examples: [] };
          sections.push(currentSection);
          break;
        case "example":
          flushExample();
          currentExample = { title: value || "Example", body: "" };
          break;
      }
      continue;
    }

    if (!sawTag) {
      summaryLines.push(line);
      continue;
    }

    if (currentExample) {
      currentExample.body += `${line}\n`;
    }
  }

  flushExample();

  const summary = summaryLines.join("\n").trim();
  return { summary, defaultValue, sections };
}

// ── Property Extraction ────────────────────────────────────────────────────

function formatType(value: string | undefined): string {
  if (!value) return "unknown";
  return value
    .replace(/\/\*\*[\s\S]*?\*\//g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function propertyToDoc(prop: PropertySignature): PropertyDoc {
  const jsdoc = parseJSDoc(prop);
  return {
    name: prop.getName(),
    type: formatType(
      prop.getTypeNode()?.getText() ?? prop.getType().getText(prop),
    ),
    optional: prop.hasQuestionToken(),
    description: jsdoc.summary.replace(/\n/g, " "),
    defaultValue: jsdoc.defaultValue,
  };
}

function extractPropertiesFromTypeNode(node: Node): PropertyDoc[] {
  if (Node.isTypeLiteral(node)) {
    return node
      .getMembers()
      .filter((m): m is PropertySignature => Node.isPropertySignature(m))
      .map(propertyToDoc);
  }
  if (Node.isIntersectionTypeNode(node)) {
    return node
      .getTypeNodes()
      .flatMap((child) => extractPropertiesFromTypeNode(child));
  }
  if (Node.isUnionTypeNode(node)) {
    return node
      .getTypeNodes()
      .flatMap((child) => extractPropertiesFromTypeNode(child));
  }
  // handle parenthesized types like (A | B) in intersections
  if (node.getKind() === SyntaxKind.ParenthesizedType) {
    return node
      .getChildren()
      .flatMap((child) => extractPropertiesFromTypeNode(child));
  }
  return [];
}

function deduplicateProperties(props: PropertyDoc[]): PropertyDoc[] {
  const result: PropertyDoc[] = [];
  const seen = new Set<string>();
  for (const prop of props) {
    if (seen.has(prop.name)) continue;
    if (prop.type === "undefined") continue;
    seen.add(prop.name);
    result.push(prop);
  }
  return result;
}

// ── File Parsing ───────────────────────────────────────────────────────────

function findPrimaryJSDoc(sourceFile: SourceFile): ParsedJSDoc {
  // 1. Resource / Host const
  for (const decl of sourceFile.getVariableDeclarations()) {
    if (!decl.isExported()) continue;
    const init = decl.getInitializerIfKind(SyntaxKind.CallExpression);
    const expr = init?.getExpression().getText();
    if (expr === "Resource" || expr === "Host") {
      const stmt = decl.getVariableStatement();
      if (stmt) {
        const jsdoc = parseJSDoc(stmt);
        if (jsdoc.summary || jsdoc.sections.length > 0) return jsdoc;
      }
    }
  }

  // 2. Binding.Service / Binding.Policy class
  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue;
    const text = cls.getText();
    if (
      text.includes("extends Binding.Service<") ||
      text.includes("extends Binding.Policy<")
    ) {
      const jsdoc = parseJSDoc(cls);
      if (jsdoc.summary || jsdoc.sections.length > 0) return jsdoc;
    }
  }

  // 3. First exported declaration with examples, then fall back to first with any JSDoc
  let firstWithSummary: ParsedJSDoc | undefined;
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isExportable(stmt) && stmt.isExported()) {
      const jsdoc = parseJSDoc(stmt);
      if (jsdoc.sections.length > 0) return jsdoc;
      if (!firstWithSummary && jsdoc.summary) firstWithSummary = jsdoc;
    }
  }

  return firstWithSummary ?? { summary: "", sections: [] };
}

function processInterface(
  iface: import("ts-morph").InterfaceDeclaration,
): ReferenceSection[] {
  const resourceHeritage = iface
    .getHeritageClauses()
    .flatMap((c) => c.getTypeNodes())
    .find((t) => {
      const expr = t.getExpression().getText();
      return expr === "Resource" || expr === "Host";
    });

  if (resourceHeritage) {
    const result: ReferenceSection[] = [];
    const typeArgs = resourceHeritage.getTypeArguments();

    const attrsNode = typeArgs[2];
    if (attrsNode) {
      const props = deduplicateProperties(
        extractPropertiesFromTypeNode(attrsNode),
      );
      if (props.length > 0) {
        result.push({ heading: "Attributes", properties: props });
      }
    }

    const bindingNode = typeArgs[3];
    if (bindingNode) {
      const props = deduplicateProperties(
        extractPropertiesFromTypeNode(bindingNode),
      );
      if (props.length > 0) {
        result.push({ heading: "Binding Contract", properties: props });
      }
    }
    return result;
  }

  const props = iface.getProperties().map(propertyToDoc);
  if (props.length > 0) {
    const ifaceJsdoc = parseJSDoc(iface);
    return [
      {
        heading: iface.getName(),
        summary: ifaceJsdoc.summary || undefined,
        properties: props,
      },
    ];
  }
  return [];
}

function processTypeAlias(
  typeAlias: import("ts-morph").TypeAliasDeclaration,
): ReferenceSection[] {
  const typeNode = typeAlias.getTypeNode();
  if (!typeNode) return [];

  const props = deduplicateProperties(
    extractPropertiesFromTypeNode(typeNode),
  );
  if (props.length > 0) {
    const typeJsdoc = parseJSDoc(typeAlias);
    return [
      {
        heading: typeAlias.getName(),
        summary: typeJsdoc.summary || undefined,
        properties: props,
      },
    ];
  }
  return [];
}

function extractReferenceSections(
  sourceFile: SourceFile,
): ReferenceSection[] {
  const sections: ReferenceSection[] = [];

  for (const stmt of sourceFile.getStatements()) {
    if (Node.isInterfaceDeclaration(stmt) && stmt.isExported()) {
      sections.push(...processInterface(stmt));
    } else if (Node.isTypeAliasDeclaration(stmt) && stmt.isExported()) {
      sections.push(...processTypeAlias(stmt));
    }
  }

  return sections;
}

function parseFile(sourceFile: SourceFile, relativePath: string): PageDoc {
  const baseName = path.basename(relativePath, path.extname(relativePath));
  const dirParts = path
    .dirname(relativePath)
    .split(path.sep)
    .filter((p) => p !== ".");
  const title = [...dirParts, baseName].join(".");

  const primary = findPrimaryJSDoc(sourceFile);
  const reference = extractReferenceSections(sourceFile);

  return {
    title,
    relativePath,
    summary: primary.summary,
    sections: primary.sections,
    reference,
  };
}

// ── Markdown Rendering ─────────────────────────────────────────────────────

function escMd(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function renderPropertyTable(
  properties: PropertyDoc[],
  includeRequired: boolean,
): string {
  if (includeRequired) {
    const rows = properties.map(
      (p) =>
        `| \`${escMd(p.name)}\` | \`${escMd(p.type)}\` | ${p.optional ? "No" : "Yes"} | ${escMd(p.defaultValue ?? "-")} | ${escMd(p.description || "-")} |`,
    );
    return [
      "| Property | Type | Required | Default | Description |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
  }

  const rows = properties.map(
    (p) =>
      `| \`${escMd(p.name)}\` | \`${escMd(p.type)}\` | ${escMd(p.description || "-")} |`,
  );
  return [
    "| Property | Type | Description |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderPage(doc: PageDoc): string {
  const parts: string[] = [];

  parts.push(`# ${doc.title}`);
  if (doc.summary) parts.push(doc.summary);
  parts.push(`**Source:** \`src/${doc.relativePath}\``);

  for (const section of doc.sections) {
    const secParts = [`## ${section.title}`];
    for (const example of section.examples) {
      secParts.push(`### ${example.title}`);
      secParts.push(example.body);
    }
    parts.push(secParts.join("\n\n"));
  }

  for (const section of doc.reference) {
    const secParts: string[] = [`## ${section.heading}`];
    if (section.summary) secParts.push(section.summary);
    const isAttrs = section.heading === "Attributes";
    secParts.push(renderPropertyTable(section.properties, !isAttrs));
    parts.push(secParts.join("\n\n"));
  }

  return parts.join("\n\n") + "\n";
}

// ── Directory Index Generation ─────────────────────────────────────────────

function generateIndexes(
  entries: FileEntry[],
): { outputPath: string; content: string }[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    let dir = path.dirname(entry.outputPath);
    while (dir.startsWith(config.outRoot)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  return [...dirs].sort().map((dir) => {
    const relDir = path.relative(config.outRoot, dir);
    const title =
      relDir === "" ? "API Reference" : relDir.split(path.sep).join(".");

    const childDirs = [...dirs]
      .filter((d) => path.dirname(d) === dir && d !== dir)
      .sort()
      .map((d) => `- [${path.basename(d)}](./${path.basename(d)}/index.md)`);

    const childFiles = entries
      .filter((e) => path.dirname(e.outputPath) === dir)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map(
        (e) =>
          `- [${path.basename(e.outputPath, ".md")}](./${path.basename(e.outputPath)})`,
      );

    const content: string[] = [`# ${title}`];
    if (childDirs.length > 0)
      content.push(["## Directories", "", ...childDirs].join("\n"));
    if (childFiles.length > 0)
      content.push(["## Files", "", ...childFiles].join("\n"));

    return {
      outputPath: path.join(dir, "index.md"),
      content: content.join("\n\n") + "\n",
    };
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const entries = await discoverFiles();
  console.log(`Discovered ${entries.length} source files.`);

  const project = new Project({
    tsConfigFilePath: config.tsConfig,
    skipFileDependencyResolution: true,
  });

  await fs.rm(config.outRoot, { recursive: true, force: true });
  await fs.mkdir(config.outRoot, { recursive: true });

  let written = 0;
  for (const entry of entries) {
    const sourceFile = project.getSourceFile(entry.absolutePath);
    if (!sourceFile) {
      console.warn(`  skipped: ${entry.relativePath}`);
      continue;
    }

    const doc = parseFile(sourceFile, entry.relativePath);
    await fs.mkdir(path.dirname(entry.outputPath), { recursive: true });
    await fs.writeFile(entry.outputPath, renderPage(doc), "utf8");
    written++;
  }

  const indexes = generateIndexes(entries);
  for (const idx of indexes) {
    await fs.mkdir(path.dirname(idx.outputPath), { recursive: true });
    await fs.writeFile(idx.outputPath, idx.content, "utf8");
  }

  console.log(
    `Done. Wrote ${written} doc files and ${indexes.length} index files.`,
  );
}

await main();
