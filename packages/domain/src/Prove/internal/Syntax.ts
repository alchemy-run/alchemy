/** A node of a parsed source, as far as a form looks at it. */
interface Node {
  readonly type: string;
  readonly [key: string]: any;
}

/**
 * One way a piece of the language is written. The prover reads it, or stops
 * at it and says so: either way the tests hold a case for it.
 */
export interface Form {
  /** How a reader names it: the kind of node, and the way it is written. */
  readonly name: string;
  /** Whether the prover reads it. A form it does not read is reported. */
  readonly read: boolean;
  readonly is: (node: Node, parent: Node | undefined, key: string) => boolean;
}

const kind =
  (type: string) =>
  (node: Node): boolean =>
    node.type === type;

const form = (name: string, is: Form["is"], read = true): Form => ({ name, read, is });

/** Every operator of one kind of node: the ones the prover reads, and the rest. */
const operators = (
  type: string,
  read: ReadonlyArray<string>,
  unread: ReadonlyArray<string>,
): ReadonlyArray<Form> => [
  ...read.map((operator) =>
    form(`${type} ${operator}`, (node) => node.type === type && node.operator === operator),
  ),
  ...unread.map((operator) =>
    form(`${type} ${operator}`, (node) => node.type === type && node.operator === operator, false),
  ),
];

const isFunction = (node: Node | undefined): boolean =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression" ||
  node?.type === "FunctionDeclaration";

/**
 * The language, one form at a time: every kind of node the prover's
 * interpreter and loader meet, in each way it is written. A form with
 * `read: false` is one the prover stops at.
 */
export const FORMS: ReadonlyArray<Form> = [
  // Values the code writes.
  form("Literal: a number", (n) => n.type === "Literal" && typeof n.value === "number"),
  form("Literal: a string", (n) => n.type === "Literal" && typeof n.value === "string"),
  form("Literal: a boolean", (n) => n.type === "Literal" && typeof n.value === "boolean"),
  form("Literal: null", (n) => n.type === "Literal" && n.value === null && !n.regex && !n.bigint),
  form("Literal: a bigint", (n) => n.type === "Literal" && typeof n.bigint === "string"),
  form("Literal: a regular expression", (n) => n.type === "Literal" && Boolean(n.regex), false),
  form(
    "TemplateLiteral: text alone",
    (n) => n.type === "TemplateLiteral" && n.expressions.length === 0,
  ),
  form(
    "TemplateLiteral: with values",
    (n) => n.type === "TemplateLiteral" && n.expressions.length > 0,
  ),
  form("TemplateElement", kind("TemplateElement")),
  form("TaggedTemplateExpression", kind("TaggedTemplateExpression")),
  form("Identifier", kind("Identifier")),
  form("ThisExpression", kind("ThisExpression"), false),
  form("Super", kind("Super"), false),
  form("MetaProperty", kind("MetaProperty"), false),

  // Objects and arrays.
  form("ObjectExpression", kind("ObjectExpression")),
  form(
    "Property: a name and a value",
    (n, p) =>
      n.type === "Property" &&
      p?.type === "ObjectExpression" &&
      n.kind === "init" &&
      !n.shorthand &&
      !n.computed &&
      !n.method &&
      n.key.type === "Identifier",
  ),
  form(
    "Property: shorthand",
    (n, p) => n.type === "Property" && p?.type === "ObjectExpression" && n.shorthand === true,
  ),
  form(
    "Property: a key in quotes or a number",
    (n, p) =>
      n.type === "Property" &&
      p?.type === "ObjectExpression" &&
      !n.computed &&
      n.key.type === "Literal",
  ),
  form(
    "Property: a computed key",
    (n, p) => n.type === "Property" && p?.type === "ObjectExpression" && n.computed === true,
  ),
  form(
    "Property: a method",
    (n, p) =>
      n.type === "Property" &&
      p?.type === "ObjectExpression" &&
      n.method === true &&
      n.kind === "init",
  ),
  form("Property: a getter", (n) => n.type === "Property" && n.kind === "get", false),
  form("Property: a setter", (n) => n.type === "Property" && n.kind === "set", false),
  form("ArrayExpression", kind("ArrayExpression")),
  form(
    "ArrayExpression: with a hole",
    (n) => n.type === "ArrayExpression" && (n.elements as ReadonlyArray<unknown>).includes(null),
  ),
  form(
    "SpreadElement: in an array",
    (n, p) => n.type === "SpreadElement" && p?.type === "ArrayExpression",
  ),
  form(
    "SpreadElement: in an object",
    (n, p) => n.type === "SpreadElement" && p?.type === "ObjectExpression",
  ),
  form(
    "SpreadElement: in a call's arguments",
    (n, p) =>
      n.type === "SpreadElement" && (p?.type === "CallExpression" || p?.type === "NewExpression"),
  ),

  // Reading and calling.
  form(
    "MemberExpression: by a name",
    (n) => n.type === "MemberExpression" && !n.computed && !n.optional,
  ),
  form(
    "MemberExpression: by a computed key",
    (n) => n.type === "MemberExpression" && n.computed === true && !n.optional,
  ),
  form("MemberExpression: optional", (n) => n.type === "MemberExpression" && n.optional === true),
  form("ChainExpression", kind("ChainExpression")),
  form("CallExpression", (n) => n.type === "CallExpression" && !n.optional),
  form("CallExpression: optional", (n) => n.type === "CallExpression" && n.optional === true),
  form("NewExpression", kind("NewExpression")),
  form("ImportExpression", kind("ImportExpression"), false),
  form("ParenthesizedExpression", kind("ParenthesizedExpression")),
  form("SequenceExpression", kind("SequenceExpression")),
  form("ConditionalExpression", kind("ConditionalExpression")),

  // Functions.
  form(
    "ArrowFunctionExpression: an expression",
    (n) => n.type === "ArrowFunctionExpression" && !n.async && n.body.type !== "BlockStatement",
  ),
  form(
    "ArrowFunctionExpression: a block",
    (n) => n.type === "ArrowFunctionExpression" && !n.async && n.body.type === "BlockStatement",
  ),
  form(
    "FunctionExpression: without a name",
    (n) => n.type === "FunctionExpression" && !n.async && !n.generator && !n.id,
  ),
  form(
    "FunctionExpression: with a name",
    (n) => n.type === "FunctionExpression" && !n.async && !n.generator && Boolean(n.id),
  ),
  form(
    "FunctionExpression: a generator",
    (n) => n.type === "FunctionExpression" && !n.async && n.generator === true,
  ),
  form("FunctionDeclaration", (n) => n.type === "FunctionDeclaration" && !n.async && !n.generator),
  form(
    "FunctionDeclaration: a generator",
    (n) => n.type === "FunctionDeclaration" && !n.async && n.generator === true,
    false,
  ),
  form("an async function", (n) => isFunction(n) && n.async === true, false),
  form("AwaitExpression", kind("AwaitExpression"), false),
  form("YieldExpression: yield*", (n) => n.type === "YieldExpression" && n.delegate === true),
  form("YieldExpression: yield", (n) => n.type === "YieldExpression" && !n.delegate, false),
  form("ReturnStatement: a value", (n) => n.type === "ReturnStatement" && Boolean(n.argument)),
  form("ReturnStatement: nothing", (n) => n.type === "ReturnStatement" && !n.argument),

  // Parameters and patterns.
  form(
    "RestElement: a function's last parameter",
    (n, p, key) => n.type === "RestElement" && isFunction(p) && key === "params",
  ),
  form(
    "RestElement: in an array pattern",
    (n, p) => n.type === "RestElement" && p?.type === "ArrayPattern",
  ),
  form(
    "RestElement: in an object pattern",
    (n, p) => n.type === "RestElement" && p?.type === "ObjectPattern",
  ),
  form(
    "AssignmentPattern: a parameter's default",
    (n, p, key) => n.type === "AssignmentPattern" && isFunction(p) && key === "params",
  ),
  form(
    "AssignmentPattern: a default in an array pattern",
    (n, p) => n.type === "AssignmentPattern" && p?.type === "ArrayPattern",
  ),
  form(
    "AssignmentPattern: a default in an object pattern",
    (n, p) => n.type === "AssignmentPattern" && p?.type === "Property",
  ),
  form("ObjectPattern", kind("ObjectPattern")),
  form(
    "ObjectPattern: nested in a pattern",
    (n, p) => n.type === "ObjectPattern" && (p?.type === "Property" || p?.type === "ArrayPattern"),
  ),
  form(
    "Property: a name bound as itself",
    (n, p) => n.type === "Property" && p?.type === "ObjectPattern" && n.shorthand === true,
  ),
  form(
    "Property: a name bound as another",
    (n, p) => n.type === "Property" && p?.type === "ObjectPattern" && !n.shorthand && !n.computed,
  ),
  form(
    "Property: a computed key bound",
    (n, p) => n.type === "Property" && p?.type === "ObjectPattern" && n.computed === true,
  ),
  form("ArrayPattern", kind("ArrayPattern")),
  form(
    "ArrayPattern: with a hole",
    (n) => n.type === "ArrayPattern" && (n.elements as ReadonlyArray<unknown>).includes(null),
  ),
  form(
    "ArrayPattern: nested in a pattern",
    (n, p) => n.type === "ArrayPattern" && (p?.type === "Property" || p?.type === "ArrayPattern"),
  ),

  // Operators.
  ...operators(
    "BinaryExpression",
    [
      "+",
      "-",
      "*",
      "/",
      "%",
      "<",
      "<=",
      ">",
      ">=",
      "===",
      "!==",
      "==",
      "!=",
      "in",
      "**",
      "instanceof",
    ],
    [],
  ),
  ...operators("BinaryExpression", ["&", "|", "^", "<<", ">>", ">>>"], []),
  ...operators("LogicalExpression", ["&&", "||", "??"], []),
  ...operators("UnaryExpression", ["!", "-", "+", "void", "typeof", "~", "delete"], []),
  ...operators(
    "AssignmentExpression",
    ["=", "+=", "-=", "*=", "/=", "%=", "??=", "||=", "&&=", "**=", "<<=", ">>=", ">>>="],
    [],
  ),
  ...operators("AssignmentExpression", ["&=", "|=", "^="], []),
  form(
    "AssignmentExpression: to a variable",
    (n) => n.type === "AssignmentExpression" && n.left.type === "Identifier",
  ),
  form(
    "AssignmentExpression: to a property",
    (n) => n.type === "AssignmentExpression" && n.left.type === "MemberExpression",
  ),
  form(
    "AssignmentExpression: to an array pattern",
    (n) => n.type === "AssignmentExpression" && n.left.type === "ArrayPattern",
  ),
  form(
    "AssignmentExpression: to an object pattern",
    (n) => n.type === "AssignmentExpression" && n.left.type === "ObjectPattern",
  ),
  ...operators("UpdateExpression", ["++", "--"], []),
  form("UpdateExpression: before", (n) => n.type === "UpdateExpression" && n.prefix === true),
  form("UpdateExpression: after", (n) => n.type === "UpdateExpression" && n.prefix === false),
  form(
    "UpdateExpression: of a property",
    (n) => n.type === "UpdateExpression" && n.argument.type === "MemberExpression",
  ),

  // Statements.
  form("VariableDeclaration const", (n) => n.type === "VariableDeclaration" && n.kind === "const"),
  form("VariableDeclaration let", (n) => n.type === "VariableDeclaration" && n.kind === "let"),
  form("VariableDeclaration var", (n) => n.type === "VariableDeclaration" && n.kind === "var"),
  form(
    "VariableDeclaration using",
    (n) => n.type === "VariableDeclaration" && (n.kind === "using" || n.kind === "await using"),
    false,
  ),
  form(
    "VariableDeclaration: several at once",
    (n) => n.type === "VariableDeclaration" && n.declarations.length > 1,
  ),
  form(
    "VariableDeclarator: with a value",
    (n) => n.type === "VariableDeclarator" && Boolean(n.init),
  ),
  form("VariableDeclarator: without one", (n) => n.type === "VariableDeclarator" && !n.init),
  form("ExpressionStatement", kind("ExpressionStatement")),
  form("BlockStatement", kind("BlockStatement")),
  form("EmptyStatement", kind("EmptyStatement")),
  form("IfStatement: without else", (n) => n.type === "IfStatement" && !n.alternate),
  form("IfStatement: with else", (n) => n.type === "IfStatement" && Boolean(n.alternate)),
  form("SwitchStatement", kind("SwitchStatement")),
  form("SwitchCase: a case", (n) => n.type === "SwitchCase" && Boolean(n.test)),
  form("SwitchCase: default", (n) => n.type === "SwitchCase" && !n.test),
  form(
    "SwitchCase: falling into the next",
    (n) => n.type === "SwitchCase" && n.consequent.length === 0,
  ),
  form("BreakStatement", (n) => n.type === "BreakStatement" && !n.label),
  form("ContinueStatement", (n) => n.type === "ContinueStatement" && !n.label),
  form(
    "a break or a continue to a label",
    (n) => (n.type === "BreakStatement" || n.type === "ContinueStatement") && Boolean(n.label),
  ),
  form("LabeledStatement", kind("LabeledStatement")),
  form("ForOfStatement", (n) => n.type === "ForOfStatement" && !n.await),
  form("ForOfStatement: for await", (n) => n.type === "ForOfStatement" && n.await === true, false),
  form(
    "ForOfStatement: into a pattern",
    (n) =>
      n.type === "ForOfStatement" &&
      n.left.type === "VariableDeclaration" &&
      n.left.declarations[0].id.type !== "Identifier",
  ),
  form("ForInStatement", kind("ForInStatement")),
  form("ForStatement", kind("ForStatement")),
  form("ForStatement: without a start", (n) => n.type === "ForStatement" && !n.init),
  form("ForStatement: without a test", (n) => n.type === "ForStatement" && !n.test),
  form("ForStatement: without a step", (n) => n.type === "ForStatement" && !n.update),
  form("WhileStatement", kind("WhileStatement")),
  form("DoWhileStatement", kind("DoWhileStatement")),
  form("TryStatement", kind("TryStatement")),
  form("CatchClause", kind("CatchClause")),
  form("ThrowStatement", kind("ThrowStatement")),
  form("DebuggerStatement", kind("DebuggerStatement")),
  form("ClassExpression", kind("ClassExpression"), false),
  form(
    "ClassDeclaration: in a function",
    (n, p) =>
      n.type === "ClassDeclaration" && p?.type !== "Program" && !p?.type.startsWith("Export"),
    false,
  ),

  // TypeScript that changes nothing at run time, and TypeScript that does.
  form("TSAsExpression", kind("TSAsExpression")),
  form("TSSatisfiesExpression", kind("TSSatisfiesExpression")),
  form("TSNonNullExpression", kind("TSNonNullExpression")),
  form("TSTypeAssertion", kind("TSTypeAssertion")),
  form("TSInstantiationExpression", kind("TSInstantiationExpression")),
  form("TSTypeAliasDeclaration", kind("TSTypeAliasDeclaration")),
  form("TSInterfaceDeclaration", kind("TSInterfaceDeclaration")),
  form("TSEnumDeclaration", kind("TSEnumDeclaration"), false),
  form("TSModuleDeclaration", kind("TSModuleDeclaration"), false),

  // A file: what it imports, declares and exports.
  form("Program", kind("Program")),
  form(
    "ImportDeclaration: names",
    (n) =>
      n.type === "ImportDeclaration" &&
      n.importKind !== "type" &&
      n.specifiers.some((s: Node) => s.type === "ImportSpecifier"),
  ),
  form(
    "ImportDeclaration: a namespace",
    (n) =>
      n.type === "ImportDeclaration" &&
      n.specifiers.some((s: Node) => s.type === "ImportNamespaceSpecifier"),
  ),
  form(
    "ImportDeclaration: a default",
    (n) =>
      n.type === "ImportDeclaration" &&
      n.specifiers.some((s: Node) => s.type === "ImportDefaultSpecifier"),
  ),
  form(
    "ImportDeclaration: types only",
    (n) => n.type === "ImportDeclaration" && n.importKind === "type",
  ),
  form(
    "ImportDeclaration: for what it does",
    (n) => n.type === "ImportDeclaration" && n.importKind !== "type" && n.specifiers.length === 0,
  ),
  form(
    "ImportSpecifier: a name as itself",
    (n) => n.type === "ImportSpecifier" && n.imported.name === n.local.name,
  ),
  form(
    "ImportSpecifier: a name as another",
    (n) => n.type === "ImportSpecifier" && n.imported.name !== n.local.name,
  ),
  form("ImportNamespaceSpecifier", kind("ImportNamespaceSpecifier")),
  form("ImportDefaultSpecifier", kind("ImportDefaultSpecifier")),
  form(
    "ExportNamedDeclaration: a declaration",
    (n) => n.type === "ExportNamedDeclaration" && Boolean(n.declaration),
  ),
  form(
    "ExportNamedDeclaration: names of this file",
    (n) => n.type === "ExportNamedDeclaration" && !n.declaration && !n.source,
  ),
  form(
    "ExportNamedDeclaration: names of another file",
    (n) => n.type === "ExportNamedDeclaration" && !n.declaration && Boolean(n.source),
  ),
  form(
    "ExportSpecifier: a name as itself",
    (n) => n.type === "ExportSpecifier" && n.exported.name === n.local.name,
  ),
  form(
    "ExportSpecifier: a name as another",
    (n) => n.type === "ExportSpecifier" && n.exported.name !== n.local.name,
  ),
  form("ExportAllDeclaration: every name", (n) => n.type === "ExportAllDeclaration" && !n.exported),
  form(
    "ExportAllDeclaration: as a namespace",
    (n) => n.type === "ExportAllDeclaration" && Boolean(n.exported),
  ),
  form("ExportDefaultDeclaration", kind("ExportDefaultDeclaration")),
  form(
    "ClassDeclaration: of a file",
    (n, p) =>
      n.type === "ClassDeclaration" &&
      (p?.type === "Program" || p?.type.startsWith("Export") === true),
  ),
  form("ClassBody", kind("ClassBody")),
  form("PropertyDefinition", kind("PropertyDefinition"), false),
  form("MethodDefinition", kind("MethodDefinition"), false),
  form("StaticBlock", kind("StaticBlock"), false),
];

/** The keys of a node that hold types, which are not there when the code runs. */
const TYPES: ReadonlySet<string> = new Set([
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeArguments",
  "implements",
]);

/** The kinds of node that are types, whatever they hold. */
const isType = (node: Node): boolean =>
  node.type.startsWith("TS") && !FORMS.some((each) => each.is(node, undefined, ""));

/**
 * The forms a parsed source is written with, by name. A node that is none of
 * the forms above is `undeclared <its type>`: something the list has yet to
 * say whether the prover reads.
 */
export const formsOf = (program: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const visit = (node: unknown, parent: Node | undefined, key: string): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, key);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const at = node as Node;
    if (typeof at.type !== "string") return;
    // A type alias and an interface are statements of the file: what they hold is not code.
    const matched = FORMS.filter((each) => each.is(at, parent, key));
    if (matched.length === 0) {
      if (isType(at)) return;
      found.add(`undeclared ${at.type}`);
    }
    for (const each of matched) found.add(each.name);
    if (at.type === "TSTypeAliasDeclaration" || at.type === "TSInterfaceDeclaration") return;
    for (const [name, child] of Object.entries(at))
      if (!TYPES.has(name) && name !== "type") visit(child, at, name);
  };
  visit(program, undefined, "");
  return found;
};
