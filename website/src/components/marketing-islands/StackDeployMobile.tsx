import { useEffect, useRef, useState } from "react";
import DeployTerminal from "./DeployTerminal";
import { highlightTS } from "../marketing/highlightTS";

/**
 * Mobile-only combined view for the "Stand up your cloud / Tear it down" section.
 *
 * Shows ONE terminal-styled card with two tabs in the header chrome:
 *   - alchemy.run.ts   → highlighted source (the input)
 *   - $ alchemy deploy → live DeployTerminal animation (the output)
 *
 * Auto-cycles between the two tabs every CYCLE_MS. The cycle pauses as soon
 * as the user taps a tab so they can read at their own pace. We also pause
 * when the card is offscreen so we don't burn cycles in the background.
 */

type Tab = "code" | "deploy";

const CYCLE_MS = 7000;

export default function StackDeployMobile({ code }: { code: string }) {
  const [tab, setTab] = useState<Tab>("code");
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Auto-advance until the user pins a tab. Restarts on every tab change so
  // the dwell time is consistent whether a switch was automatic or manual.
  useEffect(() => {
    if (pinned) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        setTab((t) => (t === "code" ? "deploy" : "code"));
      }, CYCLE_MS);
    };

    // Only run while the card is in view.
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            schedule();
          } else if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      },
      { threshold: 0.3 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, [tab, pinned]);

  const onTab = (next: Tab) => {
    setPinned(true);
    setTab(next);
  };

  const codeHtml = highlightTS(code);

  return (
    <div ref={wrapRef} className="stack-mobile">
      <div className="stack-mobile__chrome">
        <div className="stack-mobile__header">
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-danger)" }}
          />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-warn)" }}
          />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-accent-bright)" }}
          />
          <div className="stack-mobile__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "code"}
              className="stack-mobile__tab"
              data-active={tab === "code"}
              onClick={() => onTab("code")}
            >
              alchemy.run.ts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "deploy"}
              className="stack-mobile__tab"
              data-active={tab === "deploy"}
              onClick={() => onTab("deploy")}
            >
              $ alchemy deploy
            </button>
          </div>
        </div>
        <div className="stack-mobile__body">
          {/* Both panels stay mounted so the DeployTerminal animation keeps
              running across tab switches — feels alive when you flip back. */}
          <div className="stack-mobile__panel" hidden={tab !== "code"}>
            <pre
              className="alc-code-block__pre stack-mobile__pre"
              dangerouslySetInnerHTML={{ __html: codeHtml }}
            />
          </div>
          <div className="stack-mobile__panel" hidden={tab !== "deploy"}>
            <DeployTerminal bare />
          </div>
        </div>
      </div>
      <div className="stack-mobile__hint" aria-hidden>
        {pinned ? (
          <span>tap a tab to switch</span>
        ) : (
          <span>cycling · tap to pin</span>
        )}
      </div>
    </div>
  );
}
