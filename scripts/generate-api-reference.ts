import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Node, Project, type SourceFile } from "ts-morph";

const websiteRoot = path.join(import.meta.dir, "../website");

const config = {
  srcRoot: path.join(import.meta.dir, "../packages/alchemy/src"),
  outRoot: path.join(websiteRoot, "src/content/docs/providers"),
  tsConfig: path.join(import.meta.dir, "../packages/alchemy/tsconfig.json"),
};

interface FileEntry {
  relativePath: string;
  absolutePath: string;
}

interface ExampleBlock {
  title: string;
  body: string;
}

interface ExampleSection {
  title: string;
  description: string;
  examples: ExampleBlock[];
}

interface PageDoc {
  title: string;
  relativePath: string;
  summary: string;
  sections: ExampleSection[];
}

const normalizeSlashes = (value: string) => value.split(path.sep).join("/");

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  const topLevelEntries = await fs.readdir(config.srcRoot, {
    withFileTypes: true,
  });
  const dirs = topLevelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const dir of dirs) {
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
      if (baseName === "index.ts") continue;

      const relativePath = path.join(dir, file);
      entries.push({
        relativePath,
        absolutePath: path.join(config.srcRoot, relativePath),
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function getJsDocText(node: Node): string {
  const getter = (node as Node & { getJsDocs?: () => { getText(): string }[] })
    .getJsDocs;
  if (!getter) return "";
  return getter
    .call(node)
    .map((doc) => doc.getText())
    .join("\n");
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
  sections: ExampleSection[];
  hasResourceTag: boolean;
  hasBindingTag: boolean;
  category: string;
  product: string;
}

function parseJSDoc(node: Node): ParsedJSDoc {
  const raw = getJsDocText(node);
  if (!raw) {
    return {
      summary: "",
      sections: [],
      hasResourceTag: false,
      hasBindingTag: false,
      category: "",
      product: "",
    };
  }

  const lines = cleanDocComment(raw).split("\n");

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  let hasResourceTag = false;
  let hasBindingTag = false;
  let category = "";
  let product = "";
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleBlock | undefined;

  let sectionDescLines: string[] = [];
  let collectingSectionDesc = false;
  let insideFence = false;

  const flushExample = () => {
    if (!currentExample) return;
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = { title: "Examples", description: "", examples: [] };
      sections.push(currentSection);
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  const flushSectionDesc = () => {
    if (currentSection && sectionDescLines.length > 0) {
      currentSection.description = sectionDescLines.join("\n").trim();
    }
    sectionDescLines = [];
    collectingSectionDesc = false;
  };

  for (const line of lines) {
    // Track fenced code blocks so an `@`-prefixed line inside an example
    // (e.g. a decorator) is never mistaken for a JSDoc tag.
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
    }

    const tag = insideFence ? null : line.trim().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = (rest ?? "").trim();
      switch (name) {
        case "resource":
          hasResourceTag = true;
          break;
        case "binding":
          hasBindingTag = true;
          break;
        case "category":
        case "group":
          if (value) category = value;
          break;
        case "product":
        case "label":
          if (value) product = value;
          break;
        case "section":
          flushExample();
          flushSectionDesc();
          currentSection = {
            title: value || "Examples",
            description: "",
            examples: [],
          };
          sections.push(currentSection);
          collectingSectionDesc = true;
          break;
        case "example":
          flushSectionDesc();
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
    } else if (collectingSectionDesc) {
      sectionDescLines.push(line);
    }
  }

  flushSectionDesc();
  flushExample();

  return {
    summary: summaryLines.join("\n").trim(),
    sections,
    hasResourceTag,
    hasBindingTag,
    category,
    product,
  };
}

function declName(node: Node): string {
  if (Node.isVariableStatement(node)) {
    return node.getDeclarations()[0]?.getName() ?? "";
  }
  if (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node)
  ) {
    return node.getName() ?? "";
  }
  return "";
}

interface Primary {
  name: string;
  doc: ParsedJSDoc;
  category: string;
  product: string;
}

const hasContent = (doc: ParsedJSDoc) =>
  Boolean(doc.summary) || doc.sections.length > 0;

/**
 * Map a public export name back to its local declaration name when a file
 * re-exports under an alias, e.g. `export { VpcLinkResource as VpcLink }`
 * lets us find the documented `VpcLinkResource` const from the tagged
 * `VpcLink` interface.
 */
function localNameForExport(
  sourceFile: SourceFile,
  publicName: string,
): string | undefined {
  for (const ed of sourceFile.getExportDeclarations()) {
    if (ed.getModuleSpecifier()) continue;
    for (const spec of ed.getNamedExports()) {
      if (spec.getAliasNode()?.getText() === publicName) {
        return spec.getNameNode().getText();
      }
    }
  }
  return undefined;
}

/**
 * The page for a file is owned by the single exported declaration tagged
 * `@resource` or `@binding`, and named after it. Authors sometimes write the
 * docs (summary/@section/@example) on a sibling declaration of the same name
 * (an `interface X` paired with `const X`) or on an internal const that is
 * re-exported under the tagged name (the ApiGateway `XResource as X` pattern).
 * When the tagged declaration itself has no content, pull it from that related
 * declaration so the page isn't dropped as empty.
 */
function findTaggedPrimary(sourceFile: SourceFile): Primary | undefined {
  const candidates: Node[] = [
    ...sourceFile.getVariableStatements().filter((s) => s.isExported()),
    ...sourceFile.getClasses().filter((c) => c.isExported()),
    ...sourceFile.getInterfaces().filter((i) => i.isExported()),
  ];

  for (const node of candidates) {
    const doc = parseJSDoc(node);
    if (!doc.hasResourceTag && !doc.hasBindingTag) continue;
    const name = declName(node);
    if (!name) continue;
    const category = doc.category;
    const product = doc.product;
    if (hasContent(doc)) return { name, doc, category, product };

    // Tagged declaration has no prose — look for the related declaration that
    // carries the docs (same name, or re-exported under this name).
    const localName = localNameForExport(sourceFile, name);
    const related: Node[] = [
      ...sourceFile.getVariableStatements(),
      ...sourceFile.getClasses(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
    ].filter((d) => {
      if (d === node) return false;
      const dn = declName(d);
      return dn === name || (localName !== undefined && dn === localName);
    });

    let best: ParsedJSDoc | undefined;
    for (const d of related) {
      const pd = parseJSDoc(d);
      if (pd.sections.length > 0) {
        best = pd;
        break;
      }
      if (!best && pd.summary) best = pd;
    }
    return { name, doc: best ?? doc, category, product };
  }
  return undefined;
}

function yamlString(value: string): string {
  if (/[\n:"{}[\],&*?|>!%@`#]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function firstParagraph(value: string): string {
  const idx = value.indexOf("\n\n");
  const para = idx === -1 ? value : value.slice(0, idx);
  return para.replace(/\s+/g, " ").trim();
}

function renderPageBody(doc: PageDoc): string {
  const parts: string[] = [];

  if (doc.summary) {
    parts.push(doc.summary);
  }

  for (const section of doc.sections) {
    const secParts = [`## ${section.title}`];
    if (section.description) {
      secParts.push(section.description);
    }
    for (const example of section.examples) {
      if (section.examples.length > 1) {
        secParts.push(`**${example.title}**`);
      }
      secParts.push(example.body);
    }
    parts.push(secParts.join("\n\n"));
  }

  return parts.join("\n\n");
}

function renderPage(doc: PageDoc): string {
  const sourcePath = `src/${normalizeSlashes(doc.relativePath)}`;
  const description =
    firstParagraph(doc.summary) || `API reference for ${doc.title}`;
  const frontmatter = [
    "---",
    `title: ${yamlString(doc.title)}`,
    `description: ${yamlString(description)}`,
    "---",
  ].join("\n");

  const sourceBlock = `> **Source:** \`${sourcePath}\``;
  const body = renderPageBody(doc).trim();

  if (body) {
    return `${frontmatter}\n\n${sourceBlock}\n\n${body}\n`;
  }
  return `${frontmatter}\n\n${sourceBlock}\n`;
}

/** Providers shown first in the sidebar; the rest follow alphabetically. */
const PROVIDER_ORDER = ["AWS", "Cloudflare"];

interface SidebarLeaf {
  label: string;
  link: string;
}
interface SidebarGroup {
  label: string;
  collapsed: true;
  items: SidebarItem[];
}
type SidebarItem = SidebarLeaf | SidebarGroup;

interface PageEntry {
  provider: string;
  service: string;
  resource: string;
  category: string;
  product: string;
  link: string;
}

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label);

function orderedKeys(keys: string[], order: string[]): string[] {
  const ranked = keys.filter((k) => order.includes(k));
  ranked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = keys.filter((k) => !order.includes(k)).sort();
  return [...ranked, ...rest];
}

/**
 * Build sidebar items for one set of pages sharing a provider+category:
 * every service (product) is its own collapsible folder containing its
 * resource pages, mirroring how Cloudflare's API reference gives each
 * product its own section — even single-page products like D1 or
 * Organization — so the grouping is uniform.
 */
function buildServiceItems(pages: PageEntry[]): SidebarItem[] {
  const byService = new Map<string, PageEntry[]>();
  for (const p of pages) {
    const key = p.service || p.resource;
    if (!byService.has(key)) byService.set(key, []);
    byService.get(key)!.push(p);
  }
  const items: SidebarItem[] = [];
  for (const [service, servicePages] of byService) {
    // Prefer the human product name from `@product`; fall back to the dir name.
    const label =
      servicePages.find((p) => p.product)?.product || service;
    items.push({
      label,
      collapsed: true,
      items: servicePages
        .map((p) => ({ label: p.resource, link: p.link }))
        .sort(byLabel),
    });
  }
  return items.sort(byLabel);
}

function buildProvidersSidebar(entries: PageEntry[]): SidebarItem[] {
  const byProvider = new Map<string, PageEntry[]>();
  for (const e of entries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push(e);
  }

  const providers: SidebarGroup[] = [];
  for (const provider of orderedKeys([...byProvider.keys()], PROVIDER_ORDER)) {
    const pages = byProvider.get(provider)!;
    const categorized = new Map<string, PageEntry[]>();
    const uncategorized: PageEntry[] = [];
    for (const p of pages) {
      if (p.category) {
        if (!categorized.has(p.category)) categorized.set(p.category, []);
        categorized.get(p.category)!.push(p);
      } else {
        uncategorized.push(p);
      }
    }

    const items: SidebarItem[] = [];
    for (const cat of [...categorized.keys()].sort((a, b) =>
      a.localeCompare(b),
    )) {
      items.push({
        label: cat,
        collapsed: true,
        items: buildServiceItems(categorized.get(cat)!),
      });
    }
    // Pages without a category fall back to service grouping directly under
    // the provider (this is how AWS renders until it gets categorized).
    items.push(...buildServiceItems(uncategorized));

    providers.push({ label: provider, collapsed: true, items });
  }
  return providers;
}

async function main() {
  const entries = await discoverFiles();
  console.log(`Discovered ${entries.length} source files.`);

  const project = new Project({
    tsConfigFilePath: config.tsConfig,
    skipFileDependencyResolution: true,
  });

  await fs.rm(config.outRoot, { recursive: true, force: true });
  await fs.mkdir(config.outRoot, { recursive: true });

  const seen = new Map<string, string>();
  const pageEntries: PageEntry[] = [];
  let written = 0;
  let skipped = 0;

  for (const entry of entries) {
    const sourceFile = project.getSourceFile(entry.absolutePath);
    if (!sourceFile) {
      console.warn(`  skipped (not in project): ${entry.relativePath}`);
      skipped++;
      continue;
    }

    const primary = findTaggedPrimary(sourceFile);
    if (!primary) {
      skipped++;
      continue;
    }

    // Only emit a page when there's actual documented content; a bare
    // frontmatter + source link stub is noise.
    if (!primary.doc.summary && primary.doc.sections.length === 0) {
      skipped++;
      continue;
    }

    // Mirror the source directory structure; name the page after the
    // tagged declaration (e.g. Cloudflare/AiSearch/AiSearchInstance.md).
    const relDir = path.dirname(entry.relativePath);
    const outputRelative = path.join(relDir, `${primary.name}.md`);

    const existing = seen.get(outputRelative);
    if (existing) {
      console.warn(
        `  collision: ${outputRelative} from ${entry.relativePath} (already from ${existing})`,
      );
    }
    seen.set(outputRelative, entry.relativePath);

    const doc: PageDoc = {
      title: primary.name,
      relativePath: entry.relativePath,
      summary: primary.doc.summary,
      sections: primary.doc.sections,
    };

    const outputPath = path.join(config.outRoot, outputRelative);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, renderPage(doc), "utf8");
    written++;

    const segments = normalizeSlashes(outputRelative).split("/");
    pageEntries.push({
      provider: segments[0] ?? "",
      service: segments.length > 2 ? segments[1] : "",
      resource: primary.name,
      category: primary.category,
      product: primary.product,
      link: `/providers/${normalizeSlashes(outputRelative)
        .replace(/\.md$/, "")
        .toLowerCase()}`,
    });
  }

  const sidebar = buildProvidersSidebar(pageEntries);
  const sidebarPath = path.join(websiteRoot, "src/generated/providers-sidebar.json");
  await fs.mkdir(path.dirname(sidebarPath), { recursive: true });
  await fs.writeFile(sidebarPath, `${JSON.stringify(sidebar, null, 2)}\n`, "utf8");

  console.log(
    `Done. Wrote ${written} resource pages (skipped ${skipped} untagged) to ${normalizeSlashes(
      path.relative(path.join(import.meta.dir, ".."), config.outRoot),
    )}.`,
  );
  console.log(
    `Wrote provider sidebar to ${normalizeSlashes(
      path.relative(path.join(import.meta.dir, ".."), sidebarPath),
    )}.`,
  );
}

await main();
