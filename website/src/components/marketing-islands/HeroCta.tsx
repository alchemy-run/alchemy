import { useState } from "react";

const PROMPT =
  "Read https://alchemy.run/getting-started.md and help me scaffold an Alchemy app.";

export default function HeroCta() {
  return (
    <div className="hero-cta">
      <div className="hero-cta__buttons">
        <a className="alc-btn alc-btn--primary" href="/getting-started">
          Get started <span aria-hidden>→</span>
        </a>
        <a className="alc-btn alc-btn--secondary" href="/tutorial">
          Tutorial
        </a>
      </div>
      <div className="hero-cta__line">
        <span>
          <span aria-hidden>🤖</span> Using a coding agent?
        </span>
        <InlineCopyChip />
      </div>
    </div>
  );
}

function InlineCopyChip() {
  const [copied, setCopied] = useState(false);
  const onCopy = () => copy(PROMPT, setCopied);
  return (
    <button
      type="button"
      className="hero-cta__chip"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy prompt"}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy prompt"}</span>
    </button>
  );
}

function copy(text: string, setCopied: (b: boolean) => void) {
  const finish = () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(finish, finish);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  finish();
}

function CopyIcon() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
