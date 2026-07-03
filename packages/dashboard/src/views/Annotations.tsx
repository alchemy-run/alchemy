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
 * upserted by context) rendered with the safe markdown-ish renderer —
 * code fences and links only, never raw HTML.
 */
export const AnnotationsView = memo(function AnnotationsView() {
  const annotations = useProjection("annotations");
  if (annotations.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-zinc-600">
        No annotations for this deployment
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6">
      {annotations.map((annotation) => {
        const color = ANNOTATION_COLORS[annotation.style] ?? "#818cf8";
        const Icon = STYLE_ICONS[annotation.style] ?? Info;
        return (
          <div
            key={annotation.context}
            className="rounded-xl border p-4"
            style={{ borderColor: `${color}44`, background: `${color}0d` }}
          >
            <div className="mb-2 flex items-center gap-2">
              <Icon size={14} style={{ color }} />
              <span className="font-mono text-[11px] text-zinc-500">
                {annotation.context}
              </span>
              <span className="ml-auto text-[10.5px] text-zinc-600">
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
