//! Alchemy, the high-motion cut. 101 seconds at 128 BPM: every slam, cut, flash and
//! zoom lands on a beat of `media/music.mp3` (synthesized by `scripts/music.sh`).
//!
//! Scenes are whole bars long, so beat math inside a scene matches the music.
//! A GPU shader draws the living background; the kick punches the camera.
use fframes::{
    AnimateRuntimeInput, AudioMap, AudioTimestamp::*, AudioTrack, Color, Duration, FFramesContext,
    Frame, Scene, Scenes, Shader, ShaderUniforms, Svgr, Video,
    animation::{AnimationRuntime, Easing},
    include_media_dir,
};
use std::sync::LazyLock;

include_media_dir!(pub struct AlchemyTeaserMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;

/// 128 BPM.
const BEAT: f32 = 60.0 / 128.0;
const BAR: f32 = BEAT * 4.0;

const BG: &str = "#14110d";
const FG: &str = "#faf6ec";
const MUTED: &str = "#a89572";
const MOSS: &str = "#a3c473";
const EMBER: &str = "#d8835a";
const RED: &str = "#f14c4c";
const TEAL: &str = "#4ec9b0";
const CARD: &str = "#221e18";

const KW: &str = "#c586c0";
const FN: &str = "#dcdcaa";
const STR: &str = "#ce9178";
const VAR: &str = "#9cdcfe";
const PUN: &str = "#d4d4d4";

const DISPLAY: &str = "Inter";
const MONO: &str = "JetBrains Mono";

static SNAP: LazyLock<AnimationRuntime> = LazyLock::new(|| {
    AnimationRuntime::new(3.0, &Easing::Spring { mass: 1.0, stiffness: 520.0, damping: 24.0 })
});
static BOUNCE: LazyLock<AnimationRuntime> = LazyLock::new(|| {
    AnimationRuntime::new(3.0, &Easing::Spring { mass: 1.0, stiffness: 300.0, damping: 14.0 })
});
static POP: LazyLock<AnimationRuntime> = LazyLock::new(|| AnimationRuntime::new(0.08, &Easing::EaseOut));
static WHIP: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.18, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));

fn b(beats: f32) -> f32 {
    beats * BEAT
}

/// A stable pseudo-random number in 0..1.
fn hash(n: u32) -> f32 {
    let mut x = n.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    x = ((x >> ((x >> 28) + 4)) ^ x).wrapping_mul(277_803_737);
    (((x >> 22) ^ x) as f32) / (u32::MAX as f32)
}

fn spring(frame: &Frame, at: f32, from: f32, to: f32, rt: &AnimationRuntime) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: at, from, to, animation_runtime: rt })
}

/// Decays from 1 at `at` (a hit), 0 before it.
fn hit(t: f32, at: f32, rate: f32) -> f32 {
    if t < at { 0.0 } else { (-(t - at) * rate).exp() }
}

/// Text that slams in from far away, with RGB-split trails that settle.
#[allow(clippy::too_many_arguments)]
fn slam<'a>(frame: &Frame, at: f32, x: f32, y: f32, text: impl Into<String>, size: f32, color: &'a str, anchor: &'a str) -> Svgr<'a> {
    let t = frame.seconds();
    if t < at {
        return Svgr::empty();
    }
    let text: String = text.into();
    let s = spring(frame, at, 2.8, 1.0, &SNAP);
    let o = spring(frame, at, 0.0, 1.0, &POP);
    let g = hit(t, at, 7.0);
    let jx = g * 22.0 * (hash(frame.index as u32 * 31 + 7) * 2.0 - 1.0);
    let jy = g * 10.0 * (hash(frame.index as u32 * 17 + 3) * 2.0 - 1.0);
    fframes::svgr!(<g transform={format!("translate({x} {y}) scale({s})")} opacity={o}
        font-family={DISPLAY} font-weight="900" font-size={size} text-anchor={anchor} letter-spacing={-size * 0.03}>
        <text x={-jx - g * 14.0} y={jy} fill={EMBER} opacity={g * 0.85}>{text.clone()}</text>
        <text x={jx + g * 14.0} y={-jy} fill={TEAL} opacity={g * 0.85}>{text.clone()}</text>
        <text x={jx * 0.3} y="0" fill={color}>{text}</text>
    </g>)
}

/// A line of code, typed out to `n` characters.
type Line = &'static [(&'static str, &'static str)];
fn typed<'a>(runs: Line, n: usize) -> Vec<Svgr<'a>> {
    let mut left = n;
    let mut out = vec![];
    for (text, color) in runs.iter() {
        if left == 0 {
            break;
        }
        let take = text.chars().count().min(left);
        let s: String = text.chars().take(take).collect();
        left -= take;
        out.push(fframes::svgr!(<tspan fill={*color}>{s}</tspan>));
    }
    out
}
fn line_len(runs: Line) -> usize {
    runs.iter().map(|(t, _)| t.chars().count()).sum()
}

/// A full-screen flash.
fn flash<'a>(opacity: f32, color: &'a str) -> Svgr<'a> {
    fframes::svgr!(<rect width="1920" height="1080" fill={color} opacity={opacity.clamp(0.0, 1.0)} />)
}

// ─── the video ───────────────────────────────────────────────────────────────

const BACKGROUND: &str = "
uniform float3 iResolution;
uniform float iTime;
uniform float uPulse;
uniform float uEnergy;

half4 main(float2 coord) {
  float2 uv = (coord - 0.5 * iResolution.xy) / iResolution.y;
  float t = iTime * 0.35;
  float r = length(uv);
  float v = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    v += sin(uv.x * (2.0 + fi) * 1.7 + t * (1.0 + fi * 0.3) + sin(uv.y * 3.0 + t * 1.3 + fi));
  }
  v *= 0.25;
  float3 moss = float3(0.64, 0.77, 0.45);
  float3 ember = float3(0.85, 0.51, 0.35);
  float3 bg = float3(0.078, 0.067, 0.051);
  float3 col = mix(moss, ember, smoothstep(-0.7, 0.7, v + uv.x * 0.8));
  float glow = (0.10 + 0.30 * uEnergy) * (0.6 + 0.4 * v) * exp(-r * 1.3);
  glow += uPulse * uEnergy * 0.22 * exp(-r * 2.2);
  float rings = sin(r * 22.0 - iTime * 5.0) * 0.5 + 0.5;
  float3 c = bg + col * glow + col * rings * 0.035 * uEnergy * exp(-r * 1.6);
  float2 g = abs(fract(uv * 7.0 + float2(0.0, iTime * 0.25 * uEnergy)) - 0.5);
  c += moss * smoothstep(0.475, 0.5, max(g.x, g.y)) * 0.06 * uEnergy * exp(-r * 1.1);
  c *= 1.0 - 0.5 * r * r;
  return half4(c, 1.0);
}
";

pub struct AlchemyTeaserVideo<'a> {
    pub media: &'a AlchemyTeaserMedia,
    background: Shader,
}

impl<'a> AlchemyTeaserVideo<'a> {
    pub fn new(media: &'a AlchemyTeaserMedia, _title: &'a str) -> Self {
        Self { media, background: Shader::sksl(BACKGROUND) }
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
        AudioMap::from([AudioTrack::new("music.mp3", Second(0.)..Eof).fade_out(1.2)])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(vec![
            &Ignite as &dyn Scene,
            &Pain,
            &OneProgram,
            &Graph,
            &Riser,
            &Drop,
            &Loop,
            &Swap,
            &Ticker,
            &Finale,
        ])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let bar = t / BAR;
        let energy = match bar {
            x if x < 4.0 => 0.25,
            x if x < 12.0 => 0.55,
            x if x < 16.0 => 0.7,
            x if x < 17.0 => 0.7 + (x - 16.0) * 0.3,
            x if x < 49.0 => 1.0,
            _ => 0.9,
        };
        let kick = (4.0..16.0).contains(&bar) || (17.0..49.0).contains(&bar);
        let pulse = if kick { (-(t % BEAT) * 9.0).exp() } else { 0.0 } + hit(t, 49.0 * BAR, 2.0);
        // The kick punches the camera.
        let punch = 1.0 + 0.022 * pulse.min(1.0);
        let layer = self.background.draw(
            &frame,
            ShaderUniforms::new().float("uPulse", pulse.min(1.0)).float("uEnergy", energy),
        );
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <defs>
                    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
                        <rect width="4" height="1" fill="#000" opacity="0.18" />
                    </pattern>
                </defs>
                <rect width="1920" height="1080" fill={BG} />
                <image href={layer.href()} x="0" y="0" width="1920" height="1080" />
                <g transform={format!("translate(960 540) scale({punch}) translate(-960 -540)")}>
                    {ctx.render_scenes(&frame)}
                </g>
                <rect width="1920" height="1080" fill="url(#scan)" />
            </svg>
        )
    }
}

// ─── 1. Ignite · bars 0–3 · pad ──────────────────────────────────────────────

#[derive(Debug)]
struct Ignite;
impl Scene for Ignite {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 4.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        // A prompt types itself, then ALCHEMY assembles letter by letter.
        let prompt = "$ alchemy";
        let n = ((t - 0.4) / 0.09).clamp(0.0, prompt.len() as f32) as usize;
        let cursor = if (t * 2.2) as i32 % 2 == 0 { 1.0 } else { 0.0 };
        let prompt_o = 1.0 - spring(&frame, b(8.0), 0.0, 1.0, &WHIP);
        const WIDTHS: [f32; 7] = [174.0, 142.0, 178.0, 186.0, 150.0, 222.0, 168.0];
        let total: f32 = WIDTHS.iter().sum();
        let letters: Vec<Svgr> = "ALCHEMY"
            .chars()
            .enumerate()
            .map(|(i, c)| {
                let at = b(8.0) + i as f32 * 0.09;
                let x = 960.0 - total / 2.0 + WIDTHS[..i].iter().sum::<f32>() + WIDTHS[i] / 2.0;
                let flicker = if t < at + 0.25 && hash(frame.index as u32 * 13 + i as u32) > 0.5 { 0.2 } else { 1.0 };
                let dy = spring(&frame, at, -140.0 * (if i % 2 == 0 { 1.0 } else { -1.0 }), 0.0, &BOUNCE);
                fframes::svgr!(<g opacity={if t < at { 0.0 } else { flicker }}>
                    {slam(&frame, at, x, 600.0 + dy, c.to_string(), 250.0, FG, "middle")}
                </g>)
            })
            .collect();
        // The scan line and a flash into the kick.
        let scan = (t / BAR * 2.0).fract() * 1080.0;
        let build = ((t - b(14.0)) / b(2.0)).clamp(0.0, 1.0).powi(3);
        fframes::svgr!(<g>
            <rect x="0" y={scan} width="1920" height="2" fill={MOSS} opacity="0.35" />
            <g opacity={prompt_o}>
                <text x="760" y="560" font-family={MONO} font-size="64" fill={FG}>{prompt[..n].to_string()}</text>
                <rect x={760.0 + n as f32 * 38.4 + 6.0} y="510" width="34" height="64" fill={MOSS} opacity={cursor} />
            </g>
            {letters}
            <g opacity={fade_in(t, b(12.0))}>
                <text x="960" y="720" text-anchor="middle" font-family={MONO} font-size="34" letter-spacing="14" fill={MUTED}>"INFRASTRUCTURE AS EFFECTS"</text>
            </g>
            {flash(build, FG)}
        </g>)
    }
}

fn fade_in(t: f32, at: f32) -> f32 {
    ((t - at) / 0.25).clamp(0.0, 1.0)
}

// ─── 2. Pain · bars 4–7 · kick ───────────────────────────────────────────────

const PAIN: [&str; 8] = ["SCRIPTS", "YAML", "TEMPLATES", "IAM POLICIES", "ENV VARS", "GLUE CODE", "TWO PROGRAMS", "BY HAND"];

#[derive(Debug)]
struct Pain;
impl Scene for Pain {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 4.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let i = ((t / b(2.0)) as usize).min(PAIN.len() - 1);
        let word = PAIN[i];
        let size = if word.len() > 9 { 170.0 } else { 220.0 };
        let at = b(2.0 * i as f32);
        let strike_at = at + BEAT;
        let s = spring(&frame, strike_at, 0.0, 1.0, &WHIP);
        let w = word.len() as f32 * size * 0.66;
        let shake = hit(t, strike_at, 10.0) * 26.0;
        let jx = shake * (hash(frame.index as u32 * 5) * 2.0 - 1.0);
        let jy = shake * (hash(frame.index as u32 * 9 + 1) * 2.0 - 1.0);
        let rot = if i % 2 == 0 { -3.0 } else { 3.0 };
        let red = hit(t, strike_at, 6.0) * 0.18;
        // Earlier words pile up around the edges, struck out.
        let pile: Vec<Svgr> = PAIN[..i]
            .iter()
            .enumerate()
            .map(|(k, wd)| {
                let x = 180.0 + hash(k as u32 * 3 + 11) * 1400.0;
                let y = if k % 2 == 0 { 150.0 + hash(k as u32 + 5) * 120.0 } else { 880.0 + hash(k as u32 + 9) * 120.0 };
                let wlen = wd.len() as f32 * 64.0 * 0.66;
                fframes::svgr!(<g opacity="0.28">
                    <text x={x} y={y} font-family={DISPLAY} font-weight="900" font-size="64" fill={MUTED}>{*wd}</text>
                    <path d={format!("M {} {} L {} {}", x - 10.0, y - 22.0, x + wlen + 10.0, y - 22.0)} stroke={RED} stroke-width="6" />
                </g>)
            })
            .collect();
        fframes::svgr!(<g>
            {flash(red, RED)}
            {pile}
            <text x="160" y="110" font-family={MONO} font-size="30" fill={MUTED} letter-spacing="6">{format!("BEFORE · {:02}/{:02}", i + 1, PAIN.len())}</text>
            <g transform={format!("translate({jx} {jy}) rotate({rot} 960 560)")}>
                {slam(&frame, at, 960.0, 620.0, word, size, FG, "middle")}
                <path d={format!("M {} 560 L {} 560", 960.0 - w / 2.0 - 40.0, 960.0 - w / 2.0 - 40.0 + (w + 80.0) * s)}
                      stroke={RED} stroke-width="22" stroke-linecap="round" opacity={if t >= strike_at { 1.0 } else { 0.0 }} />
            </g>
        </g>)
    }
}

// ─── 3. One program · bars 8–11 ──────────────────────────────────────────────

const BUCKET: Line = &[("const", KW), (" bucket = ", VAR), ("yield", KW), ("* R2.", VAR), ("Bucket", "#4ec9b0"), ("(", PUN), ("\"Uploads\"", STR), (");", PUN)];

#[derive(Debug)]
struct OneProgram;
impl Scene for OneProgram {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 4.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        // ONE. PROGRAM. then the camera flies through the words.
        let through = ((t - b(4.0)) / 0.45).clamp(0.0, 1.0);
        let zoom = 1.0 + through.powi(3) * 14.0;
        let words_o = 1.0 - through;
        // A line of code types itself…
        let len = line_len(BUCKET);
        let n = ((t - b(5.0)) / 0.028).clamp(0.0, len as f32) as usize;
        let cw = 62.0 * 0.6;
        let x0 = 960.0 - len as f32 * cw / 2.0;
        // …and becomes a real bucket.
        let card = spring(&frame, b(9.0), 0.0, 1.0, &BOUNCE);
        let ring = ((t - b(9.0)) / 0.9).clamp(0.0, 1.0);
        fframes::svgr!(<g>
            <g opacity={words_o} transform={format!("translate(960 540) scale({zoom}) translate(-960 -540)")}>
                {slam(&frame, 0.0, 960.0, 520.0, "ONE", 380.0, FG, "middle")}
                {slam(&frame, b(2.0), 960.0, 760.0, "PROGRAM.", 250.0, MOSS, "middle")}
            </g>
            <g opacity={if t >= b(5.0) { 1.0 } else { 0.0 }}>
                <text x={x0} y="470" font-family={MONO} font-size="62">{typed(BUCKET, n)}</text>
                <rect x={x0 + n as f32 * cw + 4.0} y="420" width="30" height="62" fill={MOSS} opacity={if n < len || (t * 3.0) as i32 % 2 == 0 { 1.0 } else { 0.0 }} />
            </g>
            <g opacity={if t >= b(9.0) { 1.0 } else { 0.0 }}>
                <circle cx="960" cy="690" r={40.0 + ring * 420.0} fill="none" stroke={MOSS} stroke-width="4" opacity={1.0 - ring} />
                <g transform={format!("translate(960 690) scale({card})")}>
                    <rect x="-200" y="-70" width="400" height="140" rx="24" fill={CARD} stroke="#8b7cf6" stroke-width="5" />
                    <circle cx="-140" cy="0" r="14" fill="#8b7cf6" />
                    <text x="-104" y="18" font-family={DISPLAY} font-weight="900" font-size="54" fill={FG}>"Uploads"</text>
                </g>
            </g>
            {slam(&frame, b(12.0), 960.0, 240.0, "A VARIABLE.", 110.0, FG, "middle")}
            {slam(&frame, b(14.0), 960.0, 940.0, "A REAL BUCKET.", 110.0, MOSS, "middle")}
        </g>)
    }
}

// ─── 4. Graph · bars 12–15 · pad + kick ──────────────────────────────────────

const NODES: [(&str, &str, f32, f32); 7] = [
    ("Api", "#f38020", 1260.0, 540.0),
    ("Uploads", "#8b7cf6", 1560.0, 280.0),
    ("Jobs", "#e0a86b", 1620.0, 720.0),
    ("Postgres", "#63b3ed", 1250.0, 900.0),
    ("Web", "#a3c473", 900.0, 300.0),
    ("Links", "#4ec9b0", 880.0, 780.0),
    ("Logs", "#d8835a", 1600.0, 500.0),
];

#[derive(Debug)]
struct Graph;
impl Scene for Graph {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 4.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let (cx, cy) = (NODES[0].2, NODES[0].3);
        let pos = |i: usize| -> (f32, f32, f32) {
            let at = b(i as f32);
            let p = spring(&frame, at, 0.0, 1.0, &BOUNCE);
            let (_, _, x, y) = NODES[i];
            (cx + (x - cx) * p, cy + (y - cy) * p, p)
        };
        let edges: Vec<Svgr> = (1..NODES.len())
            .map(|i| {
                let (x, y, p) = pos(i);
                let d = ((t - b(i as f32 + 0.5)) / 0.3).clamp(0.0, 1.0);
                let len = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt().max(1.0);
                let dot = ((t * 1.6 + i as f32 * 0.37).fract()).clamp(0.0, 1.0);
                fframes::svgr!(<g opacity={p.min(1.0)}>
                    <path d={format!("M {cx} {cy} L {x} {y}")} stroke={MOSS} stroke-width="4" stroke-dasharray={len} stroke-dashoffset={len * (1.0 - d)} opacity="0.7" />
                    <circle cx={cx + (x - cx) * dot} cy={cy + (y - cy) * dot} r="7" fill={FG} opacity={d} />
                </g>)
            })
            .collect();
        let nodes: Vec<Svgr> = (0..NODES.len())
            .map(|i| {
                let (x, y, p) = pos(i);
                let (label, color, _, _) = NODES[i];
                let s = p.max(0.01);
                fframes::svgr!(<g transform={format!("translate({x} {y}) scale({s})")} opacity={if t >= b(i as f32) { 1.0 } else { 0.0 }}>
                    <rect x="-130" y="-46" width="260" height="92" rx="18" fill={CARD} stroke={color} stroke-width="4" />
                    <circle cx="-94" cy="0" r="10" fill={color} />
                    <text x="-70" y="13" font-family={DISPLAY} font-weight="900" font-size="36" fill={FG}>{label}</text>
                </g>)
            })
            .collect();
        let spin = (t * 0.8).sin() * 2.0;
        let zoom = 0.9 + t / (BAR * 4.0) * 0.15;
        fframes::svgr!(<g>
            <g transform={format!("translate(1260 590) rotate({spin}) scale({zoom}) translate(-1260 -590)")}>
                {edges}
                {nodes}
            </g>
            {slam(&frame, b(8.0), 140.0, 420.0, "INFRA", 150.0, FG, "start")}
            {slam(&frame, b(10.0), 140.0, 560.0, "AS", 150.0, FG, "start")}
            {slam(&frame, b(12.0), 140.0, 700.0, "EFFECTS", 150.0, MOSS, "start")}
        </g>)
    }
}

// ─── 5. Riser · bar 16 ───────────────────────────────────────────────────────

#[derive(Debug)]
struct Riser;
impl Scene for Riser {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let p = t / BAR;
        let travel = p * p * 3.0;
        // A tunnel of frames rushing at the camera, faster and faster.
        let rects: Vec<Svgr> = (0..14)
            .map(|k| {
                let d = (k as f32 / 14.0 + travel).fract();
                let s = 0.04 + d.powi(3) * 2.2;
                let (w, h) = (1920.0 * s, 1080.0 * s);
                let color = if k % 2 == 0 { MOSS } else { EMBER };
                fframes::svgr!(<rect x={960.0 - w / 2.0} y={540.0 - h / 2.0} width={w} height={h} fill="none" stroke={color} stroke-width={2.0 + d * 10.0} opacity={d * (1.0 - d) * 3.0} />)
            })
            .collect();
        let flicker = if (t * 16.0 / BEAT) as i32 % 2 == 0 { 1.0 } else { 0.3 };
        fframes::svgr!(<g>
            {rects}
            <g opacity={flicker}>
                <text x="960" y="580" text-anchor="middle" font-family={DISPLAY} font-weight="900" font-size={120.0 + p * 160.0} fill={FG}>"READY?"</text>
            </g>
            {flash(p.powi(5), FG)}
        </g>)
    }
}

// ─── 6. Drop · bars 17–24 ────────────────────────────────────────────────────

const REQS: [&str; 5] = ["R2.ReadBucket", "Queues.WriteQueue", "Neon.Postgres", "Cloudflare.Worker", "RuntimeContext"];

#[derive(Debug)]
struct Drop;
impl Scene for Drop {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 8.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let size = 150.0;
        let cw = size * 0.6;
        let x0 = 960.0 - 15.0 * cw / 2.0;
        let char_x = |k: f32| x0 + (k + 0.5) * cw;
        // Zoom into the R.
        let z = ((t - b(12.0)) / b(2.0)).clamp(0.0, 1.0);
        let zoom = 1.0 + z.powi(3) * 7.0;
        let (rx, ry) = (char_x(13.0), 500.0);
        let type_o = if t < b(14.0) { 1.0 } else { 0.0 };
        let hi = |k: f32, at: f32, color: &'a str, label: &'a str| -> Svgr<'a> {
            let p = spring(&frame, at, 0.0, 1.0, &SNAP);
            fframes::svgr!(<g opacity={if t >= at { 1.0 } else { 0.0 }}>
                <rect x={char_x(k) - cw * 0.55} y={500.0 - size * 0.82} width={cw * 1.1} height={size * 1.08} rx="14" fill="none" stroke={color} stroke-width="7" transform={format!("translate({} {}) scale({}) translate({} {})", char_x(k), 440.0, 0.6 + 0.4 * p, -char_x(k), -440.0)} />
                {slam(&frame, at, char_x(k), 700.0, label, 42.0, color, "middle")}
            </g>)
        };
        let reqs_o = if t >= b(14.0) && t < b(25.0) { 1.0 } else { 0.0 } * (1.0 - spring(&frame, b(24.5), 0.0, 1.0, &WHIP));
        let reqs: Vec<Svgr> = REQS
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let at = b(14.0 + i as f32);
                let ok = b(20.0 + i as f32);
                let y = 330.0 + i as f32 * 125.0;
                let sweep = ((t - ok) / 0.15).clamp(0.0, 1.0);
                fframes::svgr!(<g>
                    <rect x="380" y={y - 70.0} width={(1160.0 * sweep).max(0.5)} height="96" rx="12" fill="#1f3a22" opacity={if sweep > 0.0 { 1.0 } else { 0.0 }} />
                    {slam(&frame, at, 440.0, y, format!("| {name}"), 64.0, TEAL, "start")}
                    {slam(&frame, ok, 1470.0, y, "✓", 80.0, MOSS, "middle")}
                </g>)
            })
            .collect();
        let flashes = hit(t, 0.0, 5.0)
            + 0.35 * (hit(t, b(4.0), 9.0) + hit(t, b(6.0), 9.0) + hit(t, b(8.0), 9.0) + hit(t, b(14.0), 6.0))
            + 0.5 * (hit(t, b(26.0), 8.0) + hit(t, b(28.0), 8.0));
        let slam_in = spring(&frame, 0.0, 3.2, 1.0, &SNAP);
        fframes::svgr!(<g>
            <g opacity={type_o} transform={format!("translate({rx} {ry}) scale({zoom}) translate({} {})", -rx, -ry)}>
                <g transform={format!("translate(960 460) scale({slam_in}) translate(-960 -460)")}>
                    <text x={x0} y="500" font-family={MONO} font-size={size}>
                        <tspan fill={TEAL}>"Effect"</tspan><tspan fill={PUN}>"<A, E, "</tspan><tspan fill={MOSS}>"R"</tspan><tspan fill={PUN}>">"</tspan>
                    </text>
                </g>
                {hi(7.0, b(4.0), FG, "SUCCESS")}
                {hi(10.0, b(6.0), EMBER, "ERRORS")}
                {hi(13.0, b(8.0), MOSS, "REQUIREMENTS")}
            </g>
            <g opacity={reqs_o}>
                <text x="440" y="200" font-family={MONO} font-size="34" letter-spacing="6" fill={MUTED}>"R · WHAT IT NEEDS"</text>
                {reqs}
            </g>
            {slam(&frame, b(26.0), 960.0, 500.0, "TYPE-CHECKED", 200.0, FG, "middle")}
            {slam(&frame, b(28.0), 960.0, 700.0, "INFRASTRUCTURE.", 150.0, MOSS, "middle")}
            {flash(flashes, FG)}
        </g>)
    }
}

// ─── 7. The agent loop · bars 25–32 ──────────────────────────────────────────

#[derive(Debug)]
struct Loop;
impl Scene for Loop {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 8.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let beat = t / BEAT;
        let bi = beat as usize;
        let (cx, cy, r) = (960.0, 540.0, 300.0);
        // One station per beat around the loop.
        let step = beat.floor() + (1.0 - (1.0 - beat.fract()).powi(4));
        let angle = (-90.0 + 120.0 * step).to_radians();
        let (dx, dy) = (cx + r * angle.cos(), cy + r * angle.sin());
        let stations: Vec<Svgr> = [("WRITE", -90.0_f32), ("TSC", 30.0), ("TEST", 150.0)]
            .iter()
            .map(|(label, a)| {
                let a = a.to_radians();
                let (x, y) = (cx + (r + 150.0) * a.cos(), cy + (r + 110.0) * a.sin() + 16.0);
                fframes::svgr!(<text x={x} y={y} text-anchor="middle" font-family={MONO} font-weight="700" font-size="44" fill={MUTED}>{*label}</text>)
            })
            .collect();
        let (label, result, color) = match bi {
            0 => ("WRITE", "Api.ts", FG),
            1 => ("TSC", "✗ TS2322", RED),
            2 => ("FIX", "orDie", EMBER),
            3 => ("TSC", "✓ 0.41s", MOSS),
            4 => ("TEST", "✓ 3 PASS", MOSS),
            n => match n % 3 {
                0 => ("TSC", "✓ 0.38s", MOSS),
                1 => ("TEST", "✓ 1.4s", MOSS),
                _ => ("WRITE", "+ 12 lines", FG),
            },
        };
        let ring_o = 1.0 - spring(&frame, b(24.0), 0.0, 1.0, &WHIP);
        let err = hit(t, b(1.0), 9.0);
        let jx = err * 30.0 * (hash(frame.index as u32 * 3) * 2.0 - 1.0);
        let iteration = 1 + bi / 3;
        let spin = t * (40.0 + t * 12.0);
        fframes::svgr!(<g>
            {flash(err * 0.25, RED)}
            <g opacity={ring_o} transform={format!("translate({jx} 0)")}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#3a3328" stroke-width="16" />
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={MOSS} stroke-width="6" stroke-dasharray="40 30" transform={format!("rotate({spin} {cx} {cy})")} opacity="0.7" />
                <circle cx={dx} cy={dy} r="26" fill={MOSS} />
                <circle cx={dx} cy={dy} r={26.0 + (beat.fract()) * 60.0} fill="none" stroke={MOSS} stroke-width="4" opacity={1.0 - beat.fract()} />
                {stations}
                <text x={cx} y={cy - 50.0} text-anchor="middle" font-family={MONO} font-size="36" letter-spacing="8" fill={MUTED}>{label}</text>
                {slam(&frame, b(bi as f32), cx, cy + 50.0, result, 80.0, color, "middle")}
            </g>
            <text x="1760" y="110" text-anchor="end" font-family={MONO} font-size="34" fill={MUTED} opacity={ring_o}>{format!("ITERATION {iteration:02}")}</text>
            <text x="160" y="110" font-family={MONO} font-size="34" fill={MUTED} opacity={ring_o}>"dev: true · local"</text>
            {slam(&frame, b(24.0), 960.0, 500.0, "THE FASTEST LOOP", 150.0, FG, "middle")}
            {slam(&frame, b(27.0), 960.0, 690.0, "FOR AGENTS.", 150.0, MOSS, "middle")}
            {flash(0.4 * hit(t, b(24.0), 8.0) + 0.4 * hit(t, b(27.0), 8.0), FG)}
        </g>)
    }
}

// ─── 8. Swap · bars 33–40 ────────────────────────────────────────────────────

const BACKENDS: [(&str, &str); 8] = [
    ("D1Storage", "#f38020"),
    ("NeonStorage", "#63b3ed"),
    ("DynamoStorage", "#ff9900"),
    ("PlanetScale", "#f5f5f5"),
    ("SqliteStorage", "#4ec9b0"),
    ("NeonStorage", "#63b3ed"),
    ("D1Storage", "#f38020"),
    ("PgStorage", "#8b7cf6"),
];

#[derive(Debug)]
struct Swap;
impl Scene for Swap {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 8.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let size = 72.0;
        let cw = size * 0.6;
        let slot_chars = 13.0;
        let total = 14.0 + slot_chars + 1.0;
        let x0 = 960.0 - total * cw / 2.0;
        let slot_x = x0 + 14.0 * cw;
        let y = 600.0;
        // Every 4 beats the reel spins for a beat and lands on a new backend.
        let k = ((t / b(4.0)) as usize).min(BACKENDS.len() - 1);
        let phase = t - b(4.0 * k as f32);
        let spinning = phase < BEAT * 0.75 && k > 0;
        let (name, color) = BACKENDS[k];
        let reel: Vec<Svgr> = if spinning {
            (0..6)
                .map(|j| {
                    let off = ((phase / BEAT) * 9.0 + j as f32).fract();
                    let yy = y - 110.0 + off * 220.0;
                    let n = BACKENDS[(k + j) % BACKENDS.len()].0;
                    fframes::svgr!(<text x={slot_x + 12.0} y={yy} font-family={MONO} font-size={size} fill={MUTED} opacity="0.6">{n}</text>)
                })
                .collect()
        } else {
            let land = spring(&frame, b(4.0 * k as f32) + if k > 0 { BEAT * 0.75 } else { 0.0 }, -60.0, 0.0, &BOUNCE);
            vec![fframes::svgr!(<text x={slot_x + 12.0} y={y + land} font-family={MONO} font-size={size} fill={color}>{name}</text>)]
        };
        let landed = if k > 0 { hit(t, b(4.0 * k as f32) + BEAT * 0.75, 7.0) } else { 0.0 };
        fframes::svgr!(<g>
            <defs>
                <clipPath id="slot">
                    <rect x={slot_x - 4.0} y={y - 72.0} width={slot_chars * cw + 32.0} height="100" />
                </clipPath>
            </defs>
            <text x={x0} y={y} font-family={MONO} font-size={size}>
                <tspan fill="#4ec9b0">"Layer"</tspan><tspan fill={PUN}>"."</tspan><tspan fill={FN}>"provide"</tspan><tspan fill={PUN}>"("</tspan>
            </text>
            <rect x={slot_x - 4.0} y={y - 72.0} width={slot_chars * cw + 32.0} height="100" rx="12" fill={CARD} stroke={color} stroke-width={3.0 + landed * 8.0} />
            <g clip-path="url(#slot)">{reel}</g>
            <text x={slot_x + slot_chars * cw + 34.0} y={y} font-family={MONO} font-size={size} fill={PUN}>")"</text>
            {slam(&frame, 0.0, 960.0, 320.0, "SWAP THE INFRA.", 140.0, FG, "middle")}
            <g opacity={if t >= b(16.0) { 0.0 } else { 1.0 }}>
                <text x="960" y="820" text-anchor="middle" font-family={MONO} font-size="40" fill={MUTED} letter-spacing="4">"LINES OF APP CODE CHANGED: 0"</text>
            </g>
            {slam(&frame, b(16.0), 960.0, 860.0, "KEEP THE CODE.", 140.0, MOSS, "middle")}
            {flash(landed * 0.15, color)}
        </g>)
    }
}

// ─── 9. Ticker · bars 41–48 ──────────────────────────────────────────────────

const PROVIDERS: &str = "CLOUDFLARE · AWS · NEON · PLANETSCALE · AXIOM · STRIPE · GITHUB · FLY · HETZNER · RAILWAY · KUBERNETES · DOCKER · PRISMA · ";

#[derive(Debug)]
struct Ticker;
impl Scene for Ticker {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 8.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let beat = t / BEAT;
        // Each beat kicks the rows forward.
        let kick = beat.floor() + (1.0 - (1.0 - beat.fract()).powi(3));
        let size = 150.0;
        let row_w = PROVIDERS.chars().count() as f32 * size * 0.64;
        let rows: Vec<Svgr> = [(150.0_f32, 1.0_f32, false), (340.0, -1.3, true), (760.0, 1.1, true), (950.0, -0.9, false)]
            .iter()
            .enumerate()
            .map(|(i, (y, dir, outline))| {
                let travel = (t * 260.0 + kick * 90.0) * dir;
                let x = -((travel % row_w + row_w) % row_w) - hash(i as u32) * row_w;
                let text = PROVIDERS.repeat(3);
                if *outline {
                    fframes::svgr!(<text x={x} y={y} font-family={DISPLAY} font-weight="900" font-size={size} fill="none" stroke={FG} stroke-width="2.5" opacity="0.5">{text}</text>)
                } else {
                    fframes::svgr!(<text x={x} y={y} font-family={DISPLAY} font-weight="900" font-size={size} fill={FG} opacity="0.14">{text}</text>)
                }
            })
            .collect();
        let band = if (beat / 4.0) as i32 % 2 == 0 { MOSS } else { EMBER };
        let hitb = hit(t, b(beat.floor()), 10.0);
        fframes::svgr!(<g>
            {rows}
            <rect x="0" y={430.0 - hitb * 12.0} width="1920" height={220.0 + hitb * 24.0} fill={band} />
            {slam(&frame, 0.0, 960.0, 600.0, "ONE LANGUAGE.", 170.0, BG, "middle")}
            <g opacity={if t >= b(16.0) { 1.0 } else { 0.0 }}>
                <rect x="0" y={430.0 - hitb * 12.0} width="1920" height={220.0 + hitb * 24.0} fill={band} />
            </g>
            {slam(&frame, b(16.0), 960.0, 600.0, "EVERY CLOUD.", 170.0, BG, "middle")}
            {flash(0.5 * hit(t, b(16.0), 8.0), FG)}
        </g>)
    }
}

// ─── 10. Finale · bars 49–53 ─────────────────────────────────────────────────

#[derive(Debug)]
struct Finale;
impl Scene for Finale {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(BAR * 5.0)
    }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let rings: Vec<Svgr> = (0..3)
            .map(|k| {
                let p = ((t - k as f32 * 0.12) / 1.3).clamp(0.0, 1.0);
                let color = if k == 1 { EMBER } else { MOSS };
                fframes::svgr!(<circle cx="960" cy="520" r={(p * 1300.0).max(0.5)} fill="none" stroke={color} stroke-width={14.0 * (1.0 - p) + 0.5} opacity={1.0 - p} />)
            })
            .collect();
        let sparks: Vec<Svgr> = (0..70)
            .map(|k| {
                let a = hash(k * 7 + 1) * std::f32::consts::TAU;
                let speed = 500.0 + hash(k * 13 + 2) * 1100.0;
                let d = speed * (1.0 - (-t * 2.6).exp());
                let (x, y) = (960.0 + a.cos() * d, 520.0 + a.sin() * d);
                let tail = 40.0 * (-t * 2.0).exp() + 4.0;
                let color = if k % 3 == 0 { EMBER } else if k % 3 == 1 { MOSS } else { FG };
                fframes::svgr!(<path d={format!("M {x} {y} L {} {}", x - a.cos() * tail, y - a.sin() * tail)} stroke={color} stroke-width="4" stroke-linecap="round" opacity={(1.0 - t / 1.6).clamp(0.0, 1.0)} />)
            })
            .collect();
        let cmd = "$ alchemy deploy --stage prod";
        let n = ((t - b(8.0)) / 0.03).clamp(0.0, cmd.len() as f32) as usize;
        let bar = ((t - b(9.5)) / b(2.0)).clamp(0.0, 1.0);
        let bar = 1.0 - (1.0 - bar).powi(3);
        let end = ((t - (BAR * 5.0 - 0.8)) / 0.8).clamp(0.0, 1.0);
        fframes::svgr!(<g>
            {rings}
            {sparks}
            {slam(&frame, 0.0, 960.0, 600.0, "ALCHEMY", 280.0, FG, "middle")}
            <g opacity={fade_in(t, b(4.0))}>
                <text x="960" y="700" text-anchor="middle" font-family={MONO} font-size="42" letter-spacing="16" fill={MOSS}>"INFRASTRUCTURE AS EFFECTS"</text>
            </g>
            <text x="560" y="830" font-family={MONO} font-size="36" fill={FG}>{cmd[..n].to_string()}</text>
            <rect x="560" y="860" width={(800.0 * bar).max(0.5)} height="8" rx="4" fill={MOSS} opacity={if t >= b(9.5) { 1.0 } else { 0.0 }} />
            {slam(&frame, b(12.0), 1380.0, 880.0, "✓ LIVE", 44.0, MOSS, "start")}
            <g opacity={fade_in(t, b(14.0))}>
                <text x="960" y="990" text-anchor="middle" font-family={MONO} font-size="46" fill={MUTED}>"alchemy.run"</text>
            </g>
            {flash(hit(t, 0.0, 3.5), FG)}
            {flash(end, "#000")}
        </g>)
    }
}
