import { memo, type ReactNode } from "react";

/**
 * Deliberately tiny, safe markdown-ish renderer for deployment annotations:
 * code fences, inline `code`, and `[text](https://...)` links ONLY. All
 * content flows through React text nodes (never dangerouslySetInnerHTML),
 * so arbitrary HTML in an annotation renders inert.
 */

const INLINE_RE = /`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

const renderInline = (text: string, keyBase: string): ReactNode[] => {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index;
    if (index > last) {
      out.push(text.slice(last, index));
    }
    if (match[1] !== undefined) {
      out.push(
        <code
          key={`${keyBase}c${i}`}
          className="rounded-[var(--alc-radius-xs)] bg-[var(--alc-bg-sunk)] px-1 py-px font-mono text-[0.92em] text-[var(--alc-fg-1)]"
        >
          {match[1]}
        </code>,
      );
    } else {
      out.push(
        <a
          key={`${keyBase}a${i}`}
          href={match[3]}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--alc-accent-deep)] hover:underline"
        >
          {match[2]}
        </a>,
      );
    }
    last = index + match[0].length;
    i += 1;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
};

export const Markdownish = memo(function Markdownish({
  text,
}: {
  text: string;
}) {
  // even segments are prose, odd segments are fenced code
  const segments = text.split("```");
  return (
    <div className="space-y-2 text-[12.5px] leading-relaxed text-[var(--alc-fg-2)]">
      {segments.map((segment, i) => {
        if (i % 2 === 1) {
          // fenced code: drop the optional language token on the first line
          const newline = segment.indexOf("\n");
          const body =
            newline >= 0 && /^[\w-]*\s*$/.test(segment.slice(0, newline))
              ? segment.slice(newline + 1)
              : segment;
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-[var(--alc-radius)] bg-[var(--alc-bg-code)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--alc-fg-invert)]"
            >
              <code>{body.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        const paragraphs = segment.split(/\n{2,}/).filter((p) => p.trim());
        return paragraphs.map((paragraph, j) => (
          <p key={`${i}.${j}`} className="whitespace-pre-wrap break-words">
            {renderInline(paragraph.trim(), `${i}.${j}.`)}
          </p>
        ));
      })}
    </div>
  );
});
