import { useEffect, useRef, useState } from "react";
import { RollTemplate } from "./_roll";
import { sleep } from "./_terminal";

/*
 * The Photos module, cycling through its Layer on each provider: the same
 * service, a different resource and binding. Every variant fills the same
 * slots of one template, so the line count never changes and only the
 * slotted values roll.
 *
 * ⟨0⟩ the Layer, ⟨1⟩ the resource, ⟨2⟩ what the binding grants, ⟨3⟩ the
 * binding, ⟨4⟩ the call that stores the photo.
 */
const TEMPLATE = `export class Photos extends Context.Service<Photos, {
  upload(name: string, body: string): Effect.Effect<void>;
}>()("Photos") {}

export const ⟨0⟩ = Layer.effect(
  Photos,
  Effect.gen(function* () {
    // resource
    const bucket = yield* ⟨1⟩("Photos");
    ⟨2⟩
    const photos = yield* ⟨3⟩(bucket);
    // API
    return {
      upload: (name, body) => ⟨4⟩,
    };
  }),
);`;

const PUT = "photos.put(name, body)";
const PUT_OBJECT = "photos({ Key: name, Body: body })";

// The Layer names match the hero's (heroHosts.ts).
const VARIANTS: string[][] = [
  [
    "PhotosR2",
    "Cloudflare.R2.Bucket",
    "// binding: read/write access for this Worker only",
    "Cloudflare.R2.ReadWriteBucket",
    PUT,
  ],
  [
    "PhotosS3",
    "AWS.S3.Bucket",
    "// binding: s3:PutObject on this bucket only",
    "AWS.S3.PutObject",
    PUT_OBJECT,
  ],
  [
    "PhotosGCS",
    "GCP.Storage.Bucket",
    "// binding: roles/storage.objectUser on this bucket",
    "GCP.Storage.ReadWriteBucket",
    PUT,
  ],
  [
    "PhotosTigris",
    "Fly.Bucket",
    "// binding: write access to this bucket only",
    "Fly.PutObject",
    PUT_OBJECT,
  ],
  [
    "PhotosRailway",
    "Railway.Bucket",
    "// binding: write access to this bucket only",
    "Railway.PutObject",
    PUT_OBJECT,
  ],
  [
    "PhotosNeon",
    "Neon.Bucket",
    "// binding: read/write access to this bucket only",
    "Neon.ReadWriteBucket",
    PUT,
  ],
];

const SEGMENTS = TEMPLATE.split(/⟨(\d)⟩/);
// The widest line of any variant, so the card never resizes as values roll.
const WIDTH = Math.max(
  ...VARIANTS.flatMap((v) =>
    TEMPLATE.replace(/⟨(\d)⟩/g, (_, i: string) => v[+i]!)
      .split("\n")
      .map((l) => l.length),
  ),
);
const DWELL_MS = 2600;

export default function PhotosLayers() {
  const ref = useRef<HTMLDivElement>(null);
  const [roll, setRoll] = useState({ i: 0, was: VARIANTS[0]!, n: 0 });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let i = 0; !cancelled;) {
        await sleep(DWELL_MS);
        if (cancelled) return;
        const was = VARIANTS[i]!;
        i = (i + 1) % VARIANTS.length;
        setRoll((r) => ({ i, was, n: r.n + 1 }));
      }
    };
    // Start cycling once the card scrolls into view.
    const obs = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        obs.disconnect();
        void run();
      },
      { threshold: 0.25 },
    );
    if (ref.current) obs.observe(ref.current);
    return () => {
      cancelled = true;
      obs.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="alc-code-block alc-code-block--compact">
      <div className="alc-code-block__header">
        <span className="alc-code-block__dot" style={{ background: "var(--alc-danger)" }} />
        <span className="alc-code-block__dot" style={{ background: "var(--alc-warn)" }} />
        <span className="alc-code-block__dot" style={{ background: "var(--alc-accent-bright)" }} />
        <span className="alc-code-block__filename">src/Photos.ts</span>
      </div>
      <pre className="alc-code-block__pre" tabIndex={0} aria-label="src/Photos.ts source">
        <span style={{ display: "inline-block", minWidth: `${WIDTH}ch` }}>
          <RollTemplate segments={SEGMENTS} was={roll.was} now={VARIANTS[roll.i]!} n={roll.n} />
        </span>
      </pre>
    </div>
  );
}
