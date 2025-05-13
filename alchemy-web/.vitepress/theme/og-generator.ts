import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * Generate an Open Graph image with a title, description, and alchemist image
 *
 * @param title Page title to display on the left
 * @param description Optional page description to display below the title
 * @param outputPath Path to save the generated image
 * @returns Promise that resolves when the image is generated
 */
export async function generateOgImage(
  title: string,
  description: string | undefined,
  outputPath: string
): Promise<void> {
  try {
    // Special case: For docs-home.png, use the existing alchemy-og.png instead
    if (path.basename(outputPath) === "docs-home.png") {
      const alchemyOgPath = path.resolve("public/alchemy-og.png");

      // Check if alchemy-og.png exists
      try {
        await fs.access(alchemyOgPath);
        // File exists, copy it to the output path
        const imageBuffer = await fs.readFile(alchemyOgPath);
        await fs.writeFile(outputPath, imageBuffer);
        console.log(`Used existing image for docs-home: ${outputPath}`);
        return;
      } catch (error) {
        // File doesn't exist, fall back to generating
        console.warn(
          `alchemy-og.png not found, generating image for docs-home instead`
        );
      }
    }

    // Calculate dimensions
    const totalWidth = 1200;
    const totalHeight = 630;
    const textAreaWidth = Math.floor(totalWidth * 0.6); // 60% of total width for text
    const imageAreaWidth = totalWidth - textAreaWidth; // 40% width for image

    // Text margins and positioning
    const leftMargin = 80; // More margin from the left edge
    const topMargin = 120; // Start text even lower from the top
    const titleLineHeight = 62; // Increased for better spacing
    const descriptionLineHeight = 38; // Increased for better spacing
    const spaceBetweenTitleAndDesc = 50; // More space between title and description

    // Preprocess text with even fewer chars per line to prevent any cutoff
    const titleLines = wrapText(title, 22); // Further reduced chars per line
    let descriptionLines: string[] = [];
    if (description) {
      descriptionLines = wrapText(description, 42); // Further reduced chars per line
    }

    // Calculate text height to center content vertically
    const titleHeight = titleLines.length * titleLineHeight;
    const descriptionHeight = descriptionLines.length * descriptionLineHeight;
    const totalTextHeight =
      titleHeight +
      (descriptionLines.length > 0
        ? spaceBetweenTitleAndDesc + descriptionHeight
        : 0);

    // Calculate top position to center text block vertically
    const textBlockTop = Math.max(
      topMargin,
      (totalHeight - totalTextHeight) / 2
    );

    // Generate SVG text elements for title with better vertical distribution
    let titleSvg = "";
    titleLines.forEach((line, index) => {
      const y = textBlockTop + index * titleLineHeight;
      titleSvg += `<text x="${leftMargin}" y="${y}" font-size="48" font-weight="bold" fill="#ffffff" font-family="sans-serif">${escapeXml(line)}</text>\n`;
    });

    // Generate SVG text elements for description with better spacing
    let descriptionSvg = "";
    descriptionLines.forEach((line, index) => {
      const y =
        textBlockTop +
        titleHeight +
        spaceBetweenTitleAndDesc +
        index * descriptionLineHeight;
      descriptionSvg += `<text x="${leftMargin}" y="${y}" font-size="28" fill="#cccccc" font-family="sans-serif">${escapeXml(line)}</text>\n`;
    });

    // Create SVG for the entire image with text
    // Using explicit dimensions and overflow="visible" to prevent text cutoff
    const svgFull = `
    <svg width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" overflow="visible" xmlns="http://www.w3.org/2000/svg">
      <rect width="${totalWidth}" height="${totalHeight}" fill="#1e1e1e" />
      <g>
        ${titleSvg}
        ${descriptionSvg}
      </g>
    </svg>
    `;

    // Convert full SVG to PNG
    const baseWithText = await sharp(Buffer.from(svgFull)).png().toBuffer();

    // Load the alchemist image
    const alchemistImagePath = path.resolve(
      __dirname,
      "../../public/alchemist.webp"
    );

    // Process the image - convert to PNG first to avoid WebP alpha channel issues
    const alchemistPng = await sharp(alchemistImagePath)
      .toFormat("png") // Convert to PNG to handle alpha channel properly
      .toBuffer();

    // Now resize the PNG to avoid potential alpha issues during resizing
    const imageSize = Math.min(380, imageAreaWidth - 60); // Give more margin around the image
    const alchemistResized = await sharp(alchemistPng)
      .resize(imageSize, imageSize, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }, // Transparent background for overlay
      })
      .toBuffer();

    // Position the image on the right side - add more margin
    const imageLeft = textAreaWidth + (imageAreaWidth - imageSize) / 2;
    const imageTop = (totalHeight - imageSize) / 2;

    // Create a polished gradient background behind the alchemist
    // Using more sophisticated SVG filters for a professional glow
    const gradientSize = imageSize * 1.15; // Make the gradient area larger than the image
    const gradientLeft = imageLeft + (imageSize - gradientSize) / 2;
    const gradientTop = imageTop + (imageSize - gradientSize) / 2;

    // Create an SVG with a complex gradient that looks more professional
    const gradientSvg = `
    <svg width="${gradientSize}" height="${gradientSize}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
          <stop offset="0%" stop-color="#bd34fe" stop-opacity="0.85" />
          <stop offset="35%" stop-color="#bd34fe" stop-opacity="0.6" />
          <stop offset="60%" stop-color="#47caff" stop-opacity="0.4" />
          <stop offset="80%" stop-color="#47caff" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#47caff" stop-opacity="0" />
        </radialGradient>
        <filter id="blur-filter" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="12" /> 
        </filter>
      </defs>
      <circle cx="${gradientSize / 2}" cy="${gradientSize / 2}" r="${gradientSize / 2.3}" fill="url(#glow)" filter="url(#blur-filter)" />
    </svg>
    `;

    // Convert gradient SVG to PNG with proper alpha channel
    const gradientPng = await sharp(Buffer.from(gradientSvg)).png().toBuffer();

    // Use a composite operation with multiple layers
    const resultImage = await sharp(baseWithText)
      .composite([
        {
          input: gradientPng,
          top: Math.round(gradientTop),
          left: Math.round(gradientLeft),
        },
        {
          input: alchemistResized,
          top: Math.round(imageTop),
          left: Math.round(imageLeft),
        },
      ])
      .flatten({ background: { r: 30, g: 30, b: 30 } }) // Ensure no transparency remains
      .png()
      .toBuffer();

    // Save the final image
    await fs.writeFile(outputPath, resultImage);

    console.log(`Generated OG image: ${outputPath}`);
  } catch (error) {
    console.error("Error generating OG image:", error);
    throw error;
  }
}

/**
 * Wraps text to fit within a certain character limit per line
 */
function wrapText(text: string, charsPerLine: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  words.forEach((word) => {
    if ((currentLine + " " + word).length <= charsPerLine) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Escapes XML special characters to prevent SVG rendering issues
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
