import { useEffect, useState, type CSSProperties } from "react";
import { highlightTS } from "../marketing/highlightTS";
import "./TypePolicy.css";

/*
 * The binding you ask for decides the client type you get back, so the
 * code can only do what the binding grants. The loop narrows
 * `ReadWriteBucket` to `ReadBucket`: the write methods leave the client's
 * type and `photos.put` stops compiling, then it widens back.
 *
 * The diagnostic is TypeScript's real message for this code (the talk
 * deck type-checks the same snippet, FilesRead.error.ts).
 */

const RW = "ReadWriteBucket";
const R = "ReadBucket";
const ERROR = "Property 'put' does not exist on type 'ReadBucketClient'.";

// Narrow, check, hold the error, widen back, check, hold.
const T_NARROW = 1000;
const T_ERROR = T_NARROW + 600;
const T_WIDEN = T_ERROR + 1900;
const T_CLEAN = T_WIDEN + 600;
const LOOP_MS = T_CLEAN + 1000;
const ROLL_MS = 450;

const READ = ["head", "get", "list"];
const WRITE = [
  "put",
  "delete",
  "createMultipartUpload",
  "resumeMultipartUpload",
];

const isPaused = () =>
  document.documentElement.classList.contains("alc-motion-paused") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const hl = (s: string) => ({ __html: highlightTS(s) });

/** A value that rolls up when it changes (the hero's roll, from the deck). */
function Slot({ was, now, k }: { was: string; now: string; k: number }) {
  return (
    <span
      key={k}
      className={`tp-slot ${was !== now ? "is-rolling" : ""}`}
      style={
        {
          "--from": `${was.length}ch`,
          "--to": `${now.length}ch`,
          width: `${now.length}ch`,
        } as CSSProperties
      }
    >
      <span className="tp-slot__strip">
        <span dangerouslySetInnerHTML={hl(was)} />
        <span dangerouslySetInnerHTML={hl(now)} />
      </span>
    </span>
  );
}

export default function TypePolicy() {
  // A still frame (the error) until the loop starts.
  const [t, setT] = useState(T_ERROR + 200);

  useEffect(() => {
    let paused = isPaused();
    let last = performance.now();
    let elapsed = 0;
    const onMotion = () => {
      paused = isPaused();
    };
    addEventListener("alc-motion-change", onMotion);
    const id = setInterval(() => {
      const now = performance.now();
      if (!paused) {
        elapsed = (elapsed + now - last) % LOOP_MS;
        setT(elapsed);
      }
      last = now;
    }, 60);
    return () => {
      clearInterval(id);
      removeEventListener("alc-motion-change", onMotion);
    };
  }, []);

  const readOnly = t >= T_NARROW && t < T_WIDEN;
  const rolling =
    (t >= T_NARROW && t < T_NARROW + ROLL_MS) ||
    (t >= T_WIDEN && t < T_WIDEN + ROLL_MS);
  const was = rolling ? (readOnly ? RW : R) : readOnly ? R : RW;
  const now = readOnly ? R : RW;
  const rollKey = readOnly ? 1 : 0;
  const checking =
    (t >= T_NARROW + ROLL_MS && t < T_ERROR) ||
    (t >= T_WIDEN + ROLL_MS && t < T_CLEAN);
  const error = t >= T_ERROR && t < T_WIDEN + ROLL_MS;
  const client = `${now}Client`;
  const wasClient = `${was}Client`;

  return (
    <div className="tp" aria-hidden>
      <div className="tp-editor">
        <div className="tp-bar">
          <span
            className="tp-dot"
            style={{ background: "var(--alc-dot-red)" }}
          />
          <span
            className="tp-dot"
            style={{ background: "var(--alc-dot-yellow)" }}
          />
          <span
            className="tp-dot"
            style={{ background: "var(--alc-dot-green)" }}
          />
          <span className="tp-bar__file">src/Photos.ts</span>
          <span
            className={`tp-check ${error ? "is-error" : checking ? "is-checking" : "is-ok"}`}
          >
            {error ? "✗ 1 error" : checking ? "type-checking…" : "✓ no errors"}
          </span>
        </div>
        <pre className="tp-code">
          <span
            dangerouslySetInnerHTML={hl(
              'export const PhotosR2 = Layer.effect(\n  Photos,\n  Effect.gen(function* () {\n    const bucket = yield* Cloudflare.R2.Bucket("Photos");\n',
            )}
          />
          <span className={`tp-line ${rolling || readOnly ? "is-lit" : ""}`}>
            <span
              dangerouslySetInnerHTML={hl(
                "    const photos = yield* Cloudflare.R2.",
              )}
            />
            <Slot was={was} now={now} k={rollKey} />
            <span dangerouslySetInnerHTML={hl("(bucket);")} />
          </span>
          {"\n"}
          <span
            dangerouslySetInnerHTML={hl(
              "    return {\n      list: () => photos.list(),\n",
            )}
          />
          <span className={`tp-line ${error ? "is-error" : ""}`}>
            <span
              dangerouslySetInnerHTML={hl(
                "      upload: (name, body) => photos.",
              )}
            />
            <span
              className={error ? "tp-squiggle" : ""}
              dangerouslySetInnerHTML={hl("put")}
            />
            <span dangerouslySetInnerHTML={hl("(name, body),")} />
          </span>
          {"\n"}
          <span className={`tp-diag ${error ? "is-shown" : ""}`}>
            <span className="tp-diag__x">✗</span> {ERROR}
          </span>
          <span dangerouslySetInnerHTML={hl("    };\n  }),\n);")} />
        </pre>
      </div>

      <div className="tp-type">
        <div className="tp-type__head">
          <span className="tp-muted">photos:</span>{" "}
          <Slot was={wasClient} now={client} k={rollKey} />
        </div>
        <div className="tp-group">
          <div className="tp-group__label">read</div>
          {READ.map((m) => (
            <div key={m} className="tp-method">
              <span className="tp-method__mark">✓</span>
              {m}
            </div>
          ))}
        </div>
        <div className={`tp-group ${readOnly ? "is-revoked" : ""}`}>
          <div className="tp-group__label">
            write
            <span className="tp-group__note">
              {readOnly ? "not granted" : ""}
            </span>
          </div>
          {WRITE.map((m) => (
            <div
              key={m}
              className={`tp-method ${m === "put" && error ? "is-used" : ""}`}
            >
              <span className="tp-method__mark">{readOnly ? "✗" : "✓"}</span>
              {m}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
