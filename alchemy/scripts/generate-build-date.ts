#!/usr/bin/env bun

/**
 * This script generates a TypeScript file containing the build date
 * for use as the default worker compatibility date.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Generate today's date in YYYY-MM-DD format
const buildDate = new Date().toISOString().split('T')[0];

// TypeScript content to generate
const content = `// This file is auto-generated during build
// Do not edit manually

/**
 * The build date used as the default worker compatibility date.
 * This is set to the date when the package was built.
 */
export const BUILD_DATE = "${buildDate}";
`;

// Write to src directory so it gets included in the package
const outputPath = resolve(import.meta.dirname, '..', 'src', 'build-date.ts');

writeFileSync(outputPath, content, 'utf8');

console.log(`Generated build date: ${buildDate}`);
console.log(`Written to: ${outputPath}`);