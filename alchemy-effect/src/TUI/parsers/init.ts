/**
 * Initialize tree-sitter parsers for syntax highlighting.
 * This file must be imported before any components that use the <code> element.
 */
import { addDefaultParsers } from "@opentui/core";
import parsers from "./config.ts";

// Register tree-sitter parsers for syntax highlighting
addDefaultParsers(parsers.parsers);
