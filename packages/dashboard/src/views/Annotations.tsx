import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { memo } from "react";
import { formatDateTime } from "../format.ts";
import { useProjection } from "../store.ts";
import { wash } from "../theme.ts";
import { Markdownish } from "../ui/Markdownish.tsx";
import { ANNOTATION_COLORS } from "./Summary.tsx";

const STYLE_ICONS: Record<string, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

/**
 * The Annotations view: deployment-scoped rich notes (Buildkite-style,
 * upserted by context) rendered as website-style callouts — a left accent
 * bar over a soft wash — with the safe markdown-ish renderer (code fences
 * and links only, never raw HTML).
 */
export const AnnotationsView = memo(function AnnotationsView() {
  const annotations = useProjection("annotations");
  if (annotations.length === 0) {
    return (
      <p className="p-8 text-center font-serif text-[15px] text-[var(--alc-fg-3)]">
        No annotations for this deployment
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6">
      {annotations.map((annotation) => {
        const color = ANNOTATION_COLORS[annotation.style] ?? "var(--alc-info)";
        const Icon = STYLE_ICONS[annotation.style] ?? Info;
        return (
          <div
            key={annotation.context}
            className="rounded-[var(--alc-radius)] border-l-[3px] p-4"
            style={{ borderLeftColor: color, background: wash(color, 10) }}
          >
            <div className="mb-2 flex items-center gap-2">
              <Icon size={14} style={{ color }} />
              <span className="font-mono text-[11px] text-[var(--alc-fg-3)]">
                {annotation.context}
              </span>
              <span className="ml-auto font-mono text-[10.5px] text-[var(--alc-fg-4)]">
                {formatDateTime(annotation.at)}
              </span>
            </div>
            <Markdownish text={annotation.markdown} />
          </div>
        );
      })}
    </div>
  );
});
