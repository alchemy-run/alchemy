import type { APIRoute } from "astro";
import { chromium } from "playwright";
import { getCollection, type CollectionEntry } from "astro:content";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";

export const prerender = true;

// Cache directory and manifest file
const CACHE_DIR = join(process.cwd(), ".astro", "og-cache");
const MANIFEST_FILE = join(CACHE_DIR, "digest-manifest.json");

interface DigestManifest {
  [path: string]: string; // path -> digest mapping
}

function loadManifest(): DigestManifest {
  if (existsSync(MANIFEST_FILE)) {
    try {
      return JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function saveManifest(manifest: DigestManifest) {
  ensureCacheDir();
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

export async function getStaticPaths() {
  const docs = await getCollection("docs");

  const paths = docs.map((doc) => ({
    params: { route: doc.id },
    props: { entry: doc },
  }));

  // Add a specific path for the root `/og/` route that maps to index
  const indexDoc = docs.find((doc) => doc.id === "index");
  if (indexDoc) {
    paths.push({
      params: { route: undefined }, // This handles the empty route case
      props: { entry: indexDoc },
    });
  }

  // Clean up old cached files and update manifest
  const currentPaths = new Set<string>();
  const newManifest: DigestManifest = {};

  // Build new manifest with current paths and digests
  for (const path of paths) {
    const route = path.params.route || "index";
    const ogPath = `/og/${route}.png`;
    const digest = path.props.entry.digest;

    currentPaths.add(ogPath);
    newManifest[ogPath] = digest;
  }

  // Load old manifest and find files to delete
  const oldManifest = loadManifest();
  const filesToDelete: string[] = [];

  // Find cached files that are no longer needed
  for (const oldPath in oldManifest) {
    if (!currentPaths.has(oldPath)) {
      const cacheFile = join(CACHE_DIR, oldPath.replace(/\//g, "_"));
      if (existsSync(cacheFile)) {
        filesToDelete.push(cacheFile);
      }
    }
  }

  // Delete outdated cached files
  for (const file of filesToDelete) {
    try {
      unlinkSync(file);
      console.log(`Deleted outdated OG cache: ${file}`);
    } catch (e) {
      console.error(`Failed to delete cache file: ${file}`, e);
    }
  }

  // Save the new manifest
  saveManifest(newManifest);

  return paths;
}

export const GET: APIRoute = async ({ props, params }) => {
  const { entry } = props as { entry: CollectionEntry<"docs"> };
  const { data, digest } = entry;
  const route = params.route || "index";

  const ogPath = `/og/${route}.png`;
  const cacheFile = join(CACHE_DIR, ogPath.replace(/\//g, "_"));

  // Check if we have a cached version with the same digest
  const manifest = loadManifest();
  if (manifest[ogPath] === digest && existsSync(cacheFile)) {
    try {
      const cachedImage = readFileSync(cacheFile);
      console.log(` (using cache)`);

      return new Response(cachedImage, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (e) {
      console.error(`Failed to read cached image: ${cacheFile}`, e);
      // Continue to regenerate if cache read fails
    }
  }

  console.log(` (generating)`);

  // Read images and convert to base64
  const publicDir = join(process.cwd(), "public");

  let logoBase64 = "";
  let alchemistBase64 = "";

  try {
    const logoData = readFileSync(join(publicDir, "alchemy-logo-dark.svg"));
    logoBase64 = `data:image/svg+xml;base64,${logoData.toString("base64")}`;
  } catch (e) {
    console.error("Failed to read logo:", e);
  }

  try {
    const alchemistData = readFileSync(join(publicDir, "alchemist.webp"));
    alchemistBase64 = `data:image/webp;base64,${alchemistData.toString("base64")}`;
  } catch (e) {
    console.error("Failed to read alchemist image:", e);
  }

  // Generate breadcrumb from entry path
  const pathParts = entry.id
    .split("/")
    .filter((part: string) => part !== "index");
  const breadcrumbParts =
    pathParts.length > 1
      ? pathParts.slice(0, -1)
      : pathParts[0]
        ? [pathParts[0]]
        : [];
  const isBlogPost = entry.id.startsWith("blog/");
  const breadcrumbText =
    breadcrumbParts.length > 0
      ? isBlogPost
        ? breadcrumbParts.join(" / ")
        : `docs / ${breadcrumbParts.join(" / ")}`
      : "";

  // Create the HTML content
  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;700&display=swap");

    :root {
      --og-width: 1200px;
      --og-height: 630px;
      /* Hero-inspired colors for dark theme */
      --hero-text-primary: #ffffff;
      --hero-title-accent: #a78bfa;
      --hero-glow-color: rgba(167, 139, 250, 0.1);
      --hero-noise-opacity: 0.4;
      --sl-color-bg: #090a0f;
      --sl-color-bg-nav: #0e0f17;
    }

    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      background: black;
    }

    .og-container {
      width: var(--og-width);
      height: var(--og-height);
      background:
        radial-gradient(
          circle at 50% 50%,
          var(--hero-glow-color) 0%,
          transparent 85%
        ),
        linear-gradient(
          135deg,
          var(--sl-color-bg) 0%,
          var(--sl-color-bg-nav) 100%
        );
      position: relative;
      display: flex;
      align-items: center;
      overflow: hidden;
      font-family: "IBM Plex Serif", Georgia, serif;
    }

    /* Noise overlay */
    .og-container::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: var(--hero-noise-opacity);
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
      mix-blend-mode: overlay;
      z-index: 1;
    }

    .content {
      flex: 1;
      padding-left: 80px;
      padding-right: 40px;
      z-index: 2;
      max-width: 714px;
    }

    .logo {
      margin-bottom: 30px;
    }

    .logo-image {
      height: 42px;
      width: auto;
    }

    .breadcrumb {
      font-size: 16px;
      font-weight: 400;
      color: #a78bfa;
      margin-bottom: 16px;
      font-family: "IBM Plex Sans", sans-serif;
      line-height: 1;
      opacity: 0.8;
    }

    .title {
      font-size: 72px;
      font-weight: 700;
      line-height: 1.2;
      margin: 0 0 30px 0;
      word-wrap: break-word;
      overflow-wrap: break-word;
      hyphens: auto;
      /* Dark mode gradient from Hero */
      background: linear-gradient(
        135deg,
        var(--hero-text-primary) 0%,
        var(--hero-title-accent) 100%
      );
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .description {
      font-size: clamp(1.1rem, 2.5vw, 1.5rem);
      color: #e5e7eb;
      line-height: 1.4;
      margin: 0;
      word-wrap: break-word;
      overflow-wrap: break-word;
      hyphens: auto;
      font-family: "IBM Plex Sans", sans-serif;
    }

    .character-container {
      position: absolute;
      right: 30px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 1;
    }

    .character-circle {
      width: 348px;
      height: 348px;
      border-radius: 50%;
      background: radial-gradient(
        circle,
        rgba(167, 139, 250, 0.3) 0%,
        rgba(147, 51, 234, 0.2) 50%,
        rgba(0, 0, 0, 0.1) 100%
      );
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      border: 2px solid rgba(167, 139, 250, 0.2);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.3);
    }

    .character-image {
      width: 348px;
      height: 348px;
      object-fit: contain;
      object-position: center;
    }
  </style>
</head>
<body>
  <div class="og-container">
    <div class="content">
      <div class="logo">
        <img src="${logoBase64}" alt="Alchemy" class="logo-image" />
      </div>
      ${breadcrumbText ? `<div class="breadcrumb">${breadcrumbText}</div>` : ""}
      <h1 class="title">${data.title}</h1>
      ${data.description || data.excerpt ? `<p class="description">${data.description || data.excerpt}</p>` : ""}
    </div>

    <div class="character-container">
      <div class="character-circle">
        <img src="${alchemistBase64}" alt="Alchemist" class="character-image" />
      </div>
    </div>
  </div>
</body>
</html>
  `;

  // Launch browser and render the HTML
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Set viewport to OG image size
  await page.setViewportSize({ width: 1200, height: 630 });

  // Set the HTML content
  await page.setContent(html, {
    waitUntil: "networkidle",
  });

  // Wait for fonts to load
  await page.waitForTimeout(100);

  // Take a screenshot
  const screenshot = await page.screenshot({
    type: "png",
    fullPage: false,
  });

  // Close the browser
  await browser.close();

  // Save to cache (which will also appear in dist/og via symlink)
  try {
    // Ensure the directory structure exists
    const cacheFileDir = dirname(cacheFile);
    if (!existsSync(cacheFileDir)) {
      mkdirSync(cacheFileDir, { recursive: true });
    }
    
    writeFileSync(cacheFile, screenshot);

    // Update manifest with new digest
    const updatedManifest = loadManifest();
    updatedManifest[ogPath] = digest;
    saveManifest(updatedManifest);

    console.log(`Cached OG image: ${cacheFile}`);
  } catch (e) {
    console.error(`Failed to cache image: ${cacheFile}`, e);
  }

  // Return the screenshot as the response
  return new Response(screenshot, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
