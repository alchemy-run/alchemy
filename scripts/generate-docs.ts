import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";

// ============ Types ============

interface ParsedExample {
  title: string;
  code: string;
  language: string;
}

interface ParsedSection {
  title: string;
  anchor: string;
  description: string | undefined;
  examples: ParsedExample[];
}

interface ParsedProperty {
  name: string;
  type: string;
  optional: boolean;
  jsDoc: string | undefined;
  defaultValue: string | undefined;
}

interface ParsedInterface {
  name: string;
  jsDoc: string | undefined;
  properties: ParsedProperty[];
}

interface ParsedFunction {
  name: string;
  jsDoc: string | undefined;
  signature: string;
}

interface ParsedCapability {
  name: string;
  capabilityType: string;
  parentResourceName: string;
  options: ParsedInterface | undefined;
  functions: ParsedFunction[];
  filePath: string;
  jsDoc: string | undefined;
}

interface ParsedEventSource {
  name: string;
  parentResourceName: string;
  props: ParsedInterface | undefined;
  attrs: ParsedInterface | undefined;
  filePath: string;
  jsDoc: string | undefined;
}

interface ParsedResource {
  name: string;
  resourceType: string;
  cloud: string;
  service: string;
  propsInterface: ParsedInterface | undefined;
  attrsInterface: ParsedInterface | undefined;
  filePath: string;
  jsDoc: string | undefined;
  sections: ParsedSection[];
}

interface ResourceDoc {
  resource: ParsedResource;
  capabilities: ParsedCapability[];
  eventSources: ParsedEventSource[];
}

// ============ Utilities ============

function toPascalCase(str: string): string {
  return str
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function escapeMarkdown(str: string): string {
  return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ============ File Discovery ============

type FileType =
  | "resource"
  | "provider"
  | "capability"
  | "event-source"
  | "binding"
  | "client"
  | "handler"
  | "consume"
  | "index"
  | "other";

function classifyFile(filePath: string): FileType {
  const basename = path.basename(filePath, ".ts");

  if (basename === "index") return "index";
  if (basename.endsWith(".provider")) return "provider";
  if (basename.endsWith(".event-source")) return "event-source";
  if (basename.endsWith(".binding")) return "binding";
  if (basename.endsWith(".client")) return "client";
  if (basename.endsWith(".handler")) return "handler";
  if (basename.endsWith(".consume")) return "consume";

  // Check if it's a capability file (has a dot but not the special types above)
  if (basename.includes(".")) return "capability";

  return "resource";
}

function extractCloudAndService(filePath: string): {
  cloud: string;
  service: string;
} | null {
  const parts = filePath.split(path.sep);
  const srcIndex = parts.indexOf("src");
  if (srcIndex === -1 || srcIndex + 2 >= parts.length) return null;

  const cloud = parts[srcIndex + 1];
  const service = parts[srcIndex + 2];

  // Skip root-level files (no service subdirectory)
  if (!service || service.endsWith(".ts")) return null;

  return { cloud, service };
}

function getParentResourceName(filePath: string): string {
  const basename = path.basename(filePath, ".ts");
  const parts = basename.split(".");
  return toPascalCase(parts[0]);
}

async function discoverSourceFiles(srcDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }

  await walk(srcDir);
  return files;
}

// ============ TypeScript Parsing ============

function extractJSDoc(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string | undefined {
  // Try getJSDocCommentsAndTags first
  const jsDocs = ts.getJSDocCommentsAndTags(node);
  for (const doc of jsDocs) {
    if (ts.isJSDoc(doc) && doc.comment) {
      if (typeof doc.comment === "string") {
        return doc.comment;
      }
      return doc.comment.map((c) => ("text" in c ? c.text : "")).join("");
    }
  }

  // Fallback: look at leading comment trivia
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingTrivia = fullText.substring(
    nodeStart,
    node.getStart(sourceFile),
  );

  // Look for JSDoc comment pattern: /** ... */
  const jsDocMatch = leadingTrivia.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (jsDocMatch) {
    // Clean up the JSDoc comment
    const comment = jsDocMatch[1]
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => !line.startsWith("@")) // Remove JSDoc tags
      .join(" ")
      .trim();
    if (comment) {
      return comment;
    }
  }

  return undefined;
}

function extractDefaultTag(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string | undefined {
  // Try getJSDocCommentsAndTags first
  const jsDocs = ts.getJSDocCommentsAndTags(node);
  for (const doc of jsDocs) {
    if (ts.isJSDoc(doc) && doc.tags) {
      for (const tag of doc.tags) {
        if (tag.tagName.text === "default") {
          if (typeof tag.comment === "string") {
            return tag.comment;
          }
          if (tag.comment) {
            return tag.comment.map((c) => ("text" in c ? c.text : "")).join("");
          }
        }
      }
    }
  }

  // Fallback: look at leading comment trivia for @default tag
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingTrivia = fullText.substring(
    nodeStart,
    node.getStart(sourceFile),
  );

  const defaultMatch = leadingTrivia.match(/@default\s+(.+?)(?:\n|\*\/)/);
  if (defaultMatch) {
    return defaultMatch[1].trim();
  }

  return undefined;
}

function toAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

function extractSectionsAndExamples(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): ParsedSection[] {
  const sections: ParsedSection[] = [];

  // Get the full JSDoc comment text
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingTrivia = fullText.substring(
    nodeStart,
    node.getStart(sourceFile),
  );

  // Look for JSDoc comment pattern: /** ... */
  const jsDocMatch = leadingTrivia.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (!jsDocMatch) return sections;

  const docContent = jsDocMatch[1];

  // Clean up lines but preserve structure
  const lines = docContent
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""));

  let currentSection: ParsedSection | undefined;
  let currentExample:
    | { title: string; codeLines: string[]; language: string }
    | undefined;
  let inCodeBlock = false;
  let codeBlockLanguage = "typescript";

  for (const line of lines) {
    // Check for @section tag
    const sectionMatch = line.match(/^@section\s+(.+)$/);
    if (sectionMatch) {
      // Save previous section
      if (currentSection) {
        if (currentExample && currentExample.codeLines.length > 0) {
          currentSection.examples.push({
            title: currentExample.title,
            code: currentExample.codeLines.join("\n"),
            language: currentExample.language,
          });
        }
        sections.push(currentSection);
      }
      currentSection = {
        title: sectionMatch[1].trim(),
        anchor: toAnchor(sectionMatch[1].trim()),
        description: undefined,
        examples: [],
      };
      currentExample = undefined;
      continue;
    }

    // Check for @example tag
    const exampleMatch = line.match(/^@example\s+(.+)$/);
    if (exampleMatch) {
      // Save previous example
      if (
        currentSection &&
        currentExample &&
        currentExample.codeLines.length > 0
      ) {
        currentSection.examples.push({
          title: currentExample.title,
          code: currentExample.codeLines.join("\n"),
          language: currentExample.language,
        });
      }
      currentExample = {
        title: exampleMatch[1].trim(),
        codeLines: [],
        language: "typescript",
      };
      continue;
    }

    // Check for code block start
    const codeStartMatch = line.match(/^```(\w*)$/);
    if (codeStartMatch && currentExample) {
      inCodeBlock = true;
      codeBlockLanguage = codeStartMatch[1] || "typescript";
      currentExample.language = codeBlockLanguage;
      continue;
    }

    // Check for code block end
    if (line.trim() === "```" && inCodeBlock) {
      inCodeBlock = false;
      continue;
    }

    // Collect code lines
    if (inCodeBlock && currentExample) {
      currentExample.codeLines.push(line);
    }
  }

  // Save final section and example
  if (currentSection) {
    if (currentExample && currentExample.codeLines.length > 0) {
      currentSection.examples.push({
        title: currentExample.title,
        code: currentExample.codeLines.join("\n"),
        language: currentExample.language,
      });
    }
    sections.push(currentSection);
  }

  return sections;
}

function parseInterfaceProperties(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
): ParsedProperty[] {
  const properties: ParsedProperty[] = [];

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const name = member.name.getText(sourceFile);
      const type = member.type ? member.type.getText(sourceFile) : "unknown";
      const optional = !!member.questionToken;
      const jsDoc = extractJSDoc(member, sourceFile);
      const defaultValue = extractDefaultTag(member, sourceFile);

      properties.push({ name, type, optional, jsDoc, defaultValue });
    }
  }

  return properties;
}

function findStringLiteralInCallExpression(
  node: ts.Node,
  calleeName: string,
  sourceFile: ts.SourceFile,
): string | undefined {
  // Recursively find a CallExpression where the callee involves the given name
  // and extract the first string literal argument
  if (ts.isCallExpression(node)) {
    // Check if this call or any nested call involves our target
    let current: ts.Expression = node.expression;

    // Handle chained calls like Binding<...>(...)
    while (ts.isCallExpression(current)) {
      current = current.expression;
    }

    // Check if the expression is or references our target
    const exprText = current.getText(sourceFile);
    if (exprText === calleeName || exprText.startsWith(calleeName)) {
      // Look for string literal in arguments
      for (const arg of node.arguments) {
        if (ts.isStringLiteral(arg)) {
          return arg.text;
        }
      }
    }
  }

  // Recurse into children
  let found: string | undefined;
  ts.forEachChild(node, (child) => {
    if (!found) {
      found = findStringLiteralInCallExpression(child, calleeName, sourceFile);
    }
  });
  return found;
}

function findResourceType(
  sourceFile: ts.SourceFile,
): { name: string; type: string } | undefined {
  let result: { name: string; type: string } | undefined;

  function visit(node: ts.Node) {
    // Look for: export const Bucket = Resource<...>("AWS.S3.Bucket");
    // or: export const Function = Runtime("AWS.Lambda.Function")<Function>();
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const name = decl.name.text;

          // Look for Resource or Runtime call expressions
          const resourceType = findStringLiteralInCallExpression(
            decl.initializer,
            "Resource",
            sourceFile,
          );
          if (resourceType) {
            result = { name, type: resourceType };
            return;
          }

          const runtimeType = findStringLiteralInCallExpression(
            decl.initializer,
            "Runtime",
            sourceFile,
          );
          if (runtimeType) {
            result = { name, type: runtimeType };
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function findBindingType(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string | undefined {
  // Look for Binding<...>(Target, "TYPE") or Binding<...>(Target, "TYPE", "Name")
  // The second argument is the capability type string
  if (ts.isCallExpression(node)) {
    let current: ts.Expression = node.expression;

    // Handle chained calls
    while (ts.isCallExpression(current)) {
      current = current.expression;
    }

    const exprText = current.getText(sourceFile);
    if (exprText === "Binding" || exprText.startsWith("Binding")) {
      // Second argument should be the capability type
      if (node.arguments.length >= 2) {
        const secondArg = node.arguments[1];
        if (ts.isStringLiteral(secondArg)) {
          return secondArg.text;
        }
      }
    }
  }

  // Recurse into children
  let found: string | undefined;
  ts.forEachChild(node, (child) => {
    if (!found) {
      found = findBindingType(child, sourceFile);
    }
  });
  return found;
}

function findCapabilityType(
  sourceFile: ts.SourceFile,
): { name: string; type: string } | undefined {
  let result: { name: string; type: string } | undefined;

  function visit(node: ts.Node) {
    // Look for: export const GetObject = Binding<...>(Function, "AWS.S3.GetObject");
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const name = decl.name.text;

          const bindingType = findBindingType(decl.initializer, sourceFile);
          if (bindingType) {
            result = { name, type: bindingType };
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function findExportedFunctions(sourceFile: ts.SourceFile): ParsedFunction[] {
  const functions: ParsedFunction[] = [];

  function visit(node: ts.Node) {
    // Look for exported const functions: export const getObject = Effect.fnUntraced(...)
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const name = decl.name.text;
          // Skip uppercase names (those are typically types/bindings, not functions)
          if (name[0] === name[0].toUpperCase()) continue;

          const initText = decl.initializer.getText(sourceFile);
          // Check if it looks like an Effect function
          if (
            initText.includes("Effect.fn") ||
            initText.includes("Effect.gen")
          ) {
            const jsDoc = extractJSDoc(node, sourceFile);
            functions.push({
              name,
              jsDoc,
              signature: `${name}(...)`,
            });
          }
        }
      }
    }

    // Look for exported function declarations
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      node.name
    ) {
      const name = node.name.text;
      const jsDoc = extractJSDoc(node, sourceFile);
      functions.push({
        name,
        jsDoc,
        signature: `${name}(...)`,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

function parseResourceFile(
  filePath: string,
  sourceFile: ts.SourceFile,
  cloud: string,
  service: string,
): ParsedResource | undefined {
  const resourceInfo = findResourceType(sourceFile);
  if (!resourceInfo) return undefined;

  // Extract to local constants for TypeScript narrowing in nested function
  const resourceName = resourceInfo.name;
  const resourceType = resourceInfo.type;

  let propsInterface: ParsedInterface | undefined;
  let attrsInterface: ParsedInterface | undefined;
  let resourceJsDoc: string | undefined;
  let sections: ParsedSection[] = [];

  // Find Props and Attrs interfaces, and extract sections from resource declaration
  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;

      if (name === `${resourceName}Props`) {
        propsInterface = {
          name,
          jsDoc: extractJSDoc(node, sourceFile),
          properties: parseInterfaceProperties(node, sourceFile),
        };
      } else if (
        name === `${resourceName}Attrs` ||
        name === `${resourceName}Attr`
      ) {
        attrsInterface = {
          name,
          jsDoc: extractJSDoc(node, sourceFile),
          properties: parseInterfaceProperties(node, sourceFile),
        };
      } else if (name === resourceName) {
        // The main resource interface might have JSDoc
        resourceJsDoc = extractJSDoc(node, sourceFile);
      }
    }

    // Look for the resource declaration to extract sections/examples
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === resourceName) {
          // Extract sections and examples from the resource declaration's JSDoc
          sections = extractSectionsAndExamples(node, sourceFile);
          // Also try to get JSDoc from the variable statement if not found elsewhere
          if (!resourceJsDoc) {
            resourceJsDoc = extractJSDoc(node, sourceFile);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    name: resourceName,
    resourceType: resourceType,
    cloud,
    service,
    propsInterface,
    attrsInterface,
    filePath,
    jsDoc: resourceJsDoc,
    sections,
  };
}

function parseCapabilityFile(
  filePath: string,
  sourceFile: ts.SourceFile,
): ParsedCapability | undefined {
  const capabilityInfo = findCapabilityType(sourceFile);
  if (!capabilityInfo) return undefined;

  // Extract to local constants for TypeScript narrowing in nested function
  const capabilityName = capabilityInfo.name;
  const capabilityType = capabilityInfo.type;

  const parentResourceName = getParentResourceName(filePath);
  let optionsInterface: ParsedInterface | undefined;
  let capabilityJsDoc: string | undefined;

  // Find Options interface
  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;

      if (name === `${capabilityName}Options`) {
        optionsInterface = {
          name,
          jsDoc: extractJSDoc(node, sourceFile),
          properties: parseInterfaceProperties(node, sourceFile),
        };
      } else if (name === capabilityName) {
        capabilityJsDoc = extractJSDoc(node, sourceFile);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const functions = findExportedFunctions(sourceFile);

  return {
    name: capabilityName,
    capabilityType: capabilityType,
    parentResourceName,
    options: optionsInterface,
    functions,
    filePath,
    jsDoc: capabilityJsDoc,
  };
}

function parseEventSourceFile(
  filePath: string,
  sourceFile: ts.SourceFile,
): ParsedEventSource | undefined {
  const basename = path.basename(filePath, ".ts");
  const parts = basename.split(".");
  const parentResourceName = toPascalCase(parts[0]);
  const eventSourceName =
    toPascalCase(parts.slice(0, -1).join("-")) + "EventSource";

  let propsInterface: ParsedInterface | undefined;
  let attrsInterface: ParsedInterface | undefined;
  let eventSourceJsDoc: string | undefined;

  // Find Props and Attr interfaces
  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;

      if (name.endsWith("EventSourceProps")) {
        propsInterface = {
          name,
          jsDoc: extractJSDoc(node, sourceFile),
          properties: parseInterfaceProperties(node, sourceFile),
        };
      } else if (
        name.endsWith("EventSourceAttr") ||
        name.endsWith("EventSourceAttrs")
      ) {
        attrsInterface = {
          name,
          jsDoc: extractJSDoc(node, sourceFile),
          properties: parseInterfaceProperties(node, sourceFile),
        };
      } else if (
        name.endsWith("EventSource") &&
        !name.endsWith("Props") &&
        !name.endsWith("Attr")
      ) {
        eventSourceJsDoc = extractJSDoc(node, sourceFile);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Only return if we found something useful
  if (!propsInterface && !attrsInterface) return undefined;

  return {
    name: eventSourceName,
    parentResourceName,
    props: propsInterface,
    attrs: attrsInterface,
    filePath,
    jsDoc: eventSourceJsDoc,
  };
}

// ============ Linking ============

function groupByResource(
  resources: ParsedResource[],
  capabilities: ParsedCapability[],
  eventSources: ParsedEventSource[],
): Map<string, ResourceDoc> {
  const docs = new Map<string, ResourceDoc>();

  // Initialize with all resources
  for (const resource of resources) {
    const key = `${resource.cloud}/${resource.service}/${resource.name}`;
    docs.set(key, {
      resource,
      capabilities: [],
      eventSources: [],
    });
  }

  // Link capabilities to resources
  for (const cap of capabilities) {
    // Find the matching resource in the same directory
    const capDir = path.dirname(cap.filePath);
    for (const [_key, doc] of Array.from(docs.entries())) {
      const resourceDir = path.dirname(doc.resource.filePath);
      if (
        capDir === resourceDir &&
        cap.parentResourceName === doc.resource.name
      ) {
        doc.capabilities.push(cap);
        break;
      }
    }
  }

  // Link event sources to resources
  for (const es of eventSources) {
    const esDir = path.dirname(es.filePath);
    for (const [_key, doc] of Array.from(docs.entries())) {
      const resourceDir = path.dirname(doc.resource.filePath);
      if (
        esDir === resourceDir &&
        es.parentResourceName === doc.resource.name
      ) {
        doc.eventSources.push(es);
        break;
      }
    }
  }

  return docs;
}

// ============ Markdown Generation ============

function generatePropsTable(iface: ParsedInterface): string {
  const lines: string[] = [];
  lines.push("| Property | Type | Required | Default | Description |");
  lines.push("|----------|------|----------|---------|-------------|");

  for (const prop of iface.properties) {
    const required = prop.optional ? "No" : "Yes";
    const defaultVal = prop.defaultValue || "-";
    const description = prop.jsDoc ? escapeMarkdown(prop.jsDoc) : "-";
    const type = `\`${escapeMarkdown(prop.type)}\``;

    lines.push(
      `| ${prop.name} | ${type} | ${required} | ${defaultVal} | ${description} |`,
    );
  }

  return lines.join("\n");
}

function generateAttrsTable(iface: ParsedInterface): string {
  const lines: string[] = [];
  lines.push("| Attribute | Type | Description |");
  lines.push("|-----------|------|-------------|");

  for (const prop of iface.properties) {
    const description = prop.jsDoc ? escapeMarkdown(prop.jsDoc) : "-";
    const type = `\`${escapeMarkdown(prop.type)}\``;

    lines.push(`| ${prop.name} | ${type} | ${description} |`);
  }

  return lines.join("\n");
}

function generateCapabilitySection(cap: ParsedCapability): string {
  const lines: string[] = [];

  lines.push(`### ${cap.name}`);
  lines.push("");

  if (cap.jsDoc) {
    lines.push(cap.jsDoc);
    lines.push("");
  }

  lines.push(`**Type:** \`${cap.capabilityType}\``);
  lines.push("");

  if (cap.options && cap.options.properties.length > 0) {
    lines.push("#### Options");
    lines.push("");
    lines.push("| Option | Type | Required | Description |");
    lines.push("|--------|------|----------|-------------|");

    for (const prop of cap.options.properties) {
      const required = prop.optional ? "No" : "Yes";
      const description = prop.jsDoc ? escapeMarkdown(prop.jsDoc) : "-";
      const type = `\`${escapeMarkdown(prop.type)}\``;

      lines.push(`| ${prop.name} | ${type} | ${required} | ${description} |`);
    }
    lines.push("");
  }

  if (cap.functions.length > 0) {
    lines.push("#### Functions");
    lines.push("");
    for (const fn of cap.functions) {
      const desc = fn.jsDoc ? ` - ${fn.jsDoc}` : "";
      lines.push(`- \`${fn.signature}\`${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateEventSourceSection(es: ParsedEventSource): string {
  const lines: string[] = [];

  lines.push(`### ${es.name}`);
  lines.push("");

  if (es.jsDoc) {
    lines.push(es.jsDoc);
    lines.push("");
  }

  if (es.props && es.props.properties.length > 0) {
    lines.push("#### Props");
    lines.push("");
    lines.push(generatePropsTable(es.props));
    lines.push("");
  }

  if (es.attrs && es.attrs.properties.length > 0) {
    lines.push("#### Attributes");
    lines.push("");
    lines.push(generateAttrsTable(es.attrs));
    lines.push("");
  }

  return lines.join("\n");
}

function generateResourceMarkdown(doc: ResourceDoc): string {
  const lines: string[] = [];

  // Title
  lines.push(`# ${doc.resource.name}`);
  lines.push("");

  // Description
  if (doc.resource.jsDoc) {
    lines.push(doc.resource.jsDoc);
    lines.push("");
  }

  // Type
  lines.push(`**Type:** \`${doc.resource.resourceType}\``);
  lines.push("");

  // Table of Contents (if there are sections)
  if (doc.resource.sections.length > 0) {
    lines.push("## Quick Reference");
    lines.push("");
    for (const section of doc.resource.sections) {
      lines.push(`- [${section.title}](#${section.anchor})`);
    }
    lines.push("");
  }

  // Props section
  if (
    doc.resource.propsInterface &&
    doc.resource.propsInterface.properties.length > 0
  ) {
    lines.push("## Props");
    lines.push("");
    if (doc.resource.propsInterface.jsDoc) {
      lines.push(doc.resource.propsInterface.jsDoc);
      lines.push("");
    }
    lines.push(generatePropsTable(doc.resource.propsInterface));
    lines.push("");
  }

  // Attrs section
  if (
    doc.resource.attrsInterface &&
    doc.resource.attrsInterface.properties.length > 0
  ) {
    lines.push("## Attributes");
    lines.push("");
    if (doc.resource.attrsInterface.jsDoc) {
      lines.push(doc.resource.attrsInterface.jsDoc);
      lines.push("");
    }
    lines.push(generateAttrsTable(doc.resource.attrsInterface));
    lines.push("");
  }

  // Capabilities section
  if (doc.capabilities.length > 0) {
    lines.push("## Capabilities");
    lines.push("");
    for (const cap of doc.capabilities) {
      lines.push(generateCapabilitySection(cap));
    }
  }

  // Event Sources section
  if (doc.eventSources.length > 0) {
    lines.push("## Event Sources");
    lines.push("");
    for (const es of doc.eventSources) {
      lines.push(generateEventSourceSection(es));
    }
  }

  // Examples section (from @section and @example tags)
  if (doc.resource.sections.length > 0) {
    lines.push("## Examples");
    lines.push("");

    for (const section of doc.resource.sections) {
      lines.push(`### ${section.title}`);
      lines.push("");

      if (section.description) {
        lines.push(section.description);
        lines.push("");
      }

      for (const example of section.examples) {
        lines.push(`#### ${example.title}`);
        lines.push("");
        lines.push(`\`\`\`${example.language}`);
        lines.push(example.code);
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ============ File Writing ============

async function writeDocFiles(
  docs: Map<string, ResourceDoc>,
  outputDir: string,
): Promise<void> {
  for (const [_key, doc] of Array.from(docs.entries())) {
    const outputPath = path.join(
      outputDir,
      doc.resource.cloud,
      doc.resource.service,
      `${toKebabCase(doc.resource.name)}.md`,
    );

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, generateResourceMarkdown(doc));
    console.log(`Generated: ${outputPath}`);
  }
}

// ============ Main ============

async function main() {
  const srcDir = path.resolve("alchemy-effect/src");
  const outputDir = path.resolve("alchemy-effect/docs");

  console.log("Discovering source files...");
  const allFiles = await discoverSourceFiles(srcDir);

  // Filter and classify files
  const resourceFiles: { path: string; cloud: string; service: string }[] = [];
  const capabilityFiles: string[] = [];
  const eventSourceFiles: string[] = [];

  for (const file of allFiles) {
    const location = extractCloudAndService(file);
    if (!location) continue; // Skip root-level files

    const type = classifyFile(file);
    switch (type) {
      case "resource":
        resourceFiles.push({ path: file, ...location });
        break;
      case "capability":
        capabilityFiles.push(file);
        break;
      case "event-source":
        eventSourceFiles.push(file);
        break;
    }
  }

  console.log(`Found ${resourceFiles.length} resource files`);
  console.log(`Found ${capabilityFiles.length} capability files`);
  console.log(`Found ${eventSourceFiles.length} event source files`);

  // Create TypeScript program
  console.log("\nParsing TypeScript...");
  const allSourceFiles = [
    ...resourceFiles.map((r) => r.path),
    ...capabilityFiles,
    ...eventSourceFiles,
  ];

  const program = ts.createProgram(allSourceFiles, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
  });

  // Parse all files
  const resources: ParsedResource[] = [];
  const capabilities: ParsedCapability[] = [];
  const eventSources: ParsedEventSource[] = [];

  for (const { path: filePath, cloud, service } of resourceFiles) {
    const sourceFile = program.getSourceFile(filePath);
    if (sourceFile) {
      const resource = parseResourceFile(filePath, sourceFile, cloud, service);
      if (resource) {
        resources.push(resource);
      }
    }
  }

  for (const filePath of capabilityFiles) {
    const sourceFile = program.getSourceFile(filePath);
    if (sourceFile) {
      const cap = parseCapabilityFile(filePath, sourceFile);
      if (cap) {
        capabilities.push(cap);
      }
    }
  }

  for (const filePath of eventSourceFiles) {
    const sourceFile = program.getSourceFile(filePath);
    if (sourceFile) {
      const es = parseEventSourceFile(filePath, sourceFile);
      if (es) {
        eventSources.push(es);
      }
    }
  }

  console.log(`\nParsed ${resources.length} resources`);
  console.log(`Parsed ${capabilities.length} capabilities`);
  console.log(`Parsed ${eventSources.length} event sources`);

  // Group by resource
  console.log("\nLinking capabilities to resources...");
  const docs = groupByResource(resources, capabilities, eventSources);

  // Generate markdown
  console.log("\nGenerating markdown...");
  await writeDocFiles(docs, outputDir);

  console.log(`\nDone! Generated ${docs.size} resource docs.`);
}

main().catch(console.error);
