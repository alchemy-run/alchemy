//! A ~100 second teaser for Alchemy, following the arc of the "Infrastructure as
//! Effects" talk: infrastructure as code, two programs that are really one, a cloud
//! language with two phases, Effect's Req as the missing type, and the agentic loop.
//!
//! Every scene is a struct that draws one SVG tree per frame. Times inside a scene
//! are seconds from the scene's start.
use fframes::{
    AnimateRuntimeInput, AudioMap, Color, Duration, FFramesContext, Frame, Overlap, Scene, Scenes,
    Svgr, Transform, Video,
    animation::{AnimationRuntime, Easing},
    include_media_dir,
};
use std::sync::LazyLock;

include_media_dir!(pub struct AlchemyTeaserMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;

// The Alchemy brand, dark mode (website/src/styles/tokens.css).
const BG: &str = "#14110d";
const CARD: &str = "#221e18";
const LINE: &str = "#3a3328";
const FG: &str = "#faf6ec";
const MUTED: &str = "#a89572";
const MOSS: &str = "#a3c473";
const EMBER: &str = "#d8835a";
const RED: &str = "#f14c4c";
const GREEN_BG: &str = "#1f3a22";
const RED_BG: &str = "#3d1f1c";

// Syntax colours, VS Code dark.
const KW: &str = "#c586c0";
const FN: &str = "#dcdcaa";
const TY: &str = "#4ec9b0";
const STR: &str = "#ce9178";
const VAR: &str = "#9cdcfe";
const PUN: &str = "#d4d4d4";

const SANS: &str = "Inter";
const MONO: &str = "JetBrains Mono";
const SERIF: &str = "Source Serif 4";
const HAND: &str = "Caveat";

/// Fast start, long settle.
static SLIDE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.7, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));
static SPRING: LazyLock<AnimationRuntime> = LazyLock::new(|| {
    AnimationRuntime::new(3.0, &Easing::Spring { mass: 1.0, stiffness: 200.0, damping: 22.0 })
});
static FADE: LazyLock<AnimationRuntime> = LazyLock::new(|| AnimationRuntime::new(0.35, &Easing::EaseOut));

/// 0 → 1, easing out over 0.7 s from `at`.
fn ramp(frame: &Frame, at: f32) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: at, from: 0.0, to: 1.0, animation_runtime: &SLIDE })
}
/// 0 → 1 over 0.35 s from `at`.
fn fade(frame: &Frame, at: f32) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: at, from: 0.0, to: 1.0, animation_runtime: &FADE })
}
/// A spring from `from` px to 0 at `at`.
fn rise(frame: &Frame, at: f32, from: f32) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: at, from, to: 0.0, animation_runtime: &SPRING })
}
/// Fades a scene out over its last 0.35 s, so cuts cross-fade with the next one.
fn out(frame: &Frame, length: f32) -> f32 {
    1.0 - fade(frame, length - 0.35)
}

// ─── building blocks ─────────────────────────────────────────────────────────

/// A syntax-highlighted line of code: (text, colour) runs.
type Line = &'static [(&'static str, &'static str)];

/// How a code line looks at this moment.
#[derive(Clone, Copy, PartialEq)]
enum Mark {
    Plain,
    Add,
    Del,
    Dim,
}

/// A code block: lines appear at their own time, marked as a diff when they change.
fn code<'a>(x: f32, y: f32, size: f32, lines: Vec<(Line, f32, Mark)>, frame: &Frame) -> Svgr<'a> {
    code_w(x, y, size, 1400.0, lines, frame)
}

/// `code`, with the diff bars `width` px wide.
fn code_w<'a>(x: f32, y: f32, size: f32, width: f32, lines: Vec<(Line, f32, Mark)>, frame: &Frame) -> Svgr<'a> {
    let lh = size * 1.55;
    let rows: Vec<Svgr> = lines
        .into_iter()
        .enumerate()
        .map(|(i, (runs, at, mark))| {
            let o = fade(frame, at);
            let top = y + i as f32 * lh;
            let (bg, sign, sign_color) = match mark {
                Mark::Add => (GREEN_BG, "+", MOSS),
                Mark::Del => (RED_BG, "-", RED),
                _ => ("none", "", MUTED),
            };
            let text_opacity = if mark == Mark::Dim { 0.35 } else { 1.0 };
            let spans: Vec<Svgr> = runs
                .iter()
                .map(|(t, c)| fframes::svgr!(<tspan fill={*c}>{*t}</tspan>))
                .collect();
            fframes::svgr!(<g opacity={o}>
                <rect x={x - 48.0} y={top - size * 1.1} width={width} height={lh} fill={bg} />
                <text x={x - 34.0} y={top} font-family={MONO} font-size={size} font-weight="700" fill={sign_color}>{sign}</text>
                <text x={x} y={top} font-family={MONO} font-size={size} opacity={text_opacity}>{spans}</text>
            </g>)
        })
        .collect();
    fframes::svgr!(<g>{rows}</g>)
}

/// The big heading at the top of a scene.
fn title<'a>(frame: &Frame, text: &'a str, at: f32) -> Svgr<'a> {
    let o = ramp(frame, at);
    fframes::svgr!(<g opacity={o} transform={Transform::translate(0, rise(frame, at, 24.0))}>
        <text x="160" y="170" font-family={SANS} font-weight="700" font-size="68" letter-spacing="-1.5" fill={FG}>{text}</text>
    </g>)
}

/// A handwritten note.
fn note<'a>(frame: &Frame, x: f32, y: f32, text: &'a str, color: &'a str, at: f32) -> Svgr<'a> {
    let o = fade(frame, at);
    fframes::svgr!(<text x={x} y={y} opacity={o} font-family={HAND} font-weight="700" font-size="54" fill={color}>{text}</text>)
}

/// A rounded "resource" box for architecture diagrams.
fn node<'a>(frame: &Frame, x: f32, y: f32, label: &'a str, color: &'a str, at: f32) -> Svgr<'a> {
    let o = ramp(frame, at);
    let s = 0.92 + 0.08 * o;
    fframes::svgr!(<g opacity={o} transform={format!("translate({x} {y}) scale({s})")}>
        <rect x="-150" y="-52" width="300" height="104" rx="18" fill={CARD} stroke={color} stroke-width="3" />
        <circle cx="-108" cy="0" r="9" fill={color} />
        <text x="-84" y="13" font-family={SANS} font-weight="700" font-size="38" fill={FG}>{label}</text>
    </g>)
}

/// An arrow between two points that draws on from `at`.
fn arrow<'a>(frame: &Frame, x1: f32, y1: f32, x2: f32, y2: f32, color: &'a str, at: f32, label: &'a str) -> Svgr<'a> {
    let p = ramp(frame, at);
    let len = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt();
    let (mx, my) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
    fframes::svgr!(<g>
        <path d={format!("M {x1} {y1} L {x2} {y2}")} stroke={color} stroke-width="3.5" fill="none"
              stroke-dasharray={len} stroke-dashoffset={len * (1.0 - p)} />
        <g opacity={fade(frame, at + 0.35)}>
            <rect x={mx - 150.0} y={my - 26.0} width="300" height="46" rx="23" fill={BG} stroke={color} stroke-width="2" />
            <text x={mx} y={my + 8.0} text-anchor="middle" font-family={MONO} font-size="24" fill={color}>{label}</text>
        </g>
    </g>)
}

/// A terminal window with lines that appear one at a time.
fn terminal<'a>(frame: &Frame, x: f32, y: f32, w: f32, h: f32, lines: Vec<(Line, f32)>) -> Svgr<'a> {
    let rows: Vec<Svgr> = lines
        .into_iter()
        .enumerate()
        .map(|(i, (runs, at))| {
            let spans: Vec<Svgr> = runs.iter().map(|(t, c)| fframes::svgr!(<tspan fill={*c}>{*t}</tspan>)).collect();
            fframes::svgr!(<text x={x + 40.0} y={y + 110.0 + i as f32 * 50.0} opacity={fade(frame, at)}
                font-family={MONO} font-size="32">{spans}</text>)
        })
        .collect();
    fframes::svgr!(<g>
        <rect x={x} y={y} width={w} height={h} rx="18" fill="#1a1814" stroke={LINE} stroke-width="2" />
        <circle cx={x + 34.0} cy={y + 34.0} r="8" fill="#ff5f57" />
        <circle cx={x + 60.0} cy={y + 34.0} r="8" fill="#febc2e" />
        <circle cx={x + 86.0} cy={y + 34.0} r="8" fill="#28c840" />
        {rows}
    </g>)
}

// ─── the video ───────────────────────────────────────────────────────────────

pub struct AlchemyTeaserVideo<'a> {
    pub media: &'a AlchemyTeaserMedia,
}

impl<'a> AlchemyTeaserVideo<'a> {
    pub fn new(media: &'a AlchemyTeaserMedia, _title: &'a str) -> Self {
        Self { media }
    }
}

impl std::fmt::Debug for AlchemyTeaserVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlchemyTeaserVideo").finish()
    }
}

impl Video for AlchemyTeaserVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(vec![
            &Cold as &dyn Scene,
            &Scripts,
            &Declare,
            &Cdk,
            &TwoPrograms,
            &Imagine,
            &Phases,
            &Req,
            &Resource,
            &Binding,
            &Worker,
            &Loop,
            &Swap,
            &Deploy,
            &Logo,
        ])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        // A slow drift keeps holds from looking frozen.
        let drift = frame.animate_loop(&fframes::timeline!(at 0.0 => 12.0, animate 0.0_f32 => 1.0, Easing::Linear));
        let a = (drift * std::f32::consts::TAU).sin() * 90.0;
        let b = (drift * std::f32::consts::TAU).cos() * 70.0;
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <defs>
                    <radialGradient id="moss" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#3a4a24" stop-opacity="0.55" />
                        <stop offset="1" stop-color="#3a4a24" stop-opacity="0" />
                    </radialGradient>
                    <radialGradient id="ember" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#4a2a18" stop-opacity="0.5" />
                        <stop offset="1" stop-color="#4a2a18" stop-opacity="0" />
                    </radialGradient>
                </defs>
                <rect width="1920" height="1080" fill={BG} />
                <g transform={Transform::translate(a, b)}>
                    <ellipse cx="260" cy="180" rx="760" ry="560" fill="url(#moss)" />
                </g>
                <g transform={Transform::translate(-b, a)}>
                    <ellipse cx="1700" cy="980" rx="820" ry="600" fill="url(#ember)" />
                </g>
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

// ─── 1. Cold open (0 – 6s) ───────────────────────────────────────────────────

#[derive(Debug)]
struct Cold;
impl Scene for Cold {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(6.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 6.0);
        let l1 = ramp(&frame, 0.3);
        let l2 = ramp(&frame, 1.6);
        fframes::svgr!(<g opacity={o}>
            <g opacity={l1} transform={Transform::translate(0, rise(&frame, 0.3, 30.0))}>
                <text x="960" y="470" text-anchor="middle" font-family={SERIF} font-weight="600" font-size="112" fill={FG}>"What if your cloud"</text>
            </g>
            <g opacity={l2} transform={Transform::translate(0, rise(&frame, 1.6, 30.0))}>
                <text x="960" y="610" text-anchor="middle" font-family={SERIF} font-weight="600" font-size="112" fill={MOSS}>"was just a program?"</text>
            </g>
        </g>)
    }
}

// ─── 2. Scripts (6 – 14s) ────────────────────────────────────────────────────

const SH1: Line = &[("aws", FN), (" s3api create-bucket ", STR), ("--bucket", VAR), (" uploads", STR)];
const SH_IF: Line = &[("if", KW), (" ! aws s3api head-bucket ", STR), ("--bucket", VAR), (" uploads; ", STR), ("then", KW)];
const SH_IN: Line = &[("  aws", FN), (" s3api create-bucket ", STR), ("--bucket", VAR), (" uploads", STR)];
const SH_FI: Line = &[("fi", KW)];
const SH2: Line = &[("aws", FN), (" s3api put-bucket-versioning ", STR), ("--bucket", VAR), (" uploads", STR)];

#[derive(Debug)]
struct Scripts;
impl Scene for Scripts {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(8.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 8.0) * fade(&frame, 0.0);
        let before = 1.0 - fade(&frame, 3.2);
        let after = fade(&frame, 3.2);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Cloud infrastructure used to be scripts", 0.2)}
            <g opacity={before}>
                {code(240.0, 380.0, 40.0, vec![(SH1, 0.7, Mark::Plain), (SH2, 1.3, Mark::Plain)], &frame)}
                {note(&frame, 240.0, 620.0, "…run it twice and it fails", RED, 2.0)}
            </g>
            <g opacity={after}>
                {code(240.0, 380.0, 40.0, vec![
                    (SH_IF, 3.3, Mark::Add),
                    (SH_IN, 3.3, Mark::Plain),
                    (SH_FI, 3.3, Mark::Add),
                    (SH2, 3.3, Mark::Plain),
                ], &frame)}
                {note(&frame, 240.0, 760.0, "…so every script checks what already exists", MUTED, 4.4)}
            </g>
        </g>)
    }
}

// ─── 3. Declare it (14 – 21s) ────────────────────────────────────────────────

const Y1: Line = &[("Resources", VAR), (":", PUN)];
const Y2: Line = &[("  Uploads", VAR), (":", PUN)];
const Y3: Line = &[("    Type", VAR), (": ", PUN), ("AWS::S3::Bucket", STR)];
const Y4: Line = &[("    Versioning", VAR), (": ", PUN), ("Enabled", STR)];

#[derive(Debug)]
struct Declare;
impl Scene for Declare {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(7.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 7.0) * fade(&frame, 0.0);
        let versioned = fade(&frame, 3.4);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Infrastructure as code declares what should be", 0.2)}
            {code(240.0, 380.0, 44.0, vec![
                (Y1, 0.6, Mark::Plain), (Y2, 0.8, Mark::Plain), (Y3, 1.0, Mark::Plain), (Y4, 3.2, Mark::Add),
            ], &frame)}
            {node(&frame, 1420.0, 470.0, "Bucket", "#8b7cf6", 1.8)}
            <g opacity={versioned}>
                <text x="1420" y="570" text-anchor="middle" font-family={MONO} font-size="28" fill={MOSS}>"versioning: on"</text>
            </g>
            {note(&frame, 1230.0, 700.0, "an engine makes it so", MOSS, 4.2)}
        </g>)
    }
}

// ─── 4. The CDK (21 – 28s) ───────────────────────────────────────────────────

const C1: Line = &[("const", KW), (" uploads = ", VAR), ("new", KW), (" s3.", VAR), ("Bucket", TY), ("(", PUN), ("this", KW), (", ", PUN), ("\"Uploads\"", STR), (");", PUN)];
const C2: Line = &[("const", KW), (" fn = ", VAR), ("new", KW), (" lambda.", VAR), ("Function", TY), ("(", PUN), ("this", KW), (", ", PUN), ("\"Fn\"", STR), (", { … });", PUN)];
const C3: Line = &[("uploads.", VAR), ("grantReadWrite", FN), ("(fn);", PUN)];

#[derive(Debug)]
struct Cdk;
impl Scene for Cdk {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(7.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 7.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Then the CDK let us write it in real code", 0.2)}
            {code(240.0, 400.0, 38.0, vec![(C1, 0.7, Mark::Plain), (C2, 1.1, Mark::Plain), (C3, 1.5, Mark::Plain)], &frame)}
            {note(&frame, 240.0, 640.0, "…but it just generated YAML", EMBER, 3.4)}
        </g>)
    }
}

// ─── 5. Two programs (28 – 36s) ──────────────────────────────────────────────

const H1: Line = &[("export const", KW), (" handler = ", VAR), ("async", KW), (" (event) => {", PUN)];
const H2: Line = &[("  await", KW), (" s3.", VAR), ("send", FN), ("(", PUN), ("new", KW), (" ", PUN), ("PutObjectCommand", TY), ("({", PUN)];
const H3: Line = &[("    Bucket", VAR), (": process.env.", PUN), ("BUCKET_NAME", VAR), (",", PUN)];
const H4: Line = &[("  }));", PUN)];

#[derive(Debug)]
struct TwoPrograms;
impl Scene for TwoPrograms {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(8.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 8.0) * fade(&frame, 0.0);
        let link = ramp(&frame, 2.4);
        let len = 820.0_f32;
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "But the code that runs lived somewhere else", 0.2)}
            <text x="160" y="330" font-family={MONO} font-size="24" fill={MUTED}>"infra/api.ts"</text>
            {code(160.0, 400.0, 24.0, vec![(C1, 0.5, Mark::Plain), (C2, 0.5, Mark::Plain), (C3, 0.5, Mark::Plain)], &frame)}
            <text x="1080" y="330" font-family={MONO} font-size="24" fill={MUTED} opacity={fade(&frame, 1.1)}>"src/handler.ts"</text>
            {code(1080.0, 400.0, 24.0, vec![(H1, 1.1, Mark::Plain), (H2, 1.1, Mark::Plain), (H3, 1.1, Mark::Plain), (H4, 1.1, Mark::Plain)], &frame)}
            <path d="M 420 482 C 700 540, 900 560, 1150 482" stroke={EMBER} stroke-width="3" fill="none"
                  stroke-dasharray={len} stroke-dashoffset={len * (1.0 - link)} />
            {note(&frame, 560.0, 760.0, "two programs, kept in sync by hand", EMBER, 3.6)}
        </g>)
    }
}

// ─── 6. Imagine (36 – 44s) ───────────────────────────────────────────────────

const I1: Line = &[("const", KW), (" bucket = ", VAR), ("Bucket", TY), ("()", PUN)];
const I2: Line = &[("const", KW), (" queue = ", VAR), ("Queue", TY), ("()", PUN)];
const I3: Line = &[("function", KW), (" ", PUN), ("api", FN), ("(req) {", PUN)];
const I4: Line = &[("  const", KW), (" file = bucket.", VAR), ("get", FN), ("(req.key)", PUN)];
const I5: Line = &[("  queue.", VAR), ("send", FN), ("(file)", PUN)];
const I6: Line = &[("}", PUN)];

#[derive(Debug)]
struct Imagine;
impl Scene for Imagine {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(8.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 8.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "What if one language did both?", 0.2)}
            {code(180.0, 380.0, 34.0, vec![
                (I1, 0.6, Mark::Plain), (I2, 1.0, Mark::Plain), (I3, 1.6, Mark::Plain),
                (I4, 1.9, Mark::Plain), (I5, 2.2, Mark::Plain), (I6, 1.6, Mark::Plain),
            ], &frame)}
            {node(&frame, 1620.0, 360.0, "Bucket", "#8b7cf6", 0.9)}
            {node(&frame, 1620.0, 760.0, "Queue", "#e0a86b", 1.3)}
            {node(&frame, 1110.0, 560.0, "api", "#f38020", 1.8)}
            {arrow(&frame, 1260.0, 520.0, 1470.0, 400.0, MOSS, 2.9, "s3:GetObject")}
            {arrow(&frame, 1260.0, 600.0, 1470.0, 720.0, MOSS, 3.5, "sqs:SendMessage")}
            {note(&frame, 960.0, 920.0, "permissions, worked out from the code", MOSS, 4.4)}
        </g>)
    }
}

// ─── 7. Two phases (44 – 51s) ────────────────────────────────────────────────

#[derive(Debug)]
struct Phases;
impl Scene for Phases {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(7.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 7.0) * fade(&frame, 0.0);
        let c = fade(&frame, 1.0);
        let r = fade(&frame, 2.4);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "A cloud program has two phases", 0.2)}
            <g opacity={c}>
                <rect x="190" y="340" width="1540" height="150" rx="14" fill={MOSS} fill-opacity="0.13" />
                <text x="1700" y="378" text-anchor="end" font-family={MONO} font-size="26" fill={MOSS}>"construct · at deploy"</text>
            </g>
            <g opacity={r}>
                <rect x="190" y="500" width="1540" height="248" rx="14" fill={EMBER} fill-opacity="0.13" />
                <text x="1700" y="538" text-anchor="end" font-family={MONO} font-size="26" fill={EMBER}>"runtime · every request"</text>
            </g>
            {code(240.0, 410.0, 40.0, vec![
                (I1, 0.0, Mark::Plain), (I2, 0.0, Mark::Plain), (I3, 0.0, Mark::Plain),
                (I4, 0.0, Mark::Plain), (I5, 0.0, Mark::Plain), (I6, 0.0, Mark::Plain),
            ], &frame)}
            {note(&frame, 240.0, 880.0, "mix them up, and it shouldn't compile", MUTED, 3.8)}
        </g>)
    }
}

// ─── 8. Req (51 – 58s) ───────────────────────────────────────────────────────

#[derive(Debug)]
struct Req;
impl Scene for Req {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(7.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 7.0) * fade(&frame, 0.0);
        let t = ramp(&frame, 0.5);
        let req = ramp(&frame, 2.0);
        let s = 0.9 + 0.1 * t;
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Effect already has the type for that", 0.2)}
            <g opacity={t} transform={format!("translate(960 600) scale({s})")}>
                <text x="0" y="0" text-anchor="middle" font-family={MONO} font-size="150" fill={FG}>
                    <tspan fill={TY}>"Effect"</tspan><tspan fill={PUN}>"<A, Err, "</tspan><tspan fill={TY}>"Req"</tspan><tspan fill={PUN}>">"</tspan>
                </text>
            </g>
            <g opacity={req}>
                <ellipse cx="1580" cy="552" rx="170" ry="92" fill="none" stroke={MOSS} stroke-width="5" />
                <text x="1580" y="760" text-anchor="middle" font-family={HAND} font-weight="700" font-size="64" fill={MOSS}>"what it needs"</text>
            </g>
        </g>)
    }
}

// ─── 9. A resource (58 – 64s) ────────────────────────────────────────────────

const A1: Line = &[("const", KW), (" api = ", VAR), ("Effect", TY), (".", PUN), ("gen", FN), ("(", PUN), ("function", KW), ("* () {", PUN)];
const A2: Line = &[("  const", KW), (" bucket = ", VAR), ("yield", KW), ("* R2.", VAR), ("Bucket", TY), ("(", PUN), ("\"Uploads\"", STR), (");", PUN)];
const A3: Line = &[("  const", KW), (" uploads = ", VAR), ("yield", KW), ("* R2.", VAR), ("ReadBucket", TY), ("(bucket);", PUN)];
const A4: Line = &[("  return", KW), (" {", PUN)];
const A5: Line = &[("    fetch", VAR), (": ", PUN), ("Effect", TY), (".", PUN), ("gen", FN), ("(", PUN), ("function", KW), ("* () {", PUN)];
const A6: Line = &[("      return", KW), (" ", PUN), ("yield", KW), ("* uploads.", VAR), ("get", FN), ("(", PUN), ("\"hello.txt\"", STR), (");", PUN)];
const A7: Line = &[("    }),", PUN)];
const A8: Line = &[("  };", PUN)];
const A9: Line = &[("});", PUN)];

/// The Req list on the right: names with a note, each at its own time.
fn req_list<'a>(frame: &Frame, items: Vec<(&'a str, &'a str, f32, bool)>) -> Svgr<'a> {
    let rows: Vec<Svgr> = items
        .into_iter()
        .enumerate()
        .map(|(i, (name, why, at, met))| {
            let y = 420.0 + i as f32 * 90.0;
            let color = if met { MOSS } else { TY };
            fframes::svgr!(<g opacity={fade(frame, at)} transform={Transform::translate(rise(frame, at, 16.0), 0)}>
                <text x="1300" y={y} font-family={MONO} font-size="38" fill={color} text-decoration={if met { "line-through" } else { "none" }}>
                    <tspan fill={PUN}>"| "</tspan>{name}
                </text>
                <text x="1300" y={y + 36.0} font-family={SANS} font-weight="500" font-size="24" fill={MUTED}>{why}</text>
            </g>)
        })
        .collect();
    fframes::svgr!(<g>
        <text x="1300" y="340" font-family={MONO} font-size="26" fill={MUTED}>"Req · what it needs"</text>
        {rows}
    </g>)
}

#[derive(Debug)]
struct Resource;
impl Scene for Resource {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(6.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 6.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "In Alchemy, a program is an Effect", 0.2)}
            {code_w(200.0, 380.0, 32.0, 1040.0, vec![
                (A1, 0.5, Mark::Plain), (A2, 1.4, Mark::Add), (A4, 0.5, Mark::Plain), (A5, 0.5, Mark::Plain),
                (A7, 0.5, Mark::Plain), (A8, 0.5, Mark::Plain), (A9, 0.5, Mark::Plain),
            ], &frame)}
            {note(&frame, 200.0, 760.0, "a resource is just data", MOSS, 2.6)}
            {req_list(&frame, vec![("R2.BucketProvider", "to create the bucket", 1.9, false)])}
        </g>)
    }
}

// ─── 10. A binding (64 – 71s) ────────────────────────────────────────────────

#[derive(Debug)]
struct Binding;
impl Scene for Binding {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(7.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 7.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Using it is just another requirement", 0.2)}
            {code_w(200.0, 380.0, 32.0, 1040.0, vec![
                (A1, 0.0, Mark::Dim), (A2, 0.0, Mark::Dim), (A3, 0.6, Mark::Add), (A4, 0.0, Mark::Dim),
                (A5, 0.0, Mark::Dim), (A6, 1.8, Mark::Add), (A7, 0.0, Mark::Dim), (A8, 0.0, Mark::Dim), (A9, 0.0, Mark::Dim),
            ], &frame)}
            {req_list(&frame, vec![
                ("R2.BucketProvider", "to create the bucket", 0.0, false),
                ("R2.ReadBucket", "to read it at runtime", 1.0, false),
            ])}
            {note(&frame, 200.0, 880.0, "the compiler won't let you forget", MOSS, 3.2)}
        </g>)
    }
}

// ─── 11. Worker (71 – 77s) ───────────────────────────────────────────────────

const W1: Line = &[("export default", KW), (" Cloudflare.", VAR), ("Worker", TY), ("(", PUN), ("\"Api\"", STR), (", {…},", PUN)];
const W2: Line = &[("  Effect", TY), (".", PUN), ("gen", FN), ("(", PUN), ("function", KW), ("* () { … })", PUN)];
const W3: Line = &[("    .", PUN), ("pipe", FN), ("(", PUN), ("Effect", TY), (".", PUN), ("provide", FN), ("(", PUN), ("ReadBucketBinding", TY), (")),", PUN)];
const W4: Line = &[(");", PUN)];

#[derive(Debug)]
struct Worker;
impl Scene for Worker {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(6.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 6.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Provide a Layer, and it runs in a Worker", 0.2)}
            {code_w(200.0, 420.0, 34.0, 1040.0, vec![
                (W1, 0.5, Mark::Add), (W2, 0.5, Mark::Plain), (W3, 1.3, Mark::Add), (W4, 0.5, Mark::Add),
            ], &frame)}
            {req_list(&frame, vec![
                ("R2.BucketProvider", "the Stack, at deploy", 0.0, false),
                ("R2.ReadBucket", "ReadBucketBinding", 1.6, true),
            ])}
            {note(&frame, 200.0, 760.0, "the binding grants the permission, and nothing more", MOSS, 2.8)}
        </g>)
    }
}

// ─── 12. The agentic loop (77 – 86s) ─────────────────────────────────────────

const T1: Line = &[("$ ", MUTED), ("tsc --noEmit", FG)];
const T2: Line = &[("src/Api.ts:21:44", RED), (" - error TS2322", RED)];
const T3: Line = &[("  Type 'LinkStoreError' is not assignable to type 'never'.", FG)];
const T4: Line = &[("✓ ", MOSS), ("no errors", FG)];
const T5: Line = &[("$ ", MUTED), ("bun test", FG), ("   # dev: true, local in seconds", MUTED)];
const T6: Line = &[("✓ ", MOSS), ("creates and reads back a link ", FG), ("(38ms)", MUTED)];
const T7: Line = &[("✓ ", MOSS), ("a missing link is a typed LinkNotFound ", FG), ("(9ms)", MUTED)];
const T8: Line = &[("3 pass", MOSS), (" · 0 fail · 1.4s", MUTED)];

#[derive(Debug)]
struct Loop;
impl Scene for Loop {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(9.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 9.0) * fade(&frame, 0.0);
        let first = 1.0 - fade(&frame, 3.6);
        let second = fade(&frame, 3.6);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "An agent's fastest loop: types, then tests", 0.2)}
            <g opacity={first}>
                {terminal(&frame, 190.0, 290.0, 1540.0, 460.0, vec![(T1, 0.6), (T2, 1.2), (T3, 1.4)])}
            </g>
            <g opacity={second}>
                {terminal(&frame, 190.0, 290.0, 1540.0, 460.0, vec![(T1, 3.7), (T4, 4.1), (T5, 4.9), (T6, 5.7), (T7, 5.9), (T8, 6.4)])}
            </g>
            {note(&frame, 190.0, 880.0, "the errors are in the types, so the agent can see them", MOSS, 2.0)}
        </g>)
    }
}

// ─── 13. Swap the infrastructure (86 – 92s) ──────────────────────────────────

const L1: Line = &[("  }).", PUN), ("pipe", FN), ("(", PUN), ("Effect", TY), (".", PUN), ("provide", FN), ("(LinksSql.", PUN), ("pipe", FN), ("(", PUN), ("Layer", TY), (".", PUN), ("provide", FN), ("(", PUN), ("D1Storage", TY), ("))))", PUN)];
const L2: Line = &[("  }).", PUN), ("pipe", FN), ("(", PUN), ("Effect", TY), (".", PUN), ("provide", FN), ("(LinksSql.", PUN), ("pipe", FN), ("(", PUN), ("Layer", TY), (".", PUN), ("provide", FN), ("(", PUN), ("NeonStorage", TY), ("))))", PUN)];

#[derive(Debug)]
struct Swap;
impl Scene for Swap {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(6.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 6.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "Swap the infrastructure, keep the code", 0.2)}
            {code(200.0, 460.0, 34.0, vec![(L1, 0.6, Mark::Del), (L2, 1.4, Mark::Add)], &frame)}
            {node(&frame, 620.0, 740.0, "D1", "#f38020", 0.6)}
            <g opacity={fade(&frame, 1.4)}>
                <text x="960" y="755" text-anchor="middle" font-family={SANS} font-weight="700" font-size="54" fill={MUTED}>"→"</text>
            </g>
            {node(&frame, 1300.0, 740.0, "Postgres", "#63b3ed", 1.6)}
            {note(&frame, 200.0, 920.0, "one Layer, same tests", MOSS, 2.6)}
        </g>)
    }
}

// ─── 14. Deploy (92 – 98s) ───────────────────────────────────────────────────

const D1L: Line = &[("$ ", MUTED), ("alchemy deploy --stage prod", FG)];
const D2: Line = &[("✓ ", MOSS), ("Postgres ", FG), ("(Neon.Project)", MUTED), (" created", FG)];
const D3: Line = &[("✓ ", MOSS), ("Pool ", FG), ("(Cloudflare.Hyperdrive)", MUTED), (" created", FG)];
const D4: Line = &[("✓ ", MOSS), ("Api ", FG), ("(Cloudflare.Worker)", MUTED), (" created", FG)];
const D5: Line = &[("✓ ", MOSS), ("Web ", FG), ("(Cloudflare.Website)", MUTED), (" created", FG)];
const D6: Line = &[("Stack deployed (4/4)", MOSS)];

#[derive(Debug)]
struct Deploy;
impl Scene for Deploy {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(6.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = out(&frame, 6.0) * fade(&frame, 0.0);
        fframes::svgr!(<g opacity={o}>
            {title(&frame, "One command to production", 0.2)}
            {terminal(&frame, 190.0, 290.0, 1540.0, 480.0, vec![
                (D1L, 0.5), (D2, 1.3), (D3, 1.7), (D4, 2.1), (D5, 2.5), (D6, 3.2),
            ])}
        </g>)
    }
}

// ─── 15. Logo (98 – 104s) ────────────────────────────────────────────────────

#[derive(Debug)]
struct Logo;
impl Scene for Logo {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(6.0)
    }
    fn overlap(&self) -> Overlap {
        Overlap::Previous(0.35)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let o = fade(&frame, 0.0);
        let w = ramp(&frame, 0.3);
        let t = ramp(&frame, 1.2);
        let u = fade(&frame, 2.2);
        fframes::svgr!(<g opacity={o}>
            <g opacity={w} transform={Transform::translate(0, rise(&frame, 0.3, 30.0))}>
                <text x="960" y="500" text-anchor="middle" font-family={SERIF} font-weight="600" font-size="190" letter-spacing="-4" fill={FG}>"Alchemy"</text>
            </g>
            <g opacity={t}>
                <text x="960" y="610" text-anchor="middle" font-family={SANS} font-weight="500" font-size="54" fill={MOSS}>"Infrastructure as Effects"</text>
            </g>
            <g opacity={u}>
                <text x="960" y="760" text-anchor="middle" font-family={MONO} font-size="38" fill={MUTED}>"alchemy.run"</text>
            </g>
        </g>)
    }
}
