import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import fs from "fs";
import footnotePlugin from "markdown-it-footnote";
import path from "path";
import { defineConfig } from "vitepress";
import {
	groupIconMdPlugin,
	groupIconVitePlugin,
} from "vitepress-plugin-group-icons";
import { parse as parseYaml } from "yaml";
import { processFrontmatterFiles } from "../../alchemy/src/web/vitepress";

// Imports for OG Image Generation
import { generateOgImage } from "./theme/og-generator";

const description = "Alchemy: Typescript-native Infrastructure-as-Code";
const SITE_URL = "https://alchemy.run";

// https://vitepress.dev/reference/site-config
export default defineConfig({
	title: "Alchemy",
	description: "Alchemy Docs",
	head: [
		["link", { rel: "icon", type: "image/png", href: "/potion.png" }],
		["meta", { property: "og:type", content: "website" }],
		// Base meta tags are now added by transformPageData
	],
	markdown: {
		// @ts-ignore
		codeTransformers: [transformerTwoslash()],
		theme: { light: "light-plus", dark: "dark-plus" },
		config: (md) => md.use(footnotePlugin).use(groupIconMdPlugin),
	},
	vite: {
		plugins: [groupIconVitePlugin() as any],
	},
	// https://vitepress.dev/reference/default-theme-config
	themeConfig: {
		nav: [
			{ text: "Home", link: "/" },
			{ text: "Docs", link: "/docs/getting-started" },
		],
		socialLinks: [
			{ icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
			{ icon: "discord", link: "https://discord.gg/jwKw8dBJdN" },
			{ icon: "x", link: "https://twitter.com/samgoodwin89" },
		],
		sidebar: [
			{ text: "Get Started", link: "/docs/getting-started" },
			{ text: "What is Alchemy?", link: "/docs/what-is-alchemy" },
			await generateSidebar("Guides"),
			await generateSidebar("Concepts"),
			await generateProvidersSidebar(),
		],
		search: { provider: "local" },
	},
	// Add transformPageData hook for dynamic meta tags
	transformPageData(pageData) {
		// Get page-specific details
		const pageTitle = pageData.title || "Alchemy";
		const pageDescription = pageData.frontmatter?.description || description;

		// Generate canonical URL
		let pagePath = pageData.filePath
			? "/" +
				path
					.relative(path.join(process.cwd()), pageData.filePath)
					.replace(/^alchemy-web\//, "")
					.replace(/\.(md|html)$/, "")
			: "/";

		// Handle index files
		pagePath = pagePath.replace(/\/index$/, "/");
		// Ensure consistent path normalization (use forward slashes)
		pagePath = pagePath.replace(/\\/g, "/");

		const canonicalUrl = `${SITE_URL}${pagePath}`;

		// Initialize frontmatter.head if not exists
		pageData.frontmatter.head = pageData.frontmatter.head || [];

		// --- OG Image Path Calculation (consistent with buildEnd) ---
		const relativeMdPath = path.relative(
			path.join(process.cwd()),
			pageData.filePath,
		);

		// Determine directory (docs or blogs) and file path
		let dir = "docs";
		let filePath = relativeMdPath.replace(/^alchemy-web\//, "");

		if (filePath.startsWith("blogs/")) {
			dir = "blogs";
			filePath = filePath.replace(/^blogs\//, "");
		} else if (filePath.startsWith("docs/")) {
			filePath = filePath.replace(/^docs\//, "");
		}

		// Generate image slug matching the buildEnd function logic
		let imageSlug = `${dir}-${filePath}`.replace(/\.md$/, "");

		if (imageSlug.endsWith("/index")) {
			imageSlug = imageSlug.substring(0, imageSlug.lastIndexOf("/index"));
		} else if (imageSlug.endsWith("index")) {
			imageSlug = imageSlug.replace(/index$/, "home");
		}

		imageSlug = imageSlug.replace(/\//g, "-").replace(/^-|-$/, "");
		const finalImageSlug = imageSlug === "" ? "home" : imageSlug;

		// Use custom OG image for home page, otherwise use generated images
		let ogImageUrl: string;
		if (pagePath === "/" || finalImageSlug === "home") {
			ogImageUrl = new URL("/alchemy-og.png", SITE_URL).toString();
		} else {
			const imageSlugForUrl = finalImageSlug || "placeholder";
			ogImageUrl = new URL(
				`/og-images/${imageSlugForUrl}.png`,
				SITE_URL,
			).toString();
		}
		// --- End OG Image Path Calculation ---

		// Add dynamic meta tags
		pageData.frontmatter.head.push(
			// Basic SEO
			["meta", { name: "description", content: pageDescription }],

			// Open Graph
			["meta", { property: "og:title", content: pageTitle }],
			["meta", { property: "og:description", content: pageDescription }],
			["meta", { property: "og:url", content: canonicalUrl }],
			["meta", { property: "og:site_name", content: "Alchemy" }],
			["meta", { property: "og:image", content: ogImageUrl }],
			["meta", { property: "og:image:width", content: "1200" }],
			["meta", { property: "og:image:height", content: "630" }],

			// Twitter
			["meta", { name: "twitter:card", content: "summary_large_image" }],
			["meta", { name: "twitter:site", content: "@samgoodwin89" }],
			["meta", { name: "twitter:title", content: pageTitle }],
			["meta", { name: "twitter:description", content: pageDescription }],
			["meta", { name: "twitter:image", content: ogImageUrl }],

			// Canonical URL
			["link", { rel: "canonical", href: canonicalUrl }],
		);

		return pageData;
	},

	async buildEnd(siteConfig) {
		console.log("Generating OG images...");

		// Directory for OG images
		const publicOgDir = path.join("public/og-images");

		// Ensure the public/og-images directory exists
		await fs.promises.mkdir(publicOgDir, { recursive: true });

		// Process both docs and blogs directories
		const baseDirs = ["docs", "blogs"];
		let fileCount = 0;
		let processedCount = 0;

		// Collect all files that need OG images
		const filesToProcess: Array<{
			entryFullPath: string;
			entryRelativePath: string;
			baseDir: string;
			ogImagePath: string;
		}> = [];

		// Function to recursively collect files
		async function collectFiles(
			baseDir: string,
			relativePath: string,
			outputDir: string,
		) {
			const fullPath = path.join(baseDir, relativePath);

			// Skip if directory doesn't exist (like if there's no blogs directory)
			if (!fs.existsSync(fullPath)) {
				return;
			}

			const entries = fs.readdirSync(fullPath, { withFileTypes: true });

			for (const entry of entries) {
				const entryRelativePath = path.join(relativePath, entry.name);
				const entryFullPath = path.join(baseDir, entryRelativePath);

				if (entry.isDirectory()) {
					// Recursively process subdirectories
					await collectFiles(baseDir, entryRelativePath, outputDir);
				} else if (entry.name.endsWith(".md")) {
					fileCount++;

					// Generate image slug
					const filePath = entryRelativePath;
					let imageSlug = `${baseDir}-${filePath}`.replace(/\.md$/, "");

					if (imageSlug.endsWith("/index")) {
						imageSlug = imageSlug.substring(0, imageSlug.lastIndexOf("/index"));
					} else if (imageSlug.endsWith("index")) {
						imageSlug = imageSlug.replace(/index$/, "home");
					}

					imageSlug = imageSlug.replace(/\//g, "-").replace(/^-|-$/, "");
					const finalImageSlug = imageSlug === "" ? "home" : imageSlug;

					const ogImageFileName = `${finalImageSlug}.png`;
					const ogImagePath = path.join(outputDir, ogImageFileName);

					filesToProcess.push({
						entryFullPath,
						entryRelativePath,
						baseDir,
						ogImagePath,
					});
				}
			}
		}

		// Collect all files first
		for (const dir of baseDirs) {
			await collectFiles(dir, "", publicOgDir);
		}

		console.log(`Found ${fileCount} files to process`);

		// Process files in parallel
		const promises = filesToProcess.map(async ({ entryFullPath, ogImagePath }) => {
			try {
				// Check if image already exists
				try {
					await fs.promises.access(ogImagePath);
					processedCount++;
					console.log(`Skipped (exists) ${processedCount}/${fileCount}: ${entryFullPath}`);
					return;
				} catch {
					// File doesn't exist, continue with generation
				}

				// Read the file content
				const fileContent = await fs.promises.readFile(entryFullPath, "utf-8");

				// Extract frontmatter
				const frontmatter = extractFrontmatter(fileContent);

				const pageTitleRaw = frontmatter.title || path.basename(entryFullPath, ".md");
				const pageTitle = pageTitleRaw
					.replace(/-/g, " ")
					.replace(/\b\w/g, (l) => l.toUpperCase());
				const pageDescription = frontmatter.description;

				if (!pageTitle) {
					console.warn(
						`Skipping OG image for ${entryFullPath}: title missing or could not be derived.`,
					);
					return;
				}

				await generateOgImage(pageTitle, pageDescription, ogImagePath);
				processedCount++;
				console.log(`Generated ${processedCount}/${fileCount}: ${entryFullPath}`);
			} catch (error) {
				console.error(`Failed to generate OG image for ${entryFullPath}:`, error);
			}
		});

		// Wait for all promises to complete
		await Promise.all(promises);

		console.log(`OG image generation complete. Processed ${processedCount}/${fileCount} files.`);

		// Simple function to extract frontmatter from markdown
		function extractFrontmatter(content: string) {
			const result: Record<string, any> = {};

			// Check if file has frontmatter (between --- markers)
			const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);

			if (!match) {
				return result;
			}

			// Parse the YAML frontmatter properly
			return parseYaml(match[1]) || {};
		}
	},
});

async function generateSidebar(title: string) {
	const folder = title.toLowerCase();
	return {
		text: title,
		collapsed: false,
		items: await processFrontmatterFiles(`docs/${folder}`, `/docs/${folder}`),
	};
}

/**
 * Generate sidebar items for providers by traversing the file system
 */
async function generateProvidersSidebar() {
	const providersDir = path.join(process.cwd(), "docs/providers");
	const providers = fs
		.readdirSync(providersDir)
		.filter((dir) => fs.statSync(path.join(providersDir, dir)).isDirectory())
		.sort();

	const items = await Promise.all(
		providers.map(async (provider) => {
			const providerDir = path.join(providersDir, provider);

			// Check if this provider has nested service directories (like aws-control)
			const entries = fs.readdirSync(providerDir, { withFileTypes: true });
			const hasSubdirectories = entries.some((entry) => entry.isDirectory());
			const hasDirectFiles = entries.some(
				(entry) => entry.isFile() && entry.name.endsWith(".md"),
			);

			if (hasSubdirectories && !hasDirectFiles) {
				// Handle nested structure (like aws-control)
				const serviceItems = entries
					.filter((entry) => entry.isDirectory())
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((serviceDir) => {
						const servicePath = path.join(providerDir, serviceDir.name);
						const serviceFiles = fs
							.readdirSync(servicePath)
							.filter((file) => file.endsWith(".md"))
							.sort();

						const resourceItems = serviceFiles.map((file) => {
							const baseName = path.basename(file, ".md");
							const displayName = baseName
								.split("-")
								.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
								.join("");

							return {
								text: displayName,
								link: `/docs/providers/${provider}/${serviceDir.name}/${baseName}`,
							};
						});

						// Convert service directory name to display text
						const serviceDisplayName = serviceDir.name
							.split("-")
							.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
							.join("");

						return {
							text: serviceDisplayName,
							collapsed: true,
							items: resourceItems,
						};
					});

				return {
					text: formatProviderName(provider),
					collapsed: true,
					items: serviceItems,
				};
			} else {
				// Handle flat structure (existing providers)
				const files = entries
					.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
					.map((entry) => entry.name)
					.sort();

				const fileItems = files.map((file) => {
					const baseName = path.basename(file, ".md");
					const displayName = baseName
						.split("-")
						.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
						.join("");

					return {
						text: displayName,
						link: `/docs/providers/${provider}/${baseName}`,
					};
				});

				return {
					text: formatProviderName(provider),
					collapsed: true,
					items: fileItems,
				};
			}
		}),
	);

	return {
		text: "Providers",
		collapsed: false,
		items,
	};
}

/**
 * Format provider name for display
 */
function formatProviderName(provider: string): string {
	if (provider === "aws-control") {
		return "AWS Cloud Control";
	}

	return provider
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
