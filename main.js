import * as THREE from "three";
import { SpotLightHelper } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

// ✅ POSTPROCESSING IMPORTS (this is what makes “real” night vision)
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const DEBUG = false;
const log  = (...args) => DEBUG && console.log(...args);
const warn = (...args) => DEBUG && console.warn(...args);
const err  = (...args) => DEBUG && console.error(...args);

// ============================================================
// iOS / MOBILE SAFE MODE (prevents 99% crash)
// ============================================================
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const SAFE_MOBILE = isIOS; // flip to true to test on desktop

const MOBILE_PROFILE = {
  maxDpr: SAFE_MOBILE ? 1.0 : 2.0,                 // ✅ huge win
  shadows: SAFE_MOBILE ? false : true,             // ✅ biggest win (try false first)
  maxAniso: SAFE_MOBILE ? 1 : null,                // ✅ reduce texture cost
  shadowMapSize: SAFE_MOBILE ? 1024 : 4096,        // if you re-enable shadows later
  postFX: SAFE_MOBILE ? false : true,              // disable composer on iPhone
};

const LAYER_WORLD = 0;
const LAYER_ACCENT = 2;
const LAYER_PIN = 3;
const LAYER_LAMP = 6;

const DESIGN_W = 1920;
const DESIGN_H = 1080;
const DESIGN_ASPECT = DESIGN_W / DESIGN_H;

const BASE_ASPECT = DESIGN_ASPECT;
let baseFovDeg = 0;          // ✅ numeric default
let baseFovCaptured = false; // ✅ add this

let viewX = 0, viewY = 0, viewW = window.innerWidth, viewH = window.innerHeight;


const canvas = document.querySelector("#c");
if (!canvas) throw new Error('Canvas "#c" not found. Check your HTML id="c".');

// ============================================================
// ✅ LOADING UI (matches your index.html #loader / #loader-text)
// ============================================================
const loaderEl = document.getElementById("loader");
const loaderTextEl = document.getElementById("loader-text");

// If loader isn't in the DOM for some reason, don't crash.
function setLoaderPct(p) {
  if (!loaderTextEl) return;
  const pct = Math.max(0, Math.min(100, Math.floor(p)));

  // ✅ Only show number + %
  loaderTextEl.textContent = `${pct}%`;
}

function hideLoader() {
  if (!loaderEl) return;
  loaderEl.classList.add("hidden");
  // optional: fully remove after fade
  setTimeout(() => loaderEl.remove(), 900);
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: "low-power",
});

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92; // subtle cinematic darkening (try 0.88–0.98)

// ============================================================
// ✅ Color pipeline consistency (desktop + iOS)
// Put directly after renderer creation
// ============================================================
renderer.outputColorSpace = THREE.SRGBColorSpace;     // modern three
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // if desktop uses this
renderer.toneMappingExposure = renderer.toneMappingExposure ?? 1.3;

// renderer settings...
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = isIOS ? 1.1 : 1.0;
renderer.physicallyCorrectLights = true;

renderer.shadowMap.enabled = MOBILE_PROFILE.shadows;
renderer.shadowMap.type = isIOS
  ? THREE.PCFShadowMap
  : THREE.PCFSoftShadowMap;

  // ✅ iOS CRASH GUARD: disable shadows entirely on iPhone/iPad
if (isIOS) {
  console.log("📱 iOS detected → disabling shadow maps");
  renderer.shadowMap.enabled = false;
}

const dpr = window.devicePixelRatio || 1;
renderer.setPixelRatio(Math.min(dpr, MOBILE_PROFILE.maxDpr));
renderer.setSize(window.innerWidth, window.innerHeight);

// ✅ iOS SAFARI INPUT FIX (does NOT change desktop look)
if (isIOS) {
  renderer.domElement.style.touchAction = "none";
  renderer.domElement.style.webkitUserSelect = "none";
  renderer.domElement.style.userSelect = "none";

  renderer.domElement.addEventListener(
    "touchmove",
    (e) => e.preventDefault(),
    { passive: false }
  );
}

// ============================================================
// SCENE + CAMERA
// ============================================================
const scene = new THREE.Scene();
// ✅ Cinematic: subtle cool shadows + warm highlights separation
const moodHemi = new THREE.HemisphereLight(0x9bb7ff, 0x0f0f14, 0.08);
scene.add(moodHemi);
scene.background = new THREE.Color(0x000000);

// ============================================================
// ✅ LOADING TRACKER (real progress, not fake)
// - We count assets we request (GLBs, textures, images, audio)
// - We mark them "done" when they load (or error)
// ============================================================
let __loadTotal = 0;
let __loadDone = 0;
let __loaderFinished = false;

function __beginAsset(label) {
  __loadTotal++;
  __updateLoader(label);
  // return a function you call when that asset finishes
  let finished = false;
  return function __endAsset() {
    if (finished) return;
    finished = true;
    __loadDone++;
    __updateLoader(label);
    __maybeFinishLoader();
  };
}

function __updateLoader(label = "") {

  if (__loadTotal === 0) {
  setLoaderPct(0);
  return;
}
const pct = (__loadDone / __loadTotal) * 100;
setLoaderPct(pct);

}

const __loaderStartTime = performance.now();

function __maybeFinishLoader() {
  if (__loaderFinished) return;

  if (__loadDone >= __loadTotal && __loadTotal > 0) {
    const elapsed = performance.now() - __loaderStartTime;

    // Ensure loader is visible at least 700ms (prevents flash)
    const MIN_TIME = 700;

    const delay = Math.max(0, MIN_TIME - elapsed);

    __loaderFinished = true;

    setLoaderPct(100);

    setTimeout(() => {
      hideLoader();
    }, delay + 250);
  }
}

// start at 0%
setLoaderPct(0);

// ============================================================
// ✅ DEBUG: show load errors on the loader (but ignore harmless iOS rejections)
// ============================================================
const __IGNORE_ERR = [
  /notallowederror/i,                 // autoplay/user gesture blocks
  /play\(\) failed/i,
  /the operation is insecure/i,
  /resizeobserver loop limit exceeded/i,
  /webkit/i
];

function __shouldIgnoreMsg(msg = "") {
  return __IGNORE_ERR.some((re) => re.test(String(msg)));
}

window.addEventListener("error", (e) => {
  const msg = e?.message || "";
  console.error("💥 Uncaught error:", e.error || msg);

  // Ignore common harmless ones
  if (__shouldIgnoreMsg(msg)) return;

  // Only show ERROR while loader is still visible
  if (!__loaderFinished && loaderTextEl) loaderTextEl.textContent = "ERROR (check console)";
});

window.addEventListener("unhandledrejection", (e) => {
  const reason = e?.reason;
  const msg =
    (typeof reason === "string" ? reason : reason?.message) || String(reason || "");

  console.error("💥 Unhandled promise rejection:", reason);

  // Ignore autoplay / gesture blocked rejections (super common on iOS)
  if (__shouldIgnoreMsg(msg)) return;

  // Only show ERROR while loader is still visible
  if (!__loaderFinished && loaderTextEl) loaderTextEl.textContent = "ERROR (check console)";
});

let composer = null;
let nightVisionPass = null;
let baseExposure = renderer.toneMappingExposure;


// ============================================================
// ✅ NIGHT VISION AUTO-GAIN (Eye Adaptation) — NV ONLY
// ============================================================
const AE_SIZE = 32; // tiny render target (fast)
const aeRT = new THREE.WebGLRenderTarget(AE_SIZE, AE_SIZE, {
  depthBuffer: false,
  stencilBuffer: false,
});
const aePixels = new Uint8Array(AE_SIZE * AE_SIZE * 4);

let aeGain = 1.45;          // current smoothed gain
let aeTargetLuma = 0.18;    // target average brightness (0..1). 0.14–0.22 is a good range
let aeMinGain = 0.80;
let aeMaxGain = 3.20;

let aeSampleAccum = 0;      // to sample at ~10–15 Hz instead of every frame

function updateNightVisionAutoGain(dt) {
  if (!nightVisionOn || !nightVisionPass) return;

  // sample ~12 times per second (adjust if you want)
  aeSampleAccum += dt;
  if (aeSampleAccum < (1 / 12)) return;
  aeSampleAccum = 0;

  // render scene into tiny RT (no NV shader here — we want actual scene brightness)
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(aeRT);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(aeRT, 0, 0, AE_SIZE, AE_SIZE, aePixels);
  renderer.setRenderTarget(prevRT);

  // compute average luminance
  let sum = 0;
  const n = AE_SIZE * AE_SIZE;

  for (let i = 0; i < aePixels.length; i += 4) {
    const r = aePixels[i + 0] / 255;
    const g = aePixels[i + 1] / 255;
    const b = aePixels[i + 2] / 255;

    // Rec.709 luma
    sum += (0.2126 * r + 0.7152 * g + 0.0722 * b);
  }

  const avgLuma = sum / n; // 0..1

  // desired gain pushes avgLuma toward target
  const eps = 1e-4;
  let desired = aeTargetLuma / Math.max(eps, avgLuma);

  // clamp so it feels like a real tube (no infinite lift)
  desired = Math.max(aeMinGain, Math.min(aeMaxGain, desired));

  // smooth (this is the “eye adaptation” feel)
  // bigger = faster adaptation; smaller = slower
  const adapt = 0.10;
  aeGain += (desired - aeGain) * adapt;

  nightVisionPass.uniforms.uGain.value = aeGain;
}

function initPostFX() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

const nightVisionShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uTime:      { value: 0 },
    uOn:        { value: 0 },     // 0 = off, 1 = on
    uStrength:  { value: 1.0 },   // overall strength
    uGain: { value: 1.45 },  // ✅ auto exposure gain (NV only)

    // ✅ NEW (for crisp detail + scanlines + grain scaling)
    uResolution:{ value: new THREE.Vector2(window.innerWidth, window.innerHeight) },

    // ✅ NEW look controls
    uTintStrength: { value: 0.85 },  // how much green tint exists
    uDesat:        { value: 0.85 },  // how close to B/W it is
    uGrain:        { value: 0.055 }, // film grain amount
    uScan:         { value: 0.07 },  // scanline amount
    uDirty:        { value: 0.25 },  // grime/vignette dirt strength
    uNoiseHi:      { value: 0.015 }, // grain strength in highlights
    uNoiseLo:      { value: 0.060 }, // grain strength in shadows

  },


    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: `
uniform sampler2D tDiffuse;

uniform float uTime;
uniform float uOn;
uniform float uStrength;
uniform float uGain;

uniform vec2  uResolution;
uniform float uTintStrength;
uniform float uDesat;
uniform float uGrain;
uniform float uScan;
uniform float uDirty;
uniform float uNoiseHi;
uniform float uNoiseLo;


varying vec2 vUv;

float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
}

float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  float a=rand(i);
  float b=rand(i+vec2(1.,0.));
  float c=rand(i+vec2(0.,1.));
  float d=rand(i+vec2(1.,1.));
  vec2 u=f*f*(3.-2.*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
}

float sat(float x){ return clamp(x, 0.0, 1.0); }
float lumaOf(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }

// contrast curve: deep blacks + crisp whites (toe/shoulder)
float filmCurve(float x) {
  x = sat(x);
  // toe
  x = pow(x, 0.92);
  // S-curve
  x = x*x*(3.0 - 2.0*x);
  return x;
}

// soft circle mask (for smudges)
float blob(vec2 uv, vec2 c, float r, float soft){
  float d = length(uv - c);
  return 1.0 - smoothstep(r, r + soft, d);
}

// posterize (compressed/old camera)
vec3 posterize(vec3 c, float steps){
  return floor(c * steps) / steps;
}

void main() {
  vec2 uv = vUv;
  vec4 src0 = texture2D(tDiffuse, uv);
  // ============================================================
// ✅ NVG PHOSPHOR LAG / TRAIL (real tube persistence)
// ============================================================

// tiny time-based offset (simulates tube delay)
vec2 lagOffset = vec2(
  sin(uTime * 1.3) * 0.0008,
  cos(uTime * 1.1) * 0.0006
);

// delayed sample
vec3 lagSample = texture2D(tDiffuse, uv - lagOffset).rgb;


  if (uOn < 0.5) { gl_FragColor = src0; return; }

  float t = uTime;

  // ------------------------------------------------------------
  // ✅ Slight chroma aberration (tiny, keep crisp)
  // ------------------------------------------------------------
  float ca = 0.0006;
  vec3 src;
  src.r = texture2D(tDiffuse, uv + vec2( ca, 0.0)).r;
  src.g = texture2D(tDiffuse, uv).g;
  src.b = texture2D(tDiffuse, uv + vec2(-ca, 0.0)).b;

  // ------------------------------------------------------------
  // ✅ Unsharp mask sharpening (resolution-correct)
  // ------------------------------------------------------------
  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  vec3 b =
    texture2D(tDiffuse, uv + vec2( texel.x, 0.0)).rgb +
    texture2D(tDiffuse, uv + vec2(-texel.x, 0.0)).rgb +
    texture2D(tDiffuse, uv + vec2(0.0,  texel.y)).rgb +
    texture2D(tDiffuse, uv + vec2(0.0, -texel.y)).rgb;
  b *= 0.25;

  float sharpAmt = 0.75;
  src = clamp(src + (src - b) * sharpAmt, 0.0, 1.0);

  // ------------------------------------------------------------
  // ✅ Build the “reference-style” luminance
  // (stop clamping at 0.2 — that’s what made everything uniform)
  // ------------------------------------------------------------
  float l = lumaOf(src);

  // Black/white points: deep blacks, crisp whites (but not instantly clipped)
  float black = -0.070;   // raise -> darker blacks
  float white = 1.0;    // lower -> brighter sooner (but still preserves highlight range)
  l = sat((l - black) / max(1e-5, (white - black)));

  // Contrast curve
  l = filmCurve(l);

  // Slight highlight “pop” without blur
  float hi = sat((l - 0.70) / 0.30);
  l += hi * 0.12;
  l = sat(l);
  

  // ------------------------------------------------------------
  // ✅ Start from B/W (this is the big “reference” difference)
  // ------------------------------------------------------------
  vec3 bw = vec3(l);

  // ------------------------------------------------------------
  // ✅ Non-uniform green tint (less saturated, varies across frame)
  // ------------------------------------------------------------
  // base tint (less neon)
  vec3 baseGreen = vec3(0.18, 0.78, 0.34);

  // low-frequency tint variation (dirty/vintage uneven sensor)
  float tintN = noise(uv * 2.2 + vec2(t * 0.03, -t * 0.02)); // slow drift
  tintN = (tintN - 0.5) * 0.22; // small variation

  // vignette-ish unevenness
  vec2 p = uv - 0.5;
  float r = length(p);
  float vign = smoothstep(0.85, 0.25, r); // center brighter
  float edgeDark = smoothstep(0.35, 0.95, r);

  vec3 greenTint = baseGreen;
  greenTint.g += tintN;         // vary mostly in green channel
  greenTint.r -= tintN * 0.35;  // slight counter shift
  greenTint = clamp(greenTint, 0.0, 1.0);

  // ------------------------------------------------------------
  // ✅ Mix: mostly B/W, then green cast
  // ------------------------------------------------------------
  // uDesat: 1.0 = almost pure BW, 0.0 = fully green
  vec3 col = mix(bw * greenTint, bw, uDesat); // “BW with a green bias”

  // then re-apply controlled tint strength (keeps it from going neon)
  col = mix(bw, col, uTintStrength);

  // ------------------------------------------------------------
  // ✅ “Vintage breathing” exposure flicker (subtle)
  // ------------------------------------------------------------
  float flick = 0.93 + 0.05 * sin(t * 2.2) + 0.02 * sin(t * 6.7);
  col *= flick;

// ------------------------------------------------------------
// ✅ NVG PHOSPHOR (better green: pale yellow-green, shadows protected)
// ------------------------------------------------------------
float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));

// Gen2/3-ish phosphor: less neon, more yellow-green
vec3 nvg = luma * vec3(0.62, 0.95, 0.55);

// Tint only mid/highs; keep shadows dark/neutral
float greenMask = smoothstep(0.22, 0.78, luma);

// Slight extra bias in highlights (real tubes “bloom” greener up top)
float phosphorHi = smoothstep(0.65, 0.98, luma);
greenMask *= (0.85 + 0.35 * phosphorHi);


// Blend amount (keep subtle)
float greenMix = 0.33;

col = mix(col, nvg, greenMix * greenMask);

// ============================================================
// ✅ Apply phosphor persistence (bright areas leave faint trail)
// ============================================================

// how bright the pixel is
float lagMask = smoothstep(0.55, 0.9, luma);

// convert lag to greenish glow
vec3 lagGlow = lagSample * vec3(0.5, 0.9, 0.5);

// blend into highlights only
col += lagGlow * lagMask * 0.12;


  // ------------------------------------------------------------
  // ✅ Dirt / smudges (stronger edges, non-uniform)
  // ------------------------------------------------------------
  float dirt = 0.0;
  dirt += 0.65 * blob(uv, vec2(0.18, 0.22), 0.18, 0.24);
  dirt += 0.55 * blob(uv, vec2(0.82, 0.35), 0.16, 0.22);
  dirt += 0.45 * blob(uv, vec2(0.60, 0.82), 0.22, 0.28);

float grimeN = noise(uv * 5.0 + vec2(t * 0.03, -t * 0.02)); // ✅ 2D dirt, not horizontal bands
float grime = sat(edgeDark * (0.75 + grimeN * 0.50));

col *= (1.0 - uDirty * 0.18 * grime);
col *= (1.0 - uDirty * 0.16 * dirt);

// ------------------------------------------------------------
// ✅ Grain / sensor noise (luma-weighted so blacks stay dark)
// ------------------------------------------------------------

// 1) two noise sources: one “pixel” noise + one drifting noise
float n1 = rand(uv * (uResolution.xy * 0.85 + t * 37.0)) - 0.5;
float n2 = noise(uv * 6.0 + vec2(t * 0.25, -t * 0.18)) - 0.5;

// 2) combine noise (n1 = sharper, n2 = softer)
float n = n1 * 0.75 + n2 * 0.25;

// 3) shadows get more noise, highlights get less
float l01 = sat(l); // l is your post-curve luminance
float noiseAmt = mix(uNoiseLo, uNoiseHi, smoothstep(0.15, 0.85, l01));

// 4) apply: small amplitude so it never “washes” the image
col += n * noiseAmt;


  // ------------------------------------------------------------
  // ✅ Slight posterization (compression vibe)
  // ------------------------------------------------------------
  col = posterize(col, 96.0);

// ------------------------------------------------------------
// ✅ NVG TUBE VIGNETTE (aspect-correct + softer + more realistic)
// ------------------------------------------------------------

// aspect-correct circle (so vignette doesn't stretch on wide screens)
vec2 pp = uv - 0.5;
pp.x *= uResolution.x / max(1.0, uResolution.y);

float rr = length(pp);                 // 0 center → ~0.7 corners
float edge = smoothstep(0.35, 0.92, rr); // 0 center → 1 edges

// base tube falloff (darker edges)
float vig = 1.0 - edge * 0.55;          // strength (0.45–0.65 is good)

// subtle “center gain” like optics (keeps center readable)
float center = 1.0 - smoothstep(0.0, 0.55, rr); // 1 at center → 0 outward
col *= (1.0 + center * 0.06);

// apply vignette
col *= vig;

// ✅ CAMERA AUTO-GAIN (driven by JS)
col *= uGain;
col = clamp(col, 0.0, 1.0);

// (optional) tiny tube “breathing” — keep subtle so auto-gain is the star
float breathe = 1.0 + 0.01 * sin(t * 1.7) + 0.005 * sin(t * 4.1);
col *= breathe;



// ------------------------------------------------------------
// ✅ Output mix with original
// ------------------------------------------------------------

// ✅ tiny dither to kill banding (almost invisible)
float d = (rand(uv * uResolution.xy + t) - 0.5) / 255.0;
col += d;

vec3 outCol = mix(src0.rgb, col, uStrength);

// ------------------------------------------------------------
// ✅ Tube bloom (soft halo on bright areas)
// ------------------------------------------------------------

// Extract highlights
float bloomMask = smoothstep(0.65, 0.92, l);

// Soft glow color (slightly green-biased)
vec3 bloomCol = col * vec3(0.9, 1.05, 0.9);

// Blur approximation using neighbors (cheap)
vec2 px = 1.0 / uResolution;

vec3 blur =
    texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb +
    texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb +
    texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb +
    texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb;

blur *= 0.25;

// Blend bloom
col += blur * bloomCol * bloomMask * 0.35;


gl_FragColor = vec4(outCol, 1.0);

}
`,

  };

  nightVisionPass = new ShaderPass(nightVisionShader);
  composer.addPass(nightVisionPass);
}

let __baseExposure = null;

function setNightVision(on) {
  nightVisionOn = !!on;

  // capture baseline exposure once
  if (__baseExposure == null) {
    __baseExposure = renderer.toneMappingExposure ?? 1.0;
  }

  const isiOS = isIOSDevice();

  // ============================================================
  // ✅ Desktop: keep your EXACT current postFX behavior
  // ============================================================
  if (nightVisionPass) nightVisionPass.uniforms.uOn.value = nightVisionOn ? 1 : 0;

  if (nightVisionOn) {
    baseExposure = renderer.toneMappingExposure;

    aeGain = 1.45;
    aeSampleAccum = 0;
    if (nightVisionPass) nightVisionPass.uniforms.uGain.value = aeGain;

    renderer.toneMappingExposure = 1.15;
    hemi.intensity = 0.06;
  } else {
    renderer.toneMappingExposure = baseExposure ?? 0.9;
    hemi.intensity = 0.0;
  }

  if (typeof grainOverlay !== "undefined") {
    grainOverlay.style.opacity = nightVisionOn ? "0.06" : "0.015";
    grainOverlay.style.filter = nightVisionOn
      ? "contrast(155%) brightness(115%)"
      : "contrast(140%) brightness(90%)";
  }
}


const anchor = new THREE.Group();
scene.add(anchor);

let roomMaxDim = 1;

const camera = new THREE.PerspectiveCamera(
  32.5,
  window.innerWidth / window.innerHeight,
  0.001,
  1000000
);

// ============================================================
// ✅ Composer render target (critical for iOS quality)
// Replace your composer creation block with this
// ============================================================
function makeComposerRT() {
  const w = Math.max(2, Math.floor(window.innerWidth));
  const h = Math.max(2, Math.floor(window.innerHeight));

  // Prefer HalfFloat on devices that can actually render to it (iOS varies)
  const canHalfFloat =
    renderer.capabilities.isWebGL2 &&
    renderer.extensions?.has?.("EXT_color_buffer_float");

  const type = canHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

  const rt = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
  });

  // three r152+: colorSpace exists on textures
  if ("colorSpace" in rt.texture) rt.texture.colorSpace = THREE.SRGBColorSpace;

  return rt;
}

if (MOBILE_PROFILE.postFX || isIOSDevice()) {
  composer = new EffectComposer(renderer, makeComposerRT());
  initPostFX();
} else {
  composer = null;
  nightVisionPass = null;
}

let baseCamPos = null; 
let baseCamPos0 = null;
let baseCamDir0 = null;
let baseCamFov0 = null;
let baseCamTarget0 = null; 

// Desktop Camera Values
function setInitialCameraFraming(maxDim) {
  // keep your original FOV
  const fov = camera.fov * (Math.PI / 180);
  const baseDist = maxDim / (2 * Math.tan(fov / 2));

  // your original framing values
  const camX = maxDim * 0.030;
  const camY = maxDim * -0.146;
  const camZ = baseDist * 0.282;

  const targetX = 1.18;
  const targetY = maxDim * -0.186;
  const targetZ = 0;

  camera.position.set(camX, camY, camZ);
  camera.lookAt(targetX, targetY, targetZ);

  // store the exact target used
  baseCamTarget0 = new THREE.Vector3(targetX, targetY, targetZ);

  // store base camera position for breathing
  baseCamPos = camera.position.clone();
}

// iOS Camera Values ONLY (desktop untouched)
// Change these numbers to move iOS camera on X / Y / Z
// ============================================================
const IOS_CAM = {
    fov: 22,

  x: 0.02,    // + = right,  - = left
  y: -0.148,   // + = up,     - = down
  z: 0.224,    // + = farther, - = closer

  targetX: 1.18,
  targetY: -0.155, // multiplied by maxDim below
  targetZ: 0,
};

const IOS_LAMP = {
  scale: 1.0,
  x: 1.4,
  y: 0.2,
  z: 0.0,
};

function setIOSCameraFraming(maxDim) {
  camera.fov = IOS_CAM.fov;
  camera.updateProjectionMatrix();

  const fov = camera.fov * (Math.PI / 180);
  const baseDist = maxDim / (2 * Math.tan(fov / 2));

  // current iOS camera position
  const camX = maxDim * IOS_CAM.x;
  const camY = maxDim * IOS_CAM.y;
  const camZ = baseDist * IOS_CAM.z;

  // ORIGINAL iOS baseline values
  const baseCamX = maxDim * 0.030;
  const baseCamY = maxDim * -0.146;

  const baseTargetX = 1.18;
  const baseTargetY = maxDim * -0.186;
  const baseTargetZ = 0;

  // how far you moved the camera from baseline
  const dx = camX - baseCamX;
  const dy = camY - baseCamY;

  // move target by same amount so aim stays the same
  const targetX = baseTargetX + dx;
  const targetY = baseTargetY + dy;
  const targetZ = baseTargetZ;

  camera.position.set(camX, camY, camZ);
  camera.lookAt(targetX, targetY, targetZ);

  baseCamTarget0 = new THREE.Vector3(targetX, targetY, targetZ);
  baseCamPos = camera.position.clone();
}

function applyIOSLampTransform() {
  if (!isIOSDevice()) return;
  if (!lampMeshRef) return;

  const target = lampMeshRef; // ✅ only Lamp1, never parent Scene

  if (!target.userData.__iosLampBase) {
    target.userData.__iosLampBase = {
      position: target.position.clone(),
      scale: target.scale.clone(),
    };
  }

  const base = target.userData.__iosLampBase;

  target.position.set(
    base.position.x + IOS_LAMP.x,
    base.position.y + IOS_LAMP.y,
    base.position.z + IOS_LAMP.z
  );

  target.scale.set(
    base.scale.x * IOS_LAMP.scale,
    base.scale.y * IOS_LAMP.scale,
    base.scale.z * IOS_LAMP.scale
  );

  target.updateMatrixWorld(true);

  console.log("✅ iOS lamp transform applied:", {
    target: target.name,
    pos: target.position,
    scale: target.scale,
  });
}

// ============================================================
// ✅ FIXED CAMERA BASELINE (never changes after boot)
// ============================================================
let fixedCamPos0 = null;
let fixedCamQuat0 = null;
let fixedCamFov0  = null;
let fixedCamTarget0 = null;
let fixedCamCaptured = false;

function captureFixedCameraBaseline() {
  if (fixedCamCaptured) return;

  fixedCamPos0 = camera.position.clone();
  fixedCamQuat0 = camera.quaternion.clone();
  fixedCamFov0  = camera.fov;

  // you already set this earlier, but ensure it's stored
  if (baseCamTarget0) fixedCamTarget0 = baseCamTarget0.clone();
  else fixedCamTarget0 = new THREE.Vector3(0,0,0);

  fixedCamCaptured = true;
  console.log("✅ Fixed camera baseline captured");
}

// Layers: 0 = normal world, 2 = “accent only” objects (remote, skateboard)
camera.layers.enable(LAYER_WORLD);
camera.layers.enable(LAYER_ACCENT);
camera.layers.enable(LAYER_PIN);

// ============================================================
// DUST PARTICLES (3D in-world, slow + sparse + dusty) ✅
// ============================================================
let dustPoints = null;
let dustGeo = null;
let dustMat = null;

const DUST_COUNT = 320;        // fewer = more spaced out (try 220–500)
const DUST_BOX = {             // volume around camera (world units)
  x: 2.2,
  y: 1.3,
  z: 2.6,
};
const DUST_SPEED = 0.00006;      // slow drift (try 0.004–0.012)

// soft sprite texture so particles look like dusty “puffs”
const dustSprite = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");

  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.4, "rgba(255,255,255,0.22)");
  g.addColorStop(1.0, "rgba(255,255,255,0.0)");

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

function buildDust() {
  dustGeo = new THREE.BufferGeometry();

  const positions = new Float32Array(DUST_COUNT * 3);
  const velocities = new Float32Array(DUST_COUNT * 3);

  for (let i = 0; i < DUST_COUNT; i++) {
    const ix = i * 3;

    // spread out, in front of camera
    positions[ix + 0] = (Math.random() - 0.5) * DUST_BOX.x;
    positions[ix + 1] = (Math.random() - 0.5) * DUST_BOX.y;
    positions[ix + 2] = -Math.random() * DUST_BOX.z;

    // slow drift
    velocities[ix + 0] = (Math.random() - 0.5) * DUST_SPEED;
    velocities[ix + 1] = (Math.random() - 0.5) * DUST_SPEED * 0.7;
    velocities[ix + 2] = (Math.random() - 0.5) * DUST_SPEED * 0.35;
  }

  dustGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  dustGeo.setAttribute("velocity", new THREE.BufferAttribute(velocities, 3));

  dustMat = new THREE.PointsMaterial({
  color: 0xb9aa8d,
  map: dustSprite,
  alphaMap: dustSprite,
  transparent: true,
  opacity: 0.16,
  size: 0.015,
  sizeAttenuation: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
});


  dustPoints = new THREE.Points(dustGeo, dustMat);

  // Attach to camera so it floats in “room air” regardless of scene scale
  camera.add(dustPoints);
  dustPoints.position.set(0, 0, 0);

  // Make sure camera is in the scene graph
  if (!camera.parent) scene.add(camera);
}

// ------------------------------------------------------------
// DUST AIRFLOW (slowly changing breeze, no circular motion)
// ------------------------------------------------------------
const dustBreeze = new THREE.Vector3(0, 0, 0);
const dustBreezeTarget = new THREE.Vector3(0, 0, 0);
let dustBreezeNextT = 0;

//Heavier Dust Tuning (GLOBAL)
const MAX_V  = 0.000050;
const WANDER = 0.000006;
const BREEZE = 0.000010;
const DRAG   = 0.970;
const SETTLE = 0.0000045;

function updateDust(dt) {
  if (!dustGeo) return;

  const pos = dustGeo.attributes.position.array;
  const vel = dustGeo.attributes.velocity.array;

    // update breeze target occasionally (once per frame)
  const now = performance.now() * 0.001;
  if (now > dustBreezeNextT) {
    dustBreezeNextT = now + 2.5 + Math.random() * 4.0;
    dustBreezeTarget.set(
      (Math.random() * 2 - 1) * BREEZE,
      (Math.random() * 2 - 1) * BREEZE * 0.6,
      (Math.random() * 2 - 1) * BREEZE * 0.35
    );
  }
  dustBreeze.lerp(dustBreezeTarget, 0.02);

const S = dt * 60;

  for (let i = 0; i < DUST_COUNT; i++) {
    const ix = i * 3;

      // random-walk velocity (reduced so it feels heavier)
    vel[ix + 0] += (Math.random() * 2 - 1) * WANDER;
    vel[ix + 1] += (Math.random() * 2 - 1) * WANDER * 0.45; // less vertical float
    vel[ix + 2] += (Math.random() * 2 - 1) * WANDER * 0.35;

    // add breeze influence (subtle)
    vel[ix + 0] += dustBreeze.x;
    vel[ix + 1] += dustBreeze.y;
    vel[ix + 2] += dustBreeze.z;

    // ✅ settling / gravity (makes dust feel heavier)
    vel[ix + 1] -= SETTLE;

    // ✅ drag (heavier = more damping)
    vel[ix + 0] *= DRAG;
    vel[ix + 1] *= DRAG;
    vel[ix + 2] *= DRAG;


    // clamp speed so it never ramps up
    vel[ix + 0] = Math.max(-MAX_V, Math.min(MAX_V, vel[ix + 0]));
    vel[ix + 1] = Math.max(-MAX_V, Math.min(MAX_V, vel[ix + 1]));
    vel[ix + 2] = Math.max(-MAX_V, Math.min(MAX_V, vel[ix + 2]));

    pos[ix + 0] += vel[ix + 0] * S;
    pos[ix + 1] += vel[ix + 1] * S;
    pos[ix + 2] += vel[ix + 2] * S;


    // wrap bounds (keeps particles spread out + consistent)
    if (pos[ix + 0] >  DUST_BOX.x * 0.5) pos[ix + 0] = -DUST_BOX.x * 0.5;
    if (pos[ix + 0] < -DUST_BOX.x * 0.5) pos[ix + 0] =  DUST_BOX.x * 0.5;

    if (pos[ix + 1] >  DUST_BOX.y * 0.5) pos[ix + 1] = -DUST_BOX.y * 0.5;
    if (pos[ix + 1] < -DUST_BOX.y * 0.5) pos[ix + 1] =  DUST_BOX.y * 0.5;

    // keep them in front of camera (z is negative)
    if (pos[ix + 2] > 0) pos[ix + 2] = -DUST_BOX.z;
    if (pos[ix + 2] < -DUST_BOX.z) pos[ix + 2] = 0;
  }

  dustGeo.attributes.position.needsUpdate = true;
}

// ENVIRONMENT (IBL)
// ============================================================
const __endEnv = __beginAsset("Environment");

const pmrem = new THREE.PMREMGenerator(renderer);

const envRT = pmrem.fromScene(new RoomEnvironment(), 0.0);

scene.environment = envRT.texture;

// Give GPU one frame to finish
requestAnimationFrame(() => {
  __endEnv();
});

buildDust();
// ============================================================
// SOFT FILL (prevents black crush, very subtle)
// ============================================================
const hemi = new THREE.HemisphereLight(0x2b3140, 0x0b0b0b, 0.0);
scene.add(hemi);


// ============================================================
// LIGHTING
// ============================================================
RectAreaLightUniformsLib.init();

let nightLights = null;
let remoteMeshRef = null;
let skateboardMeshRef = null;

let lampMeshRef = null; 
let lampGroupRef = null;
let nightVisionOn = false; 
let chainMeshRef = null;

let lampMood = 0; // 0 = warm (default), 1 = cold/blue, 2 = red (optional)


//Bug Animation
let bugMixer = null;
let bugActions = [];

// ============================================================
// LAMP FLICKER (subtle, cinematic)
// ============================================================
let lampBaseKeyI = null;
let lampBaseShadowI = null;

let lampNoise = 0;
let lampNoiseTarget = 0;
let lampNoiseNextT = 0;

function updateLampFlicker() {
  if (!nightLights?.lampKey || !nightLights?.lampShadow) return;

  // cache base intensities once
  if (lampBaseKeyI === null) {
    lampBaseKeyI = nightLights.lampKey.intensity;
    lampBaseShadowI = nightLights.lampShadow.intensity;

    console.log("💡 Lamp flicker running. Base:", {
      key: lampBaseKeyI,
      shadow: lampBaseShadowI
    });
  }

  function updateCigaretteEmber_OLD() {
  if (!emberTipRef || !emberTipRef.material) return;

  const t = performance.now() * 0.003;

  // subtle breathing glow
  const flicker =
    0.8 +
    Math.sin(t * 3.0) * 0.2 +
    Math.sin(t * 9.5) * 0.05 +
    Math.random() * 0.05;

  emberTipRef.material.emissiveIntensity = flicker * 2.2;
}

  const t = performance.now() / 1000;

  // ------------------------------------------------------------
  // 1) ALWAYS-ON slow drift (very slow, subtle)
  // ------------------------------------------------------------
  const slow = 0.03 * Math.sin(t * 0.55); // ~1 cycle every ~11s

  // ------------------------------------------------------------
  // 2) RARE “BURST” flicker (slower, more intense)
  // ------------------------------------------------------------
  // one-time init for burst state
  if (typeof window.__lampBurstInit === "undefined") {
    window.__lampBurstInit = true;
    window.lampBurstUntil = 0;
    window.lampNextBurstAt = t + 2.5 + Math.random() * 5.0; // first burst in 2.5–7.5s
  }


  // trigger burst occasionally
if (t > window.lampNextBurstAt && t > window.lampBurstUntil) {
  const dur = 0.35 + Math.random() * 1.1; // 0.35–1.45s
  window.lampBurstStart = t;
  window.lampBurstUntil = t + dur;

  // randomize next burst timing (varies more over long sessions)
  window.lampNextBurstAt = t + 7.0 + Math.random() * 14.0; // 7–21s

  // ✅ create a UNIQUE “signature” for this burst (saved once)
  window.lampBurstParams = {
    f1: 4.0 + Math.random() * 6.0,      // 4–10 Hz
    f2: 1.5 + Math.random() * 4.0,      // 1.5–5.5 Hz
    ph1: Math.random() * Math.PI * 2,
    ph2: Math.random() * Math.PI * 2,
    a1: 0.08 + Math.random() * 0.16,    // amplitude 0.08–0.24
    a2: 0.04 + Math.random() * 0.12,    // amplitude 0.04–0.16
    bias: (Math.random() * 2 - 1) * 0.06, // shifts burst up/down (-0.06..0.06)
    noiseStep: 0.10 + Math.random() * 0.25, // how often noise changes (0.10–0.35s)
    noiseMax: 0.06 + Math.random() * 0.16,  // noise strength (0.06–0.22)
  };

  // reset noise state each burst so it doesn't “learn a pattern”
  window.lampNoiseNextT = 0;
  window.lampNoiseTarget = 0;
  window.lampNoise = 0;
}

let burst = 0;

// during a burst, use burst-specific params + a randomized envelope
if (t < window.lampBurstUntil && window.lampBurstParams) {
  const p = window.lampBurstParams;

  // ✅ envelope so every burst has a different "attack/decay" feel
  const u = (t - window.lampBurstStart) / (window.lampBurstUntil - window.lampBurstStart); // 0..1
  // smoothstep-ish (soft edges)
  const env = Math.sin(u * Math.PI); // 0→1→0

  burst =
    env * (p.a1 * Math.sin(t * p.f1 * Math.PI * 2 + p.ph1) +
           p.a2 * Math.sin(t * p.f2 * Math.PI * 2 + p.ph2)) +
    env * p.bias;

  // ✅ stepped noise with randomized cadence per burst
  if (t > window.lampNoiseNextT) {
    window.lampNoiseNextT = t + p.noiseStep;
    window.lampNoiseTarget = (Math.random() * 2 - 1) * p.noiseMax;
  }
  window.lampNoise += (window.lampNoiseTarget - window.lampNoise) * 0.18;

  burst += env * window.lampNoise;
} else {
  // outside bursts, fade noise back to 0
  if (window.lampNoise) window.lampNoise *= 0.90;
}


  // combine
  const mult = 1 + slow + burst;

  // clamp (lets it dip and spike but not break)
  const clamped = Math.max(0.78, Math.min(1.18, mult));

  nightLights.lampKey.intensity = lampBaseKeyI * clamped;
  nightLights.lampShadow.intensity = lampBaseShadowI * clamped;
}

// ============================================================
// ✅ iOS REMOTE PERSPECTIVE FIX
// - ONLY affects iOS
// - does NOT touch desktop
// - does NOT change camera
// - narrows remote slightly on X
// - pushes remote slightly farther from camera
// ============================================================
const IOS_REMOTE_TWEAK = {
  enabled: true,

  // make the remote look less wide
  // lower = narrower
  scaleX: 0.90,
  scaleY: 1.00,
  scaleZ: 1.00,

  // push remote slightly away from camera
  // this is multiplied by roomMaxDim
  pushBackFactor: 0.000,

  offsetX: 7.5,
  offsetY: -0.1,
  offsetZ: 3.5,
};

// ============================================================
// ✅ iOS REMOTE BUTTON OFFSETS
// - ONLY for the 6 remote buttons
// - DO NOT affect desktop
// - DO NOT affect remote body
// ============================================================
const IOS_REMOTE_BUTTON_TWEAK = {
  enabled: true,

  power: { x: 0.15, y: -0.1, z: 3.5 }, // x
  up:    { x: 0.04, y: -0.115, z: 3.55 },
  down:  { x: 0.02, y: -0.115, z: 3.55 },
  left:  { x: 0.065, y: -0.115, z: 3.55 },
  right: { x: -0.02, y: -0.115, z: 3.55 },
  ok:    { x: 0.02, y: -0.115, z: 3.55 },
};


function pushMeshAwayFromCamera(mesh, amount) {
  if (!mesh || !mesh.parent || !camera) return;

  // get current mesh world position
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);

  // direction from camera -> mesh
  const dir = worldPos.clone().sub(camera.position).normalize();

  // move farther away from camera
  const newWorldPos = worldPos.clone().addScaledVector(dir, amount);

  // convert world position back into mesh parent's local space
  mesh.parent.worldToLocal(newWorldPos);
  mesh.position.copy(newWorldPos);
}

function applyIOSRemoteTweakToMesh(mesh) {
  if (!isIOSDevice()) return;
  if (!IOS_REMOTE_TWEAK.enabled) return;
  if (!mesh) return;

  // prevent double-applying
  if (mesh.userData.__iosRemoteTweaked) return;

  // ✅ this function is now for the REMOTE BODY ONLY
  mesh.scale.x *= IOS_REMOTE_TWEAK.scaleX;
  mesh.scale.y *= IOS_REMOTE_TWEAK.scaleY;
  mesh.scale.z *= IOS_REMOTE_TWEAK.scaleZ;

  const pushAmount = roomMaxDim * IOS_REMOTE_TWEAK.pushBackFactor;
  pushMeshAwayFromCamera(mesh, pushAmount);

  mesh.position.x += IOS_REMOTE_TWEAK.offsetX;
  mesh.position.y += IOS_REMOTE_TWEAK.offsetY;
  mesh.position.z += IOS_REMOTE_TWEAK.offsetZ;

  mesh.updateMatrixWorld(true);

  mesh.userData.__iosRemoteTweaked = true;
}

function applyIOSButtonOffset(mesh, offset, keyName) {
  if (!isIOSDevice()) return;
  if (!IOS_REMOTE_BUTTON_TWEAK.enabled) return;
  if (!mesh) return;
  if (!offset) return;

  // prevent double-applying
  if (mesh.userData.__iosButtonTweaked) return;

  // ----------------------------------------------------------
  // 1) First apply your current tuned position offset
  // ----------------------------------------------------------
  mesh.position.x += offset.x;
  mesh.position.y += offset.y;
  mesh.position.z += offset.z;

  mesh.updateMatrixWorld(true);

  // ----------------------------------------------------------
  // 2) Capture current world-space CENTER before scaling
  // ----------------------------------------------------------
  const boxBefore = new THREE.Box3().setFromObject(mesh);
  const centerBefore = boxBefore.getCenter(new THREE.Vector3());

  // ----------------------------------------------------------
  // 3) Apply the same X compression as the remote body
  // ----------------------------------------------------------
  mesh.scale.x *= IOS_REMOTE_TWEAK.scaleX;

  mesh.updateMatrixWorld(true);

  // ----------------------------------------------------------
  // 4) Capture world-space CENTER after scaling
  // ----------------------------------------------------------
  const boxAfter = new THREE.Box3().setFromObject(mesh);
  const centerAfter = boxAfter.getCenter(new THREE.Vector3());

  // ----------------------------------------------------------
  // 5) Move mesh so its center goes back to where it was
  // ----------------------------------------------------------
  const deltaWorld = centerBefore.clone().sub(centerAfter);

  const parent = mesh.parent;
  if (parent) {
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);

    const correctedWorldPos = worldPos.clone().add(deltaWorld);

    parent.worldToLocal(correctedWorldPos);
    mesh.position.copy(correctedWorldPos);
  }

  mesh.updateMatrixWorld(true);

  // ----------------------------------------------------------
  // 6) Update press-state base position so updatePress()
  //    does not snap the button back every frame
  // ----------------------------------------------------------
  const st = pressState.get(mesh);
  if (st) {
    st.basePos.copy(mesh.position);
  }

  mesh.userData.__iosButtonTweaked = true;

  console.log(`✅ iOS button scaled+kept in place: ${keyName}`, mesh.position);
}

function applyIOSRemoteTweaks() {
  if (!isIOSDevice()) return;

  // ==========================================================
  // REMOTE BODY ONLY
  // ==========================================================
  applyIOSRemoteTweakToMesh(remoteMeshRef);

  // ==========================================================
  // BUTTONS ONLY
  // ==========================================================
  applyIOSButtonOffset(powerButtonMeshRef, IOS_REMOTE_BUTTON_TWEAK.power, "power");
  applyIOSButtonOffset(okButtonMeshRef,    IOS_REMOTE_BUTTON_TWEAK.ok,    "ok");
  applyIOSButtonOffset(upArrowMeshRef,     IOS_REMOTE_BUTTON_TWEAK.up,    "up");
  applyIOSButtonOffset(downArrowMeshRef,   IOS_REMOTE_BUTTON_TWEAK.down,  "down");
  applyIOSButtonOffset(leftArrowMeshRef,   IOS_REMOTE_BUTTON_TWEAK.left,  "left");
  applyIOSButtonOffset(rightArrowMeshRef,  IOS_REMOTE_BUTTON_TWEAK.right, "right");
}

// ============================================================
// INTERACTION (raycast clickables -> power button toggles TV)
// ============================================================
const raycaster = new THREE.Raycaster();
raycaster.layers.enable(0);
raycaster.layers.enable(2);
raycaster.layers.enable(3);
const pointer = new THREE.Vector2();

const clickables = []; // meshes we allow clicks on

let powerButtonMeshRef = null;
let tvScreenMeshRef = null;
let tvScreenMatRef = null;      // ✅ keep ONE stable material reference
let interactivesRootRef = null; // ✅ store the UI root for raycasting
let tvScreenScale0 = new THREE.Vector3(1, 1, 1); // ✅ remembers original TV screen scale
let speakerMeshRef = null;
let upArrowMeshRef = null;
let downArrowMeshRef = null;
let okButtonMeshRef = null;
let leftArrowMeshRef = null;
let rightArrowMeshRef = null;

// ============================================================
// ✅ BUTTON PRESS (push down while pressed) — robust direction
// ============================================================
const PRESS_DEPTH_FACTOR = 0.0007; // scaled by roomMaxDim (increase to 0.0022 if needed)
const PRESS_LERP  = 0.35;

const pressState = new Map(); // mesh -> { basePos, t, target, axisLocal }

function getPressDepth() {
  return Math.max(0.0008, roomMaxDim * PRESS_DEPTH_FACTOR);
}

function ensurePressState(mesh) {
  if (!mesh || pressState.has(mesh)) return;

  pressState.set(mesh, {
    basePos: mesh.position.clone(),
    t: 0,
    target: 0,
    axisLocal: new THREE.Vector3(0, 0, -1), // fallback direction
  });
}

// ✅ uses the raycast hit face normal so it presses "into" the clicked surface
function setPressAxisFromHit(mesh, hit) {
  if (!mesh || !hit?.face) return;

  ensurePressState(mesh);
  const st = pressState.get(mesh);
  if (!st) return;

  // face normal is in hit.object local space
  const nLocal = hit.face.normal.clone();

  // convert normal to WORLD space
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
  const nWorld = nLocal.applyMatrix3(normalMatrix).normalize();

  // press INTO the surface (opposite the normal)
  nWorld.multiplyScalar(-1);

  // convert world direction into mesh PARENT local space (position is parent-space)
  const parent = mesh.parent;
  if (!parent) return;

  const parentWorldQuat = new THREE.Quaternion();
  parent.getWorldQuaternion(parentWorldQuat);

  const axisParentLocal = nWorld.clone().applyQuaternion(parentWorldQuat.invert()).normalize();
  st.axisLocal.copy(axisParentLocal);
}

function setPressTarget(mesh, pressed) {
  if (!mesh) return;
  ensurePressState(mesh);
  const st = pressState.get(mesh);
  if (!st) return;

  st.target = pressed ? 1 : 0;
}

function updatePress() {
  const depth = getPressDepth();

  pressState.forEach((st, mesh) => {
    if (!mesh) return;

    st.t += (st.target - st.t) * PRESS_LERP;

    mesh.position.copy(st.basePos);
    mesh.position.addScaledVector(st.axisLocal, depth * st.t);
  });
}

function clearAllButtonPresses() {
  pressState.forEach((st) => (st.target = 0));
}

// ============================================================
// HOVER GLOW (remote buttons) ✅
// - Non-power buttons: same glow color
// - Power button: slight red glow
// - Does NOT swap materials, only tweaks emissive temporarily
// ============================================================

// glow colors
const REMOTE_GLOW_COLOR = new THREE.Color(0xf5f8ff); // cool glow (change if you want)
const POWER_GLOW_COLOR  = new THREE.Color(0xff3a3a); // slight red glow

// how strong the glow gets
const REMOTE_GLOW_INTENSITY = 0.70;  // subtle glow
const POWER_GLOW_INTENSITY  = 0.50;  // slightly stronger but still subtle

const GLOW_TINT_STRENGTH = 0.20;

const GLOW_LERP_IN  = 0.22; // default fade in
const GLOW_LERP_OUT = 0.22; // default fade out (non-power)
const POWER_GLOW_LERP_OUT = 0.45; // faster power fade out

// ✅ Remote nav buttons: slower / softer like iOS
const REMOTE_NAV_GLOW_LERP_IN  = 0.10;
const REMOTE_NAV_GLOW_LERP_OUT = 0.10;
const MAX_GLOW_HOVER_MS = 2000;

const glowState = new Map(); 
// mesh -> { baseE, baseI, t, color, target, hoverStartMs, forcedOff }


function ensureGlowState(mesh, glowColor) {
  if (!mesh || !mesh.material) return;

  // if it's multi-material, pick the first MeshStandardMaterial-like entry
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (!mat) return;

  // only works safely on standard / physical materials that have emissive
  if (!("emissive" in mat) || !("emissiveIntensity" in mat)) return;

  if (glowState.has(mesh)) return;

  // clone base emissive so we can restore it exactly
  const baseE = mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000);
  const baseI = typeof mat.emissiveIntensity === "number" ? mat.emissiveIntensity : 0;

  glowState.set(mesh, {
    baseE,
    baseI,
    t: 0,                 // current 0..1
    target: 0,            // desired 0..1
    color: glowColor.clone(),

    hoverStartMs: 0,
    forcedOff: false,
  });
}

function setGlowTarget(mesh, targetOn, glowColor) {
  if (!mesh) return;
  ensureGlowState(mesh, glowColor);

  const st = glowState.get(mesh);
  if (!st) return;

  st.color.copy(glowColor);

  const now = performance.now();

  if (targetOn) {
    // starting hover (or still hovering)
    if (st.hoverStartMs === 0) st.hoverStartMs = now;

    // if we already forced it off during this hover, keep it off until hover ends
    if (st.forcedOff) {
      st.target = 0;
      return;
    }

    // if hover has lasted longer than the max, force fade out
    if (now - st.hoverStartMs >= MAX_GLOW_HOVER_MS) {
      st.forcedOff = true;
      st.target = 0;
      return;
    }

    // otherwise allow glow on
    st.target = 1;
  } else {
    // hover ended — reset timer/forced state so next hover can glow again
    st.hoverStartMs = 0;
    st.forcedOff = false;
    st.target = 0;
  }
}

// ✅ NEW: force all button glows OFF (resets timers/forcedOff)
function clearAllButtonGlows() {
  setGlowTarget(powerButtonMeshRef, false, POWER_GLOW_COLOR);

  setGlowTarget(okButtonMeshRef,    false, REMOTE_GLOW_COLOR);
  setGlowTarget(upArrowMeshRef,     false, REMOTE_GLOW_COLOR);
  setGlowTarget(downArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(leftArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(rightArrowMeshRef,  false, REMOTE_GLOW_COLOR);
}

// ============================================================
// ✅ iOS REMOTE "ATTENTION PULSE"
// ============================================================
const IOS_PULSE_ON_MS  = 2000;
const IOS_PULSE_OFF_MS = 3000;

const IOS_POWER_ON_MS  = 2000;
const IOS_POWER_OFF_MS = 3000;

let iosPulseTimer = null;
let iosPulseOn = false;
let iosNextPulseAtMs = 0;     // when the next ON pulse should start
let iosPulseStarted = false;  // helps initialize schedule once
let iosRemoteRippleTimers = [];
let iosRemotePulseCycleId = 0; // ✅ invalidates stale ripple timeouts

function setRemoteGlowPulse(on) {
  if (iosSoloGlowActive) return;
  if (overlayOpen || videoOverlayOpen || modelOverlayOpen) return;

  clearIOSRemoteRippleTimers();

  // ✅ each call gets a unique pulse id so old stagger timers can't interfere
  const pulseId = ++iosRemotePulseCycleId;

  if (!tvOn) {
    setGlowTarget(powerButtonMeshRef, on, POWER_GLOW_COLOR);
    forceAllRemoteNavGlowOff();
    return;
  }

  // TV ON → power button should not glow
  setGlowTarget(powerButtonMeshRef, false, POWER_GLOW_COLOR);

  // ✅ OFF state: hard turn all nav buttons off together
  if (!on) {
    forceAllRemoteNavGlowOff();
    return;
  }

  // ✅ if repeating pulse has been disabled, do not pulse
  if (!iosRemotePulseArmed) {
    forceAllRemoteNavGlowOff();
    return;
  }

  // ✅ IMPORTANT: hard reset all nav buttons OFF before every new ripple
  forceAllRemoteNavGlowOff();

  // center → outward ripple
  iosRemoteRippleTimers.push(setTimeout(() => {
    if (pulseId !== iosRemotePulseCycleId) return;
    if (!iosRemotePulseArmed || iosSoloGlowActive || !tvOn) return;
    setGlowTarget(okButtonMeshRef, true, REMOTE_GLOW_COLOR);
  }, 0));

  iosRemoteRippleTimers.push(setTimeout(() => {
    if (pulseId !== iosRemotePulseCycleId) return;
    if (!iosRemotePulseArmed || iosSoloGlowActive || !tvOn) return;
    setGlowTarget(upArrowMeshRef, true, REMOTE_GLOW_COLOR);
    setGlowTarget(downArrowMeshRef, true, REMOTE_GLOW_COLOR);
  }, 80));

  iosRemoteRippleTimers.push(setTimeout(() => {
    if (pulseId !== iosRemotePulseCycleId) return;
    if (!iosRemotePulseArmed || iosSoloGlowActive || !tvOn) return;
    setGlowTarget(leftArrowMeshRef, true, REMOTE_GLOW_COLOR);
    setGlowTarget(rightArrowMeshRef, true, REMOTE_GLOW_COLOR);
  }, 160));
}

function stopIosRemotePulse() {
  if (iosPulseTimer) {
    clearTimeout(iosPulseTimer);
    iosPulseTimer = null;
  }

  clearIOSRemoteRippleTimers();

  // ✅ kill any stale stagger callbacks from older pulse cycles
  iosRemotePulseCycleId++;

  iosPulseOn = false;
  forceAllRemoteNavGlowOff();
  setRemoteGlowPulse(false);
}

function startIosRemotePulse() {
  if (!isIOSDevice()) return;
  if (!iosRemotePulseArmed) return;

  // prevent duplicates
  stopIosRemotePulse();

  const now = performance.now();

  if (!iosPulseStarted || !iosNextPulseAtMs) {
    iosPulseStarted = true;

    // ✅ small startup delay so the first OK glow is visible after TV power-on settles
    const firstOnDelayMs = 220;

    iosPulseTimer = setTimeout(() => {
      if (!tvOn || !iosRemotePulseArmed) return;

      iosPulseOn = true;
      setRemoteGlowPulse(true);

      // after ON window ends, schedule next ON time
      iosNextPulseAtMs = performance.now() + IOS_PULSE_ON_MS + IOS_PULSE_OFF_MS;

      iosPulseTimer = setTimeout(() => {
        iosPulseOn = false;
        setRemoteGlowPulse(false);

        // schedule next ON
        scheduleNextPulseTick();
      }, IOS_PULSE_ON_MS);

    }, firstOnDelayMs);

    return;
  }

  // Otherwise resume to the existing cadence:
  scheduleNextPulseTick();
}

function scheduleNextPulseTick() {
  // schedule the next ON based on iosNextPulseAtMs
  const now = performance.now();
  const waitMs = Math.max(0, iosNextPulseAtMs - now);

  iosPulseTimer = setTimeout(() => {
    // If we’re not in a state to pulse, keep cadence but don’t glow
    if (overlayOpen || videoOverlayOpen || modelOverlayOpen) {
      iosPulseOn = false;
      setRemoteGlowPulse(false);

      // keep cadence: next ON still 8s after what would have been ON start
      iosNextPulseAtMs = performance.now() + IOS_PULSE_OFF_MS;
      scheduleNextPulseTick();
      return;
    }

    // turn ON for 2s
    iosPulseOn = true;
    setRemoteGlowPulse(true);

    iosPulseTimer = setTimeout(() => {
      iosPulseOn = false;
      setRemoteGlowPulse(false);

      // set next ON time (8s after this ON window ends)
      iosNextPulseAtMs = performance.now() + IOS_PULSE_OFF_MS;
      scheduleNextPulseTick();
    }, IOS_PULSE_ON_MS);

  }, waitMs);
}

function nudgeIosRemotePulse() {
  if (!isIOSDevice()) return;
  // turn off now, then restart timing so it doesn't instantly pulse again
  stopIosRemotePulse();
  startIosRemotePulse();
}

// ============================================================
// ✅ iOS "SOLO PRESS" OVERRIDE
// - Idle: pulse all remote buttons together
// - On press: ONLY the pressed button glows briefly
// ============================================================
let iosSoloGlowTimer = null;
let iosSoloGlowActive = false;
let iosRemotePulseArmed = true;

function stopIosSoloGlow() {
  if (iosSoloGlowTimer) {
    clearTimeout(iosSoloGlowTimer);
    iosSoloGlowTimer = null;
  }
  iosSoloGlowActive = false;
}

function markIosRemoteUsed() {
  if (!isIOSDevice()) return;
  if (!tvOn) return;

  // ✅ permanently stop the repeating pulse for this TV-on session
  iosRemotePulseArmed = false;
  stopIosRemotePulse();

  // ✅ IMPORTANT: do NOT force all button glows off here
  // iosSoloGlow() should still be allowed to show the pressed-button emission
}

// Call this when a remote button is pressed on iOS
function iosSoloGlow(mesh, ms = 900) {
  if (!isIOSDevice()) return;

  // Stop the repeating pulse so it doesn't fight the solo glow
  stopIosRemotePulse();
  stopIosSoloGlow();

if (!iosNextPulseAtMs) iosNextPulseAtMs = performance.now() + IOS_PULSE_OFF_MS;

  iosSoloGlowActive = true;

  // Turn OFF everything first
  setGlowTarget(powerButtonMeshRef, false, POWER_GLOW_COLOR);
  setGlowTarget(okButtonMeshRef,    false, REMOTE_GLOW_COLOR);
  setGlowTarget(upArrowMeshRef,     false, REMOTE_GLOW_COLOR);
  setGlowTarget(downArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(leftArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(rightArrowMeshRef,  false, REMOTE_GLOW_COLOR);

  // Turn ON only the pressed one
  setGlowTarget(mesh, true, REMOTE_GLOW_COLOR);

  iosSoloGlowTimer = setTimeout(() => {
    // Turn it back OFF
    setGlowTarget(mesh, false, REMOTE_GLOW_COLOR);

    iosSoloGlowActive = false;

    // ✅ only restart repeating pulse if it has NOT been permanently disabled
    if (iosRemotePulseArmed) {
      startIosRemotePulse();
    }
  }, ms);
}


function updateGlow() {
  glowState.forEach((st, mesh) => {

        // ✅ enforce the 2s hover cutoff even if pointermove isn't firing
    if (st.target === 1 && st.hoverStartMs && !st.forcedOff) {
      const now = performance.now();
      if (now - st.hoverStartMs >= MAX_GLOW_HOVER_MS) {
        st.forcedOff = true;
        st.target = 0;
      }
    }

    if (!mesh || !mesh.material) return;

    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat || !("emissive" in mat) || !("emissiveIntensity" in mat)) return;

const isPower = st.color.equals(POWER_GLOW_COLOR);

// ✅ identify the nav buttons so desktop can use the softer iOS-like fade
const isRemoteNav =
  mesh === okButtonMeshRef ||
  mesh === upArrowMeshRef ||
  mesh === downArrowMeshRef ||
  mesh === leftArrowMeshRef ||
  mesh === rightArrowMeshRef;

let lerpSpeed;

if (st.target > st.t) {
  // fading IN
  if (isRemoteNav) lerpSpeed = REMOTE_NAV_GLOW_LERP_IN;
  else lerpSpeed = GLOW_LERP_IN;
} else {
  // fading OUT
  if (isPower) lerpSpeed = POWER_GLOW_LERP_OUT;
  else if (isRemoteNav) lerpSpeed = REMOTE_NAV_GLOW_LERP_OUT;
  else lerpSpeed = GLOW_LERP_OUT;
}

st.t += (st.target - st.t) * lerpSpeed;
  
// choose intensity amount depending on which glow color is being used
const glowI = isPower ? POWER_GLOW_INTENSITY : REMOTE_GLOW_INTENSITY;


    // restore base, then add glow on top
    // ✅ reduce color wash so you can still see the arrow texture
    mat.emissive.copy(st.baseE).lerp(st.color, st.t * GLOW_TINT_STRENGTH);
    mat.emissiveIntensity = st.baseI + glowI * st.t;

    mat.needsUpdate = true;
  });
}

// ============================================================
// FULLSCREEN PHOTO OVERLAY (TV double-click)
// ============================================================
let currentPhotoUrl = null;
let overlayOpen = false;

// ============================================================
// TV HOVER HINT (Click to Fullscreen)
// ============================================================

const tvHint = document.createElement("div");

tvHint.innerText = "double click to view fullscreen";

tvHint.style.position = "fixed";
tvHint.style.left = "50%";
tvHint.style.bottom = "80px";
tvHint.style.transform = "translateX(-50%)";

tvHint.style.padding = "8px 16px";
tvHint.style.borderRadius = "20px";

tvHint.style.background = "rgba(0,0,0,0.6)";
tvHint.style.color = "#fff";
tvHint.style.fontSize = "14px";
tvHint.style.fontFamily = "Arial, sans-serif";

tvHint.style.pointerEvents = "none";
tvHint.style.opacity = "0";
tvHint.style.transition = "opacity 0.25s ease";

tvHint.style.zIndex = "9998";

document.body.appendChild(tvHint);

let tvHintVisible = false;

function showTvHint(show) {
  if (show === tvHintVisible) return;

  tvHintVisible = show;
  tvHint.style.opacity = show ? "1" : "0";
}

// ============================================================
// POWER BUTTON HOVER HINT (Click to turn TV on/off)
// ============================================================
const powerHint = document.createElement("div");
powerHint.innerText = "turn tv on";

powerHint.style.position = "fixed";
powerHint.style.left = "50%";
powerHint.style.bottom = "80px";
powerHint.style.transform = "translateX(-50%)";

powerHint.style.padding = "8px 16px";
powerHint.style.borderRadius = "20px";

powerHint.style.background = "rgba(0,0,0,0.6)";
powerHint.style.color = "#fff";
powerHint.style.fontSize = "14px";
powerHint.style.fontFamily = "Arial, sans-serif";

powerHint.style.pointerEvents = "none";
powerHint.style.opacity = "0";
powerHint.style.transition = "opacity 0.25s ease";

powerHint.style.zIndex = "9998";

document.body.appendChild(powerHint);

let powerHintVisible = false;

function showPowerHint(show) {
  if (show === powerHintVisible) return;

  powerHintVisible = show;
  powerHint.style.opacity = show ? "1" : "0";
}

// ✅ smart text based on tvOn
function updatePowerHintText() {
  powerHint.innerText = tvOn ? "turn tv off" : "turn tv on";
}

// ============================================================
// LAMP HOVER HINT (Press to turn on/off)
// ============================================================
const lampHint = document.createElement("div");
lampHint.innerText = ""; // ✅ don’t hardcode default text

lampHint.style.position = "fixed";
lampHint.style.left = "50%";
lampHint.style.bottom = "80px";
lampHint.style.transform = "translateX(-50%)";

lampHint.style.padding = "8px 16px";
lampHint.style.borderRadius = "20px";

lampHint.style.background = "rgba(0,0,0,0.6)";
lampHint.style.color = "#fff";
lampHint.style.fontSize = "14px";
lampHint.style.fontFamily = "Arial, sans-serif";

lampHint.style.pointerEvents = "none";
lampHint.style.opacity = "0";
lampHint.style.transition = "opacity 0.25s ease";

lampHint.style.zIndex = "9998";

document.body.appendChild(lampHint);

let lampHintVisible = false;

function showLampHint(show) {
  if (show === lampHintVisible) return;
  lampHintVisible = show;
  lampHint.style.opacity = show ? "1" : "0";
}

// ✅ smart text based on lamp state
// NOTE: pick ONE source of truth for "on/off":
// If your lamp is considered "ON" when lampMood === 1, keep this.
// If it's the opposite, just flip the condition.
function updateLampHintText() {
  const lampOn = (lampMood === 0); // <-- if backwards, change to (lampMood === 0)
  lampHint.innerText = lampOn ? "press to turn off" : "press to turn on";
}

// ============================================================
// ALL DVD HOVER HINT (Press to watch gummo)
// ============================================================
const allDvdHint = document.createElement("div");
allDvdHint.innerText = "press to watch gummo";

allDvdHint.style.position = "fixed";
allDvdHint.style.left = "50%";
allDvdHint.style.bottom = "80px";
allDvdHint.style.transform = "translateX(-50%)";

allDvdHint.style.padding = "8px 16px";
allDvdHint.style.borderRadius = "20px";

allDvdHint.style.background = "rgba(0,0,0,0.6)";
allDvdHint.style.color = "#fff";
allDvdHint.style.fontSize = "14px";
allDvdHint.style.fontFamily = "Arial, sans-serif";

allDvdHint.style.pointerEvents = "none";
allDvdHint.style.opacity = "0";
allDvdHint.style.transition = "opacity 0.25s ease";

allDvdHint.style.zIndex = "9998";

document.body.appendChild(allDvdHint);

let allDvdHintVisible = false;

function showAllDvdHint(show) {
  if (show === allDvdHintVisible) return;
  allDvdHintVisible = show;
  allDvdHint.style.opacity = show ? "1" : "0";
}

// ============================================================
// DVD_on_Player1 HOVER HINT (Press to watch decline of western civilization)
// ============================================================
const dvdPlayer1Hint = document.createElement("div");
dvdPlayer1Hint.innerText = "press to watch decline of western civilization";

dvdPlayer1Hint.style.position = "fixed";
dvdPlayer1Hint.style.left = "50%";
dvdPlayer1Hint.style.bottom = "80px";
dvdPlayer1Hint.style.transform = "translateX(-50%)";

dvdPlayer1Hint.style.padding = "8px 16px";
dvdPlayer1Hint.style.borderRadius = "20px";

dvdPlayer1Hint.style.background = "rgba(0,0,0,0.6)";
dvdPlayer1Hint.style.color = "#fff";
dvdPlayer1Hint.style.fontSize = "14px";
dvdPlayer1Hint.style.fontFamily = "Arial, sans-serif";

dvdPlayer1Hint.style.pointerEvents = "none";
dvdPlayer1Hint.style.opacity = "0";
dvdPlayer1Hint.style.transition = "opacity 0.25s ease";

dvdPlayer1Hint.style.zIndex = "9998";

document.body.appendChild(dvdPlayer1Hint);

let dvdPlayer1HintVisible = false;

function showDvdPlayer1Hint(show) {
  if (show === dvdPlayer1HintVisible) return;
  dvdPlayer1HintVisible = show;
  dvdPlayer1Hint.style.opacity = show ? "1" : "0";
}

// ============================================================
// BOOK4 HOVER HINT (Press to watch tweaked)
// ============================================================
const book4Hint = document.createElement("div");
book4Hint.innerText = "press to read tweaked";

book4Hint.style.position = "fixed";
book4Hint.style.left = "50%";
book4Hint.style.bottom = "80px";
book4Hint.style.transform = "translateX(-50%)";

book4Hint.style.padding = "8px 16px";
book4Hint.style.borderRadius = "20px";

book4Hint.style.background = "rgba(0,0,0,0.6)";
book4Hint.style.color = "#fff";
book4Hint.style.fontSize = "14px";
book4Hint.style.fontFamily = "Arial, sans-serif";

book4Hint.style.pointerEvents = "none";
book4Hint.style.opacity = "0";
book4Hint.style.transition = "opacity 0.25s ease";

book4Hint.style.zIndex = "9998";

document.body.appendChild(book4Hint);

let book4HintVisible = false;

function showBook4Hint(show) {
  if (show === book4HintVisible) return;
  book4HintVisible = show;
  book4Hint.style.opacity = show ? "1" : "0";
}

// ============================================================
// DOG_TAG1 HOVER HINT (Press to go to playlist)
// ============================================================
const dogTagHint = document.createElement("div");
dogTagHint.innerText = "press to view playlist";

dogTagHint.style.position = "fixed";
dogTagHint.style.left = "50%";
dogTagHint.style.bottom = "80px";
dogTagHint.style.transform = "translateX(-50%)";

dogTagHint.style.padding = "8px 16px";
dogTagHint.style.borderRadius = "20px";

dogTagHint.style.background = "rgba(0,0,0,0.6)";
dogTagHint.style.color = "#fff";
dogTagHint.style.fontSize = "14px";
dogTagHint.style.fontFamily = "Arial, sans-serif";

dogTagHint.style.pointerEvents = "none";
dogTagHint.style.opacity = "0";
dogTagHint.style.transition = "opacity 0.25s ease";

dogTagHint.style.zIndex = "9998";

document.body.appendChild(dogTagHint);

let dogTagHintVisible = false;

function showDogTagHint(show) {
  if (show === dogTagHintVisible) return;
  dogTagHintVisible = show;
  dogTagHint.style.opacity = show ? "1" : "0";
}

// ============================================================
// DOOR4 HOVER HINT (Door is locked)
// ============================================================
const door4Hint = document.createElement("div");
door4Hint.innerText = "door is locked";

door4Hint.style.position = "fixed";
door4Hint.style.left = "50%";
door4Hint.style.bottom = "80px";
door4Hint.style.transform = "translateX(-50%)";

door4Hint.style.padding = "8px 16px";
door4Hint.style.borderRadius = "20px";

door4Hint.style.background = "rgba(0,0,0,0.6)";
door4Hint.style.color = "#fff";
door4Hint.style.fontSize = "14px";
door4Hint.style.fontFamily = "Arial, sans-serif";

door4Hint.style.pointerEvents = "none";
door4Hint.style.opacity = "0";
door4Hint.style.transition = "opacity 0.25s ease";

door4Hint.style.zIndex = "9998";

document.body.appendChild(door4Hint);

let door4HintVisible = false;

function showDoor4Hint(show) {
  if (show === door4HintVisible) return;
  door4HintVisible = show;
  door4Hint.style.opacity = show ? "1" : "0";
}

// ============================================================
// PICTURE1 HOVER HINT (Press to change picture)
// ============================================================
const picture1Hint = document.createElement("div");
picture1Hint.innerText = "press to change picture";

picture1Hint.style.position = "fixed";
picture1Hint.style.left = "50%";
picture1Hint.style.bottom = "80px";
picture1Hint.style.transform = "translateX(-50%)";

picture1Hint.style.padding = "8px 16px";
picture1Hint.style.borderRadius = "20px";

picture1Hint.style.background = "rgba(0,0,0,0.6)";
picture1Hint.style.color = "#fff";
picture1Hint.style.fontSize = "14px";
picture1Hint.style.fontFamily = "Arial, sans-serif";

picture1Hint.style.pointerEvents = "none";
picture1Hint.style.opacity = "0";
picture1Hint.style.transition = "opacity 0.25s ease";

picture1Hint.style.zIndex = "9998";

document.body.appendChild(picture1Hint);

let picture1HintVisible = false;

function showPicture1Hint(show) {
  if (show === picture1HintVisible) return;
  picture1HintVisible = show;
  picture1Hint.style.opacity = show ? "1" : "0";
}

// ============================================================
// FRONT_WALL1 HOVER HINT (Draw on wall)
// ============================================================
const wallHint = document.createElement("div");
wallHint.innerHTML = `
  <div style="font-size:16px;">press to draw</div>
  <div style="margin-top:4px; font-size:12px; opacity:0.85;">C = change color</div>
  <div style="margin-top:2px; font-size:12px; opacity:0.85;">E = erase</div>
  <div style="margin-top:2px; font-size:12px; opacity:0.85;">double click = clear wall</div>
`;

wallHint.style.position = "fixed";
wallHint.style.left = "50%";
wallHint.style.bottom = "80px";
wallHint.style.transform = "translateX(-50%)";

wallHint.style.padding = "8px 16px";
wallHint.style.borderRadius = "20px";

wallHint.style.background = "rgba(0,0,0,0.6)";
wallHint.style.color = "#fff";
wallHint.style.fontSize = "14px";
wallHint.style.fontFamily = "Arial, sans-serif";
wallHint.style.textAlign = "center";

wallHint.style.pointerEvents = "none";
wallHint.style.opacity = "0";
wallHint.style.transition = "opacity 0.25s ease";

wallHint.style.zIndex = "9998";

document.body.appendChild(wallHint);

let wallHintVisible = false;

function showWallHint(show) {
  if (show === wallHintVisible) return;
  wallHintVisible = show;
  wallHint.style.opacity = show ? "1" : "0";
}

// ============================================================
// CIGARETTE HOVER HINT (Smoke)
// ============================================================
const cigaretteHint = document.createElement("div");
cigaretteHint.innerText = "smoke";

cigaretteHint.style.position = "fixed";
cigaretteHint.style.left = "50%";
cigaretteHint.style.bottom = "80px";
cigaretteHint.style.transform = "translateX(-50%)";

cigaretteHint.style.padding = "8px 16px";
cigaretteHint.style.borderRadius = "20px";

cigaretteHint.style.background = "rgba(0,0,0,0.6)";
cigaretteHint.style.color = "#fff";
cigaretteHint.style.fontSize = "14px";
cigaretteHint.style.fontFamily = "Arial, sans-serif";

cigaretteHint.style.pointerEvents = "none";
cigaretteHint.style.opacity = "0";
cigaretteHint.style.transition = "opacity 0.25s ease";

cigaretteHint.style.zIndex = "9998";

document.body.appendChild(cigaretteHint);

let cigaretteHintVisible = false;

function showCigaretteHint(show) {
  if (show === cigaretteHintVisible) return;
  cigaretteHintVisible = show;
  cigaretteHint.style.opacity = show ? "1" : "0";
}

// ============================================================
// REMOTE BUTTON HOVER HINTS (OK / UP / DOWN / LEFT / RIGHT)
// ============================================================
function makeMiniHint(text) {
  const el = document.createElement("div");
  el.innerText = text;

  el.style.position = "fixed";
  el.style.left = "50%";
  el.style.bottom = "80px";
  el.style.transform = "translateX(-50%)";

  el.style.padding = "8px 16px";
  el.style.borderRadius = "20px";

  el.style.background = "rgba(0,0,0,0.6)";
  el.style.color = "#fff";
  el.style.fontSize = "14px";
  el.style.fontFamily = "Arial, sans-serif";

  el.style.pointerEvents = "none";
  el.style.opacity = "0";
  el.style.transition = "opacity 0.25s ease";
  el.style.zIndex = "9998";

  document.body.appendChild(el);

  let visible = false;
  function show(show) {
    if (show === visible) return;
    visible = show;
    el.style.opacity = show ? "1" : "0";
  }

  return { el, show };
}

// Create hints
const okHint    = makeMiniHint("select");
const upHint    = makeMiniHint("up");
const downHint  = makeMiniHint("down");
const leftHint  = makeMiniHint("left");
const rightHint = makeMiniHint("right");

// ============================================================
// ✅ iOS MENU CONTROLS HINT (shows for 4s when TV turns ON from TV tap)
// ============================================================
let iosMenuHintShown = false;
let iosMenuHintTimeout = null;

const iosMenuHint = document.createElement("div");
iosMenuHint.style.position = "fixed";
iosMenuHint.style.left = "48.35%";
iosMenuHint.style.bottom = "110px";
iosMenuHint.style.transform = "translateX(-50%)";
iosMenuHint.style.padding = "12px 18px";
iosMenuHint.style.borderRadius = "18px";
iosMenuHint.style.background = "rgba(0,0,0,0.65)";
iosMenuHint.style.color = "#fff";
iosMenuHint.style.fontFamily = "Arial, sans-serif";
iosMenuHint.style.textAlign = "center";
iosMenuHint.style.pointerEvents = "none";
iosMenuHint.style.opacity = "0";
iosMenuHint.style.transition = "opacity 0.2s ease";
iosMenuHint.style.zIndex = "9998";

// 2-line layout
const iosMenuHintLine1 = document.createElement("div");
iosMenuHintLine1.style.fontSize = "14px";
iosMenuHintLine1.style.fontWeight = "700";
iosMenuHintLine1.innerText = "swipe to change selection";

const iosMenuHintLine2 = document.createElement("div");
iosMenuHintLine2.style.fontSize = "13px";
iosMenuHintLine2.style.opacity = "0.9";
iosMenuHintLine2.style.marginTop = "4px";
iosMenuHintLine2.innerText = "tap to view selection";

iosMenuHint.appendChild(iosMenuHintLine1);
iosMenuHint.appendChild(iosMenuHintLine2);
document.body.appendChild(iosMenuHint);

function showIosMenuControlsHintOnce() {
  if (!isIOSDevice()) return;
  if (iosMenuHintShown) return;

  iosMenuHintShown = true;

  // show
  iosMenuHint.style.opacity = "1";

  // hide after 4s
  if (iosMenuHintTimeout) clearTimeout(iosMenuHintTimeout);
  iosMenuHintTimeout = setTimeout(() => {
    iosMenuHint.style.opacity = "0";
  }, 5000);
}


// Helper to hide all remote hints quickly
function hideRemoteHints() {
  okHint.show(false);
  upHint.show(false);
  downHint.show(false);
  leftHint.show(false);
  rightHint.show(false);
}

// ============================================================
// ✅ AUTO-HIDE HINTS after 3.5s (must re-hover to show again)
// ============================================================
const HINT_AUTOHIDE_MS = 3000;

let currentHoverKey = null;     // "tv" | "speaker" | "power" | "ok" | "up" | "down" | "left" | "right" | null
let hintTimeoutId = null;

const hintSuppressed = {
  tv: false,
  speaker: false,
  smoke: false,
  power: false,
  ok: false,
  up: false,
  down: false,
  left: false,
  right: false,
  lamp: false,
  alldvd: false,
  dvdplayer1: false,
  book4: false,
  dogtag1: false,
  door4: false,
  picture1: false,
  wall: false,
};

function hideAllHintsImmediate() {
  showTvHint(false);
  showSpeakerHint(false);
  showCigaretteHint(false);
  showPowerHint(false);
  showLampHint(false);
  showAllDvdHint(false);
  showDvdPlayer1Hint(false);
  showBook4Hint(false);
  showDogTagHint(false);
  showDoor4Hint(false);
  showPicture1Hint(false);
  showWallHint(false);
  hideRemoteHints();
}

function getIosTvHintText() {
  if (tvUiState === "PHOTO") return "double tap: full screen";
  if (tvUiState === "VIDEO") return "double tap: full screen";
  if (tvUiState === "3D MODEL") return "double tap: full screen";
  return "";
}

function showHintForKey(key) {
  // Always show ONLY ONE hint at a time
  hideAllHintsImmediate();

  if (key === "speaker") {
    updateSpeakerHintText();
    showSpeakerHint(true);
    return;
  }

    if (key === "smoke") {
    showCigaretteHint(true);
    return;
  }

  if (key === "power") {
    updatePowerHintText();
    showPowerHint(true);
    return;
  }

    if (key === "lamp") {
    updateLampHintText();
    showLampHint(true);
    return;
  }

    if (key === "alldvd") {
    showAllDvdHint(true);
    return;
  }

    if (key === "dvdplayer1") {
    showDvdPlayer1Hint(true);
    return;
  }

  if (key === "book4") {
  showBook4Hint(true);
  return;
}

if (key === "dogtag1") {
  showDogTagHint(true);
  return;
}

if (key === "door4") {
  showDoor4Hint(true);
  return;
}

if (key === "picture1") {
  showPicture1Hint(true);
  return;
}

if (key === "wall") {
  showWallHint(true);
  return;
}

  if (key === "tv") {

  // ✅ iOS-specific TV hint text
  if (isIOSDevice()) {
    const text = getIosTvHintText();
    if (text && typeof updateTvHintText === "function") {
      updateTvHintText(text);
    }
  }

  showTvHint(true);
  return;
}

  // Remote mini hints
  if (key === "ok") okHint.show(true);
  else if (key === "up") upHint.show(true);
  else if (key === "down") downHint.show(true);
  else if (key === "left") leftHint.show(true);
  else if (key === "right") rightHint.show(true);
}

function setHoverKey(nextKey) {
  if (nextKey === currentHoverKey) return;

  // Leaving previous hover target: un-suppress it so re-hover shows again
  if (currentHoverKey) {
    hintSuppressed[currentHoverKey] = false;
  }

  currentHoverKey = nextKey;

  // stop any existing timer
  if (hintTimeoutId) {
    clearTimeout(hintTimeoutId);
    hintTimeoutId = null;
  }

  // hide everything whenever hover target changes
  hideAllHintsImmediate();

  if (!nextKey) return;

  // If this hint already timed out during this hover, keep it hidden until user leaves + rehovers
  if (hintSuppressed[nextKey]) return;

  // Show it now and schedule auto-hide
  showHintForKey(nextKey);

  hintTimeoutId = setTimeout(() => {
    // Only auto-hide if still hovering the SAME key at timeout
    if (currentHoverKey === nextKey) {
      hideAllHintsImmediate();
      hintSuppressed[nextKey] = true; // requires leave + re-hover to show again
    }
  }, HINT_AUTOHIDE_MS);
}

// ============================================================
// SUBTLE ROOM GRAIN / NOISE OVERLAY (FINAL) ✅
// ============================================================
const grainOverlay = document.createElement("div");
grainOverlay.style.position = "fixed";
grainOverlay.style.left = "0";
grainOverlay.style.top = "0";
grainOverlay.style.width = "100vw";
grainOverlay.style.height = "100vh";
grainOverlay.style.pointerEvents = "none";

// ✅ IMPORTANT: keep it under your hint UI (9998) and under fullscreen overlay (9999)
grainOverlay.style.zIndex = "9997";

// ✅ subtle + cinematic
grainOverlay.style.opacity = "0.09";              // try 0.02–0.06
grainOverlay.style.mixBlendMode = "screen";       // stronger than soft-light
grainOverlay.style.filter = "contrast(140%) brightness(90%)";
grainOverlay.style.transform = "translateZ(0)";
grainOverlay.style.willChange = "background-position, opacity";

// ✅ CANVAS NOISE (works in all browsers)
function makeNoiseDataURL(size = 128, alpha = 28) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");

  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d[i] = v;       // R
    d[i + 1] = v;   // G
    d[i + 2] = v;   // B
    d[i + 3] = alpha; // A (0–255) -> strength
  }

  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

// ✅ Use a MUCH bigger noise tile (reduces tiling artifacts)
const noiseURL = makeNoiseDataURL(512, 35); // size, alpha

grainOverlay.style.backgroundImage = `url("${noiseURL}")`;
grainOverlay.style.backgroundRepeat = "repeat";

// ✅ Match the tile size (no weird scaling / moire)
grainOverlay.style.backgroundSize = "512px 512px";

// ✅ Softer blend (overlay + contrast can create banding in shadows)
grainOverlay.style.mixBlendMode = "soft-light";

// ✅ Slightly stronger opacity is OK once it’s clean
grainOverlay.style.opacity = "0.03";

// ✅ Remove contrast/brightness (this is a BIG banding cause)
grainOverlay.style.filter = "none";

// ✅ Move the grain slowly so it never “locks” into bands
grainOverlay.style.animation = "grainBgMove 0.6s steps(1) infinite";


document.body.appendChild(grainOverlay);

const iosNightVisionOverlay = document.createElement("div");
iosNightVisionOverlay.style.position = "fixed";
iosNightVisionOverlay.style.left = "0";
iosNightVisionOverlay.style.top = "0";
iosNightVisionOverlay.style.width = "100vw";
iosNightVisionOverlay.style.height = "100vh";
iosNightVisionOverlay.style.pointerEvents = "none";
iosNightVisionOverlay.style.zIndex = "9997"; // below overlays (9999) but above scene
iosNightVisionOverlay.style.opacity = "0";
iosNightVisionOverlay.style.transition = "opacity 0.18s ease";
iosNightVisionOverlay.style.mixBlendMode = "screen";

// green tint + subtle vignette (safe for iOS)
iosNightVisionOverlay.style.background = `
  radial-gradient(circle at 50% 45%,
    rgba(120, 255, 160, 0.28) 0%,
    rgba(80, 255, 120, 0.20) 35%,
    rgba(0, 0, 0, 0.12) 70%,
    rgba(0, 0, 0, 0.35) 100%)
`;

document.body.appendChild(iosNightVisionOverlay);

// iOS likes this: keep overlay always sized correctly even with Safari bars
function sizeIosNVOverlay() {
  if (!window.visualViewport) return;
  iosNightVisionOverlay.style.width = `${window.visualViewport.width}px`;
  iosNightVisionOverlay.style.height = `${window.visualViewport.height}px`;
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", sizeIosNVOverlay);
  window.visualViewport.addEventListener("scroll", sizeIosNVOverlay);
}
sizeIosNVOverlay();

function applyLampMood(mode) {
  if (!nightLights) return;

  // pick palettes
  const warm = {
    lamp: 0xffe6c8,
    push: 0xffc07a,
    hemiSky: 0x2b3140,
    hemiGround: 0x0b0b0b,
    exposure: 0.80,
  };

  const cold = {
    lamp: 0xcfe8ff,
    push: 0x9ad0ff,
    hemiSky: 0x0b1020,
    hemiGround: 0x000000,
    exposure: 0.72,
  };

  const red = {
    lamp: 0xffb0b0,
    push: 0xff4a4a,
    hemiSky: 0x20060a,
    hemiGround: 0x000000,
    exposure: 0.75,
  };

  const p = mode === 1 ? cold : mode === 2 ? red : warm;

  // change your actual Three.js lights
  nightLights.lampKey.color.setHex(p.lamp);
  nightLights.lampShadow.color.setHex(p.lamp);
  nightLights.rightPush.color.setHex(p.push);

  // optional: also tint the hemisphere fill (your hemi exists globally)
  hemi.color.setHex(p.hemiSky);
  hemi.groundColor.setHex(p.hemiGround);

  // optional: small exposure change helps the “mood” read clearly
  renderer.toneMappingExposure = p.exposure;
}


// ============================================================
// SPEAKER HOVER HINT (Smart: play/pause + next track)
// ============================================================

const speakerHint = document.createElement("div");

// main line
const speakerHintMain = document.createElement("div");
speakerHintMain.style.fontSize = "14px";
speakerHintMain.style.fontWeight = "600";
speakerHintMain.style.marginBottom = "2px";

// sub line
const speakerHintSub = document.createElement("div");
speakerHintSub.style.fontSize = "12px";
speakerHintSub.style.opacity = "0.85";
speakerHintSub.innerText = "double click: next track";

speakerHint.appendChild(speakerHintMain);
speakerHint.appendChild(speakerHintSub);

speakerHint.style.position = "fixed";
speakerHint.style.left = "50%";
speakerHint.style.bottom = "80px";
speakerHint.style.transform = "translateX(-50%)";

speakerHint.style.padding = "10px 16px";
speakerHint.style.borderRadius = "20px";

speakerHint.style.background = "rgba(0,0,0,0.6)";
speakerHint.style.color = "#fff";
speakerHint.style.fontFamily = "Arial, sans-serif";
speakerHint.style.textAlign = "center";

speakerHint.style.pointerEvents = "none";
speakerHint.style.opacity = "0";
speakerHint.style.transition = "opacity 0.25s ease";

speakerHint.style.zIndex = "9998";

document.body.appendChild(speakerHint);

let speakerHintVisible = false;

function showSpeakerHint(show) {
  if (show === speakerHintVisible) return;

  speakerHintVisible = show;
  speakerHint.style.opacity = show ? "1" : "0";
}

// ✅ NEW: updates text based on isPlaying
function updateSpeakerHintText() {
  speakerHintMain.innerText = isPlaying ? "click to pause" : "click to play";
}

// ============================================================
// ✅ iOS SAFE OVERLAY SIZING (fixes "vh" cropping in fullscreen overlays)
// Put ABOVE: const photoOverlay = document.createElement("div");
// ============================================================
function getVisualSize() {
  const vv = window.visualViewport;
  return {
    w: Math.round(vv?.width  ?? window.innerWidth),
    h: Math.round(vv?.height ?? window.innerHeight),
  };
}

// ============================================================
// ✅ iOS SAFARI DYNAMIC VIEWPORT FIX (tabs/address bar cropping)
// - Uses visualViewport for real visible size
// - Keeps renderer + camera aspect correct
// ============================================================
function getVisibleViewportSize() {
  const vv = window.visualViewport;
  return {
    w: Math.round(vv?.width ?? window.innerWidth),
    h: Math.round(vv?.height ?? window.innerHeight),
  };
}

function applyVisibleViewportToRendererAndCamera() {
  const vv = window.visualViewport;
  const w = Math.round(vv?.width ?? window.innerWidth);
  const h = Math.round(vv?.height ?? window.innerHeight);

  renderer.setSize(w, h, false);

  // keep css in sync (prevents iOS weird scaling)
  renderer.domElement.style.width = w + "px";
  renderer.domElement.style.height = h + "px";

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  return { w, h };
}

function applyIOSViewportFix() {
  const { w, h } = getVisibleViewportSize();

  // 1) Keep the canvas physically sized to the visible viewport
  renderer.setSize(w, h, false);

  // 2) Make sure CSS matches too (prevents weird scaling/cropping)
  renderer.domElement.style.width = w + "px";
  renderer.domElement.style.height = h + "px";

  // 3) Keep camera projection correct
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  // 4) If you use your own viewport/scissor math (viewX/viewY/viewW/viewH),
  // recompute it here too (so raycasting matches the new viewport).
  if (typeof updateViewportRect === "function") {
    updateViewportRect();
  }
}

function sizeOverlayToVisible(overlayEl) {
  const vv = window.visualViewport;
  const w = Math.round(vv?.width  ?? window.innerWidth);
  const h = Math.round(vv?.height ?? window.innerHeight);

  // ✅ critical on iOS landscape: the visible viewport can be offset
  const left = Math.round(vv?.offsetLeft ?? 0);
  const top  = Math.round(vv?.offsetTop  ?? 0);

  overlayEl.style.position = "fixed";
  overlayEl.style.width  = `${w}px`;
  overlayEl.style.height = `${h}px`;
  overlayEl.style.left   = `${left}px`;
  overlayEl.style.top    = `${top}px`;
}

const photoOverlay = document.createElement("div");
photoOverlay.style.position = "fixed";
photoOverlay.style.left = "0";
photoOverlay.style.top = "0";
// ✅ do NOT use 100vh on iOS
sizeOverlayToVisible(photoOverlay);
photoOverlay.style.background = "rgba(0,0,0,0.92)";
photoOverlay.style.display = "none";
photoOverlay.style.zIndex = "9999";
photoOverlay.style.userSelect = "none";

photoOverlay.style.display = "none";

// container to center image
const overlayCenter = document.createElement("div");
overlayCenter.style.position = "absolute";
overlayCenter.style.left = "0";
overlayCenter.style.top = "0";
overlayCenter.style.width = "100%";
overlayCenter.style.height = "100%";
overlayCenter.style.display = "flex";
overlayCenter.style.alignItems = "center";
overlayCenter.style.justifyContent = "center";

const photoOverlayImg = document.createElement("img");
photoOverlayImg.style.maxWidth = "96vw";
photoOverlayImg.style.maxHeight = "96%";
photoOverlayImg.style.objectFit = "contain";
photoOverlayImg.style.boxShadow = "0 20px 80px rgba(0,0,0,0.6)";
photoOverlayImg.style.pointerEvents = "none"; // ✅ clicks go to buttons/overlay

overlayCenter.appendChild(photoOverlayImg);
photoOverlay.appendChild(overlayCenter);

// ---------- Left Arrow ----------
const overlayPrev = document.createElement("button");
overlayPrev.innerHTML = "&lt;";
overlayPrev.style.position = "absolute";
overlayPrev.style.left = "18px";
overlayPrev.style.top = "50%";
overlayPrev.style.transform = "translateY(-50%)";
overlayPrev.style.width = "64px";
overlayPrev.style.height = "64px";
overlayPrev.style.borderRadius = "999px";
overlayPrev.style.border = "1px solid rgba(255,255,255,0.25)";
overlayPrev.style.background = "rgba(0,0,0,0.35)";
overlayPrev.style.color = "#fff";
overlayPrev.style.fontSize = "34px";
overlayPrev.style.cursor = "pointer";
overlayPrev.style.display = "flex";
overlayPrev.style.alignItems = "center";
overlayPrev.style.justifyContent = "center";
overlayPrev.style.backdropFilter = "blur(6px)";

// ---------- Right Arrow ----------
const overlayNext = document.createElement("button");
overlayNext.innerHTML = "&gt;";
overlayNext.style.position = "absolute";
overlayNext.style.right = "18px";
overlayNext.style.top = "50%";
overlayNext.style.transform = "translateY(-50%)";
overlayNext.style.width = "64px";
overlayNext.style.height = "64px";
overlayNext.style.borderRadius = "999px";
overlayNext.style.border = "1px solid rgba(255,255,255,0.25)";
overlayNext.style.background = "rgba(0,0,0,0.35)";
overlayNext.style.color = "#fff";
overlayNext.style.fontSize = "34px";
overlayNext.style.cursor = "pointer";
overlayNext.style.display = "flex";
overlayNext.style.alignItems = "center";
overlayNext.style.justifyContent = "center";
overlayNext.style.backdropFilter = "blur(6px)";

// ---------- Exit Button ----------
const overlayExit = document.createElement("button");
overlayExit.innerHTML = "✕";
overlayExit.style.position = "absolute";
overlayExit.style.right = "18px";
overlayExit.style.top = "18px";
overlayExit.style.width = "44px";
overlayExit.style.height = "44px";
overlayExit.style.borderRadius = "12px";
overlayExit.style.border = "1px solid rgba(255,255,255,0.25)";
overlayExit.style.background = "rgba(0,0,0,0.35)";
overlayExit.style.color = "#fff";
overlayExit.style.fontSize = "22px";
overlayExit.style.cursor = "pointer";
overlayExit.style.display = "flex";
overlayExit.style.alignItems = "center";
overlayExit.style.justifyContent = "center";
overlayExit.style.backdropFilter = "blur(6px)";

photoOverlay.appendChild(overlayPrev);
photoOverlay.appendChild(overlayNext);
photoOverlay.appendChild(overlayExit);

document.body.appendChild(photoOverlay);

// ============================================================
// FULLSCREEN VIDEO OVERLAY (TV click in VIDEO mode) ✅
// ============================================================
let videoOverlayOpen = false;
let tvVideoSuppressed = false;       // ✅ when true: TV video stops/ freezes (no redraw)
let overlayVideoIsFullscreen = false; // ✅ tracks native fullscreen on overlay player


const videoOverlay = document.createElement("div");
videoOverlay.style.position = "fixed";
videoOverlay.style.left = "0";
videoOverlay.style.top = "0";
// ✅ do NOT use 100vh on iOS
sizeOverlayToVisible(videoOverlay);
videoOverlay.style.background = "rgba(0,0,0,0.92)";
videoOverlay.style.display = "none";
videoOverlay.style.zIndex = "9999";
videoOverlay.style.userSelect = "none";

const videoOverlayCenter = document.createElement("div");
videoOverlayCenter.style.position = "absolute";
videoOverlayCenter.style.left = "0";
videoOverlayCenter.style.top = "0";
videoOverlayCenter.style.width = "100%";
videoOverlayCenter.style.height = "100%";
videoOverlayCenter.style.display = "flex";
videoOverlayCenter.style.alignItems = "center";
videoOverlayCenter.style.justifyContent = "center";

const videoOverlayEl = document.createElement("video");
videoOverlayEl.style.maxWidth = "96vw";
videoOverlayEl.style.maxHeight = "96%";
videoOverlayEl.style.objectFit = "contain";
videoOverlayEl.style.boxShadow = "0 20px 80px rgba(0,0,0,0.6)";
videoOverlayEl.style.background = "#000";
videoOverlayEl.playsInline = true;
videoOverlayEl.setAttribute("webkit-playsinline", "");
videoOverlayEl.controls = true; // ✅ allow real fullscreen controls
videoOverlayEl.loop = true;
videoOverlayEl.preload = "auto";

videoOverlayCenter.appendChild(videoOverlayEl);
videoOverlay.appendChild(videoOverlayCenter);

function freezeTvVideoForOverlay() {
  // freeze TV redraws while overlay fullscreen is active
  tvVideoSuppressed = true;

  // IMPORTANT: do NOT reset currentTime and do NOT set videoReady=false
  // we only want it to stop playing.
  pauseVideo();

  // IMPORTANT: do NOT clear the TV screen
  // leave the last drawn frame visible
}

document.addEventListener("fullscreenchange", () => {
  const fsEl = document.fullscreenElement;
  const isOverlayFs = fsEl === videoOverlayEl;

  overlayVideoIsFullscreen = isOverlayFs;

  if (isOverlayFs) {
    // ENTER fullscreen: freeze TV + pause it
    freezeTvVideoForOverlay();
  } else {
    // EXIT fullscreen: unfreeze TV + show paused frame again
    tvVideoSuppressed = false;

    if (tvOn && tvUiState === "VIDEO" && videoReady) {
      // ensure TV shows something immediately
      drawVideoFrameToTv();
    }
  }
});



// Safari (older / webkit-prefixed)
document.addEventListener("webkitfullscreenchange", () => {
  const fsEl = document.webkitFullscreenElement;
  const isOverlayFs = fsEl === videoOverlayEl;

  overlayVideoIsFullscreen = isOverlayFs;

  if (isOverlayFs) {
    freezeTvVideoForOverlay();
  } else {
    tvVideoSuppressed = false;

    if (tvOn && tvUiState === "VIDEO" && videoReady) {
      drawVideoFrameToTv();
    }
  }
});

// iOS Safari video fullscreen events (important on iPhone/iPad)
videoOverlayEl.addEventListener("webkitbeginfullscreen", () => {
  overlayVideoIsFullscreen = true;
  freezeTvVideoForOverlay();
});

videoOverlayEl.addEventListener("webkitendfullscreen", () => {
  overlayVideoIsFullscreen = false;

  tvVideoSuppressed = false;

  if (tvOn && tvUiState === "VIDEO" && videoReady) {
    drawVideoFrameToTv();
  }
});



// ---------- Exit Button ----------
const videoOverlayExit = document.createElement("button");
videoOverlayExit.innerHTML = "✕";
videoOverlayExit.style.position = "absolute";
videoOverlayExit.style.right = "18px";
videoOverlayExit.style.top = "18px";
videoOverlayExit.style.width = "44px";
videoOverlayExit.style.height = "44px";
videoOverlayExit.style.borderRadius = "12px";
videoOverlayExit.style.border = "1px solid rgba(255,255,255,0.25)";
videoOverlayExit.style.background = "rgba(0,0,0,0.35)";
videoOverlayExit.style.color = "#fff";
videoOverlayExit.style.fontSize = "22px";
videoOverlayExit.style.cursor = "pointer";
videoOverlayExit.style.display = "flex";
videoOverlayExit.style.alignItems = "center";
videoOverlayExit.style.justifyContent = "center";
videoOverlayExit.style.backdropFilter = "blur(6px)";

// ---------- Left Arrow (VIDEO) ----------
const videoOverlayPrev = document.createElement("button");
videoOverlayPrev.innerHTML = "&lt;";
videoOverlayPrev.style.position = "absolute";
videoOverlayPrev.style.left = "18px";
videoOverlayPrev.style.top = "50%";
videoOverlayPrev.style.transform = "translateY(-50%)";
videoOverlayPrev.style.width = "64px";
videoOverlayPrev.style.height = "64px";
videoOverlayPrev.style.borderRadius = "999px";
videoOverlayPrev.style.border = "1px solid rgba(255,255,255,0.25)";
videoOverlayPrev.style.background = "rgba(0,0,0,0.35)";
videoOverlayPrev.style.color = "#fff";
videoOverlayPrev.style.fontSize = "34px";
videoOverlayPrev.style.cursor = "pointer";
videoOverlayPrev.style.display = "flex";
videoOverlayPrev.style.alignItems = "center";
videoOverlayPrev.style.justifyContent = "center";
videoOverlayPrev.style.backdropFilter = "blur(6px)";

// ---------- Right Arrow (VIDEO) ----------
const videoOverlayNext = document.createElement("button");
videoOverlayNext.innerHTML = "&gt;";
videoOverlayNext.style.position = "absolute";
videoOverlayNext.style.right = "18px";
videoOverlayNext.style.top = "50%";
videoOverlayNext.style.transform = "translateY(-50%)";
videoOverlayNext.style.width = "64px";
videoOverlayNext.style.height = "64px";
videoOverlayNext.style.borderRadius = "999px";
videoOverlayNext.style.border = "1px solid rgba(255,255,255,0.25)";
videoOverlayNext.style.background = "rgba(0,0,0,0.35)";
videoOverlayNext.style.color = "#fff";
videoOverlayNext.style.fontSize = "34px";
videoOverlayNext.style.cursor = "pointer";
videoOverlayNext.style.display = "flex";
videoOverlayNext.style.alignItems = "center";
videoOverlayNext.style.justifyContent = "center";
videoOverlayNext.style.backdropFilter = "blur(6px)";

// add arrows to overlay
videoOverlay.appendChild(videoOverlayPrev);
videoOverlay.appendChild(videoOverlayNext);


videoOverlay.appendChild(videoOverlayExit);
document.body.appendChild(videoOverlay);

// ============================================================
// ✅ keep overlays sized correctly on iOS (address bar / rotate)
// Put RIGHT AFTER: document.body.appendChild(videoOverlay);
// ============================================================
function refreshOverlays() {
  if (photoOverlay && photoOverlay.style.display !== "none") sizeOverlayToVisible(photoOverlay);
  if (videoOverlay && videoOverlay.style.display !== "none") sizeOverlayToVisible(videoOverlay);
}

window.addEventListener("resize", refreshOverlays);
window.addEventListener("orientationchange", () => setTimeout(refreshOverlays, 250));

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", refreshOverlays);
  window.visualViewport.addEventListener("scroll", refreshOverlays);
}

// ============================================================
// ✅ iOS FIX: Safari reports wrong size on first load.
// We re-apply viewport + reframe camera after viewport changes.
// ============================================================
let __roomMaxDimForCamera = null;

function refitCameraAfterViewportChange() {
  if (!__roomMaxDimForCamera) return;

  applyVisibleViewportToRendererAndCamera();

  if (isIOSDevice()) {
    setIOSCameraFraming(__roomMaxDimForCamera);
  } else {
    setInitialCameraFraming(__roomMaxDimForCamera);
  }
}

if (isIOS && window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(refitCameraAfterViewportChange);
    });
  });

  window.visualViewport.addEventListener("scroll", () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(refitCameraAfterViewportChange);
    });
  });
}

window.addEventListener("orientationchange", () => {
  setTimeout(refitCameraAfterViewportChange, 250);
});

// Click outside video closes
videoOverlay.addEventListener("click", (e) => {
  if (e.target === videoOverlay) closeVideoOverlay();
});

videoOverlayExit.addEventListener("click", (e) => {
  e.stopPropagation();
  closeVideoOverlay();
});

videoOverlayPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  overlayNextVideo(-1);
});

videoOverlayNext.addEventListener("click", (e) => {
  e.stopPropagation();
  overlayNextVideo(+1);
});

// ============================================================
// FULLSCREEN 3D MODEL OVERLAY (TV click in 3D MODEL mode) ✅
// ============================================================
let modelOverlayOpen = false;
let tvModelSuppressed = false;
let overlayModelIsFullscreen = false;

const modelOverlay = document.createElement("div");
modelOverlay.style.position = "fixed";
modelOverlay.style.left = "0";
modelOverlay.style.top = "0";
modelOverlay.style.width = "100%";
modelOverlay.style.height = "100%";
modelOverlay.style.inset = "0";                // ✅ iOS friendly
modelOverlay.style.boxSizing = "border-box";   // ✅ so padding counts
modelOverlay.style.padding =
  "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
modelOverlay.style.background = "rgba(0,0,0,0.92)";
modelOverlay.style.display = "none";
modelOverlay.style.zIndex = "9999";
modelOverlay.style.userSelect = "none";

const modelOverlayCenter = document.createElement("div");
modelOverlayCenter.style.position = "absolute";
modelOverlayCenter.style.left = "0";
modelOverlayCenter.style.top = "0";
modelOverlayCenter.style.width = "100%";
modelOverlayCenter.style.height = "100%";
modelOverlayCenter.style.display = "flex";
modelOverlayCenter.style.alignItems = "center";
modelOverlayCenter.style.justifyContent = "center";

const modelOverlayEl = document.createElement("video");
modelOverlayEl.style.maxWidth = "96vw";
modelOverlayEl.style.maxHeight = "96vh";
modelOverlayEl.style.objectFit = "contain";
modelOverlayEl.style.boxShadow = "0 20px 80px rgba(0,0,0,0.6)";
modelOverlayEl.style.background = "#000";
modelOverlayEl.playsInline = true;
modelOverlayEl.setAttribute("webkit-playsinline", "");
modelOverlayEl.controls = true;
modelOverlayEl.loop = true;
modelOverlayEl.preload = "auto";

// ✅ REQUIRED: image element for .jpg/.png in model overlay
const modelOverlayImg = document.createElement("img");
modelOverlayImg.style.maxWidth = "96vw";
modelOverlayImg.style.maxHeight = "96vh";
modelOverlayImg.style.objectFit = "contain";
modelOverlayImg.style.boxShadow = "0 20px 80px rgba(0,0,0,0.6)";
modelOverlayImg.style.background = "#000";
modelOverlayImg.style.display = "none";
modelOverlayImg.style.pointerEvents = "none";

modelOverlayCenter.appendChild(modelOverlayEl);
modelOverlayCenter.appendChild(modelOverlayImg);
modelOverlay.appendChild(modelOverlayCenter);

function sizeModelOverlayMedia() {
  // ✅ Use the real visible viewport on iOS (avoids bottom crop)
  const vv = window.visualViewport;

  const vw = (vv ? vv.width : window.innerWidth);
  const vh = (vv ? vv.height : window.innerHeight);

  // give it a little breathing room so it never hits the home bar / safari UI
  const maxW = Math.floor(vw * 0.96);
  const maxH = Math.floor(vh * 0.92);

  modelOverlayEl.style.maxWidth = `${maxW}px`;
  modelOverlayEl.style.maxHeight = `${maxH}px`;

  modelOverlayImg.style.maxWidth = `${maxW}px`;
  modelOverlayImg.style.maxHeight = `${maxH}px`;
}

function freezeTvModelForOverlay() {
  tvModelSuppressed = true;
  pauseModel();
}

document.addEventListener("fullscreenchange", () => {
  const fsEl = document.fullscreenElement;
  const isOverlayFs = fsEl === modelOverlayEl;

  overlayModelIsFullscreen = isOverlayFs;

  if (isOverlayFs) {
    freezeTvModelForOverlay();
  } else {
    tvModelSuppressed = false;
    if (tvOn && tvUiState === "3D MODEL" && modelReady) drawModelFrameToTv();
  }
});

document.addEventListener("webkitfullscreenchange", () => {
  const fsEl = document.webkitFullscreenElement;
  const isOverlayFs = fsEl === modelOverlayEl;

  overlayModelIsFullscreen = isOverlayFs;

  if (isOverlayFs) {
    freezeTvModelForOverlay();
  } else {
    tvModelSuppressed = false;
    if (tvOn && tvUiState === "3D MODEL" && modelReady) drawModelFrameToTv();
  }
});

modelOverlayEl.addEventListener("webkitbeginfullscreen", () => {
  overlayModelIsFullscreen = true;
  freezeTvModelForOverlay();
});

modelOverlayEl.addEventListener("webkitendfullscreen", () => {
  overlayModelIsFullscreen = false;
  tvModelSuppressed = false;
  if (tvOn && tvUiState === "3D MODEL" && modelReady) drawModelFrameToTv();
});

// Exit
const modelOverlayExit = document.createElement("button");
modelOverlayExit.innerHTML = "✕";
modelOverlayExit.style.position = "absolute";
modelOverlayExit.style.right = "18px";
modelOverlayExit.style.top = "18px";
modelOverlayExit.style.width = "44px";
modelOverlayExit.style.height = "44px";
modelOverlayExit.style.borderRadius = "12px";
modelOverlayExit.style.border = "1px solid rgba(255,255,255,0.25)";
modelOverlayExit.style.background = "rgba(0,0,0,0.35)";
modelOverlayExit.style.color = "#fff";
modelOverlayExit.style.fontSize = "22px";
modelOverlayExit.style.cursor = "pointer";
modelOverlayExit.style.display = "flex";
modelOverlayExit.style.alignItems = "center";
modelOverlayExit.style.justifyContent = "center";
modelOverlayExit.style.backdropFilter = "blur(6px)";

// Left arrow
const modelOverlayPrev = document.createElement("button");
modelOverlayPrev.innerHTML = "&lt;";
modelOverlayPrev.style.position = "absolute";
modelOverlayPrev.style.left = "18px";
modelOverlayPrev.style.top = "50%";
modelOverlayPrev.style.transform = "translateY(-50%)";
modelOverlayPrev.style.width = "64px";
modelOverlayPrev.style.height = "64px";
modelOverlayPrev.style.borderRadius = "999px";
modelOverlayPrev.style.border = "1px solid rgba(255,255,255,0.25)";
modelOverlayPrev.style.background = "rgba(0,0,0,0.35)";
modelOverlayPrev.style.color = "#fff";
modelOverlayPrev.style.fontSize = "34px";
modelOverlayPrev.style.cursor = "pointer";
modelOverlayPrev.style.display = "flex";
modelOverlayPrev.style.alignItems = "center";
modelOverlayPrev.style.justifyContent = "center";
modelOverlayPrev.style.backdropFilter = "blur(6px)";

// Right arrow
const modelOverlayNext = document.createElement("button");
modelOverlayNext.innerHTML = "&gt;";
modelOverlayNext.style.position = "absolute";
modelOverlayNext.style.right = "18px";
modelOverlayNext.style.top = "50%";
modelOverlayNext.style.transform = "translateY(-50%)";
modelOverlayNext.style.width = "64px";
modelOverlayNext.style.height = "64px";
modelOverlayNext.style.borderRadius = "999px";
modelOverlayNext.style.border = "1px solid rgba(255,255,255,0.25)";
modelOverlayNext.style.background = "rgba(0,0,0,0.35)";
modelOverlayNext.style.color = "#fff";
modelOverlayNext.style.fontSize = "34px";
modelOverlayNext.style.cursor = "pointer";
modelOverlayNext.style.display = "flex";
modelOverlayNext.style.alignItems = "center";
modelOverlayNext.style.justifyContent = "center";
modelOverlayNext.style.backdropFilter = "blur(6px)";

modelOverlay.appendChild(modelOverlayPrev);
modelOverlay.appendChild(modelOverlayNext);
modelOverlay.appendChild(modelOverlayExit);
document.body.appendChild(modelOverlay);

modelOverlay.addEventListener("click", (e) => {
  if (e.target === modelOverlay) closeModelOverlay();
});

modelOverlayExit.addEventListener("click", (e) => {
  e.stopPropagation();
  closeModelOverlay();
});

modelOverlayPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  overlayNextModel(-1);
});

modelOverlayNext.addEventListener("click", (e) => {
  e.stopPropagation();
  overlayNextModel(+1);
});

// ESC closes
window.addEventListener("keydown", (e) => {
  if (!modelOverlayOpen) return;
  if (e.key === "Escape") closeModelOverlay();
});

async function openModelOverlay() {
if (modelMediaType === "video" && !modelVideoEl) return;
if (modelMediaType === "image" && !currentModelUrl) return;

  modelOverlayOpen = true;
  modelOverlay.style.display = "block";

  sizeModelOverlayMedia();

  tvModelSuppressed = false;
  pauseModel();
  if (tvOn && tvUiState === "3D MODEL" && modelReady) drawModelFrameToTv();

  // hide hints...
  showTvHint(false);
  showSpeakerHint(false);
  showPowerHint(false);
  hideRemoteHints();

if (modelMediaType === "image") {
  // ✅ show image, hide video
  modelOverlayEl.pause();
  modelOverlayEl.style.display = "none";

  modelOverlayImg.src = currentModelUrl;
  modelOverlayImg.style.display = "block";
  return; // ✅ done (no play)
}

// ✅ video path (original behavior)
modelOverlayImg.style.display = "none";
modelOverlayEl.style.display = "block";

modelOverlayEl.src = modelVideoEl.currentSrc || modelVideoEl.src;
modelOverlayEl.currentTime = modelVideoEl.currentTime || 0;

try { await modelOverlayEl.play(); } catch (err) {
  console.warn("Model overlay play blocked:", err);
}


  try { await modelOverlayEl.play(); } catch (err) {
    console.warn("Model overlay play blocked:", err);
  }
}

function closeModelOverlay() {
  modelOverlayOpen = false;
  modelOverlay.style.display = "none";

  tvModelSuppressed = false;
  overlayModelIsFullscreen = false;

  // sync back to TV time
  if (modelVideoEl && modelOverlayEl.src) {
  try {
    modelVideoEl.currentTime = modelOverlayEl.currentTime || modelVideoEl.currentTime;
      if (!modelOverlayEl.paused) playModel();
      else pauseModel();
    } catch {}
  }

  modelOverlayEl.pause();
  modelOverlayEl.src = "";
  modelOverlayImg.src = "";
  modelOverlayImg.style.display = "none";
  modelOverlayEl.style.display = "block";

}

async function overlayNextModel(delta) {
  if (!modelOverlayOpen) return;
  if (tvUiState !== "3D MODEL") return;

  const n = MODEL_PATHS.length;
  modelIndex = (modelIndex + delta + n) % n;

  const url = MODEL_PATHS[modelIndex];

  // keep TV state consistent but paused while overlay is open
  loadModelAt(modelIndex, { autoPlay: false });

try {
  if (isImageUrl(url)) {
    // ✅ show image, hide video
    modelOverlayEl.pause();
    modelOverlayEl.style.display = "none";

    modelOverlayImg.src = url;
    modelOverlayImg.style.display = "block";
    return;
  }

  // ✅ show video, hide image
  modelOverlayImg.style.display = "none";
  modelOverlayEl.style.display = "block";

  modelOverlayEl.pause();
  modelOverlayEl.src = url;
  modelOverlayEl.currentTime = 0;
  modelOverlayEl.load();

  try { await modelOverlayEl.play(); } catch (err) {
    console.warn("Model overlay play blocked:", err);
  }
} catch (e) {
  console.warn("overlayNextModel failed:", e);
}
}

// ESC closes
window.addEventListener("keydown", (e) => {
  if (!videoOverlayOpen) return;
  if (e.key === "Escape") closeVideoOverlay();
});

async function openVideoOverlay() {
  if (!videoEl) return;

  videoOverlayOpen = true;
  videoOverlay.style.display = "block";

  tvVideoSuppressed = false;
  pauseVideo();
  if (tvOn && tvUiState === "VIDEO" && videoReady) drawVideoFrameToTv();

  // hide hints...
  showTvHint(false);
  showSpeakerHint(false);
  showPowerHint(false);
  hideRemoteHints();

  videoOverlayEl.src = videoEl.currentSrc || videoEl.src;
  videoOverlayEl.currentTime = videoEl.currentTime || 0;

  try { await videoOverlayEl.play(); } catch (err) {
    console.warn("Overlay play blocked:", err);
  }
}


function closeVideoOverlay() {
  videoOverlayOpen = false;
  videoOverlay.style.display = "none";

  // ✅ overlay closed — let TV run normally again
  tvVideoSuppressed = false;
  overlayVideoIsFullscreen = false;


  // ✅ sync back to TV video time
  if (videoEl && videoOverlayEl.src) {
    try {
      videoEl.currentTime = videoOverlayEl.currentTime || videoEl.currentTime;
      // keep play state consistent
      if (!videoOverlayEl.paused) playVideo();
      else pauseVideo();
    } catch {}
  }

  videoOverlayEl.pause();
  videoOverlayEl.src = "";
}


// Click outside buttons closes
photoOverlay.addEventListener("click", (e) => {
  // only close if they clicked the dark background (not a button)
  if (e.target === photoOverlay) closePhotoOverlay();
});

// Exit button closes
overlayExit.addEventListener("click", (e) => {
  e.stopPropagation();
  closePhotoOverlay();
});

// Prev/Next buttons
overlayPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  nextPhoto(-1);                // ✅ uses your existing gallery function
  openPhotoOverlay(currentPhotoUrl); // ✅ refresh overlay image
});

overlayNext.addEventListener("click", (e) => {
  e.stopPropagation();
  nextPhoto(+1);
  openPhotoOverlay(currentPhotoUrl);
});

// ESC closes + arrow keys navigate while overlay open
window.addEventListener("keydown", (e) => {
  if (!overlayOpen) return;

  if (e.key === "Escape") {
    closePhotoOverlay();
    return;
  }
  if (e.key === "ArrowLeft") {
    nextPhoto(-1);
    openPhotoOverlay(currentPhotoUrl);
    return;
  }
  if (e.key === "ArrowRight") {
    nextPhoto(+1);
    openPhotoOverlay(currentPhotoUrl);
    return;
  }
});

function openPhotoOverlay(url) {
  if (!url) return;

  overlayOpen = true;
  photoOverlayImg.src = url;
  photoOverlay.style.display = "block";

  // hide hint when fullscreen opens
  showTvHint(false);
  showSpeakerHint(false);
  showPowerHint(false);
  hideRemoteHints();
}

function closePhotoOverlay() {
  overlayOpen = false;
  photoOverlay.style.display = "none";
  photoOverlayImg.src = "";
}


// ============================================================
// TV UI (Option A: Canvas -> CanvasTexture)
// ============================================================
const tvCanvas = document.createElement("canvas");
tvCanvas.width = 1920;
tvCanvas.height = 1080;

const tvCtx = tvCanvas.getContext("2d");
tvCtx.imageSmoothingEnabled = true;

const tvTex = new THREE.CanvasTexture(tvCanvas);
tvTex.colorSpace = THREE.SRGBColorSpace;
tvTex.flipY = false;

// UI state
let tvUiState = "MENU";    // MENU for now

let menuIndex = 0;         // 0=Photo, 1=Video, 2=3D Model
let blinkT0 = performance.now();
let menuHover = false;

function getTvMenuBtn() {
  // Bigger button on iOS for easier tapping
  if (isIOSDevice()) {
    return {
      pad: 48,
      w: 320,
      h: 120,
    };
  }

  // Desktop size (unchanged)
  return {
    pad: 36,
    w: 220,
    h: 86,
  };
}


// ============================================================
// ✅ Canvas helper: rounded rectangle
// (needed by PHOTO + VIDEO menu button drawing)
// ============================================================
function roundRect(ctx, x, y, w, h, r) {
  // Support either a number radius or per-corner object
  const radius = typeof r === "number"
    ? { tl: r, tr: r, br: r, bl: r }
    : { tl: 0, tr: 0, br: 0, bl: 0, ...r };

  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + w - radius.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
  ctx.lineTo(x + w, y + h - radius.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
  ctx.lineTo(x + radius.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
}


// simple menu renderer (we'll improve next steps)
function drawTvMenu() {
  const w = tvCanvas.width;
  const h = tvCanvas.height;

  // background
  tvCtx.clearRect(0, 0, w, h);
  tvCtx.fillStyle = "#111111";
  tvCtx.fillRect(0, 0, w, h);

  const items = ["PHOTO", "VIDEO", "3D MODEL"];

  // vertical layout values
  tvCtx.textAlign = "center";
  tvCtx.textBaseline = "middle";
  tvCtx.font = "bold 86px Arial";
  tvCtx.fillStyle = "white";

  const cx = w * 0.5;
  const startY = h * 0.35;
  const gapY = 130;

   // blinking highlight ✅ (restored)
  const t = (performance.now() - blinkT0) * 0.001; // seconds since last selection change
  const speedHz = 0.5;                             // blink speed (try 0.8–2.0)
  const alpha = 0.06 + 0.12 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * speedHz));

  const selY = startY + menuIndex * gapY;
  tvCtx.fillStyle = `rgba(255,255,255,${alpha})`;
  tvCtx.fillRect(w * 0.22, selY - 55, w * 0.56, 110);

  tvCtx.fillStyle = "white";
  for (let i = 0; i < items.length; i++) {
    tvCtx.fillText(items[i], cx, startY + i * gapY);
  }
  
  tvTex.needsUpdate = true;
}

const MENU_ITEMS = ["PHOTO", "VIDEO", "3D MODEL"];

function moveMenuSelection(delta) {
  if (!tvOn) return;               // only when TV is on
  if (tvUiState !== "MENU") return;

  const n = MENU_ITEMS.length;
  menuIndex = (menuIndex + delta + n) % n;

  // reset blink so highlight feels responsive
  blinkT0 = performance.now();

  // draw immediately so it feels instant on click
  drawTvMenu();

  console.log("📺 menuIndex:", menuIndex, MENU_ITEMS[menuIndex]);
}

function confirmMenuSelection() {
  if (!tvOn) return;
  if (tvUiState !== "MENU") return;

  const selected = MENU_ITEMS[menuIndex];
  console.log("✅ OK pressed. Selected:", selected);

  // switch UI state
  tvUiState = selected; // "PHOTO" | "VIDEO" | "3D MODEL"

  // ✅ PHOTO mode: load the first photo immediately
  if (tvUiState === "PHOTO") {
    photoImage = null;
    photoLoading = false;
    loadPhotoAt(0);
    return;
  }

if (tvUiState === "VIDEO") {
  ensureVideoEl();
  loadVideoAt(0, { autoPlay: true }); // start playing immediately
  return;
}

if (tvUiState === "3D MODEL") {
  ensureModelVideoEl();
  loadModelAt(0, { autoPlay: true }); // start playing immediately
  return;
}

  // ✅ 3D MODEL (placeholder for now)
  // keep menu (or you can clear screen)
  drawTvMenu();
}

function goBackToTvMenu() {
  if (!tvOn) return;

  // stop any active media so it doesn't keep running
  if (tvUiState === "VIDEO") stopVideoCompletely();
  if (tvUiState === "3D MODEL") stopModelCompletely();

  tvUiState = "MENU";
  blinkT0 = performance.now();
  tvMenuHoverFlipV = null; // ✅ re-detect mapping next time we hover menu
  drawTvMenu();
}


// ============================================================
// PHOTO GALLERY (draw images to the TV canvas)
// ============================================================
const PHOTO_PATHS = [
  "./assets/Photo/01-sweet.jpg",
  "./assets/Photo/02-carti.jpg",
  "./assets/Photo/03-james.jpg",
  "./assets/Photo/04-roof.jpg",
  "./assets/Photo/05-scan.jpg",
  "./assets/Photo/06-nyc.jpg",
  "./assets/Photo/07-nardo.jpg",
];

const imgLoader = new THREE.ImageLoader();
imgLoader.setCrossOrigin("anonymous");

let photoIndex = 0;
let photoImage = null;   // the currently loaded HTMLImageElement
let photoLoading = false;


function loadPhotoAt(index) {
  if (!tvOn) return;
  if (tvUiState !== "PHOTO") return;

  const n = PHOTO_PATHS.length;
  photoIndex = (index + n) % n;

  const url = PHOTO_PATHS[photoIndex];
  currentPhotoUrl = url;
  photoLoading = true;

  console.log("🖼 Loading photo:", url);

  imgLoader.load(
    url,
    (img) => {
      photoImage = img;
      photoLoading = false;
      drawPhotoToTv(img);
    },
    undefined,
    (err) => {
      console.warn("❌ Photo failed to load:", url, err);
      photoLoading = false;
    }
  );
}

function drawPhotoToTv(img) {
  const w = tvCanvas.width;
  const h = tvCanvas.height;

  tvCtx.clearRect(0, 0, w, h);
  tvCtx.fillStyle = "#000";
  tvCtx.fillRect(0, 0, w, h);

  const iw = img.width;
  const ih = img.height;

  // ✅ COVER (fills the whole TV, crops edges if needed)
  const scale = Math.max(w / iw, h / ih);

  // ✅ tiny overscan like real TV (hides small borders)
  const overscan = 1.02;
  const dw = iw * scale * overscan;
  const dh = ih * scale * overscan;

  const dx = (w - dw) * 0.5;
  const dy = (h - dh) * 0.5;

  tvCtx.drawImage(img, dx, dy, dw, dh);

if (tvOn && (tvUiState === "PHOTO" || tvUiState === "3D MODEL")) {
  const BTN = getTvMenuBtn();
  const bx = w - BTN.pad - BTN.w;
  const by = BTN.pad;

  tvCtx.save();

  if (menuHover) {
    tvCtx.globalAlpha = 0.9;
    tvCtx.fillStyle = "#222";
    tvCtx.shadowColor = "rgba(255,255,255,0.5)";
    tvCtx.shadowBlur = 25;
  } else {
    tvCtx.globalAlpha = 0.65;
    tvCtx.fillStyle = "#000";
  }

  roundRect(tvCtx, bx, by, BTN.w, BTN.h, 18);
  tvCtx.fill();
  tvCtx.restore();

  // border
  tvCtx.save();
  tvCtx.globalAlpha = 0.35;
  tvCtx.strokeStyle = "#fff";
  tvCtx.lineWidth = 3;
  roundRect(tvCtx, bx, by, BTN.w, BTN.h, 18);
  tvCtx.stroke();
  tvCtx.restore();

  // text
  tvCtx.save();
  tvCtx.fillStyle = "#fff";
  tvCtx.globalAlpha = 0.92;
  tvCtx.font = "bold 46px Arial";
  tvCtx.textAlign = "center";
  tvCtx.textBaseline = "middle";
  tvCtx.fillText("MENU", bx + BTN.w * 0.5, by + BTN.h * 0.52);
  tvCtx.restore();
}

  tvTex.needsUpdate = true;
}

function nextPhoto(delta) {
  if (!tvOn) return;
  if (tvUiState !== "PHOTO") return;
  if (photoLoading) return;

  loadPhotoAt(photoIndex + delta);
}

// ============================================================
// VIDEO GALLERY (draw video frames to the TV canvas)
// ============================================================
const VIDEO_PATHS = [
  "./assets/Video/01-sweet93-OG.mp4",
];

let videoIndex = 0;
let videoEl = null;          // single persistent <video>
let videoReady = false;      // true once we have dimensions/frames
let videoPlaying = false;    // our UI state
let videoWantsAutoPlay = false; 

function ensureVideoEl() {
  if (videoEl) return;

  videoEl = document.createElement("video");
  videoEl.crossOrigin = "anonymous";
  videoEl.preload = "metadata";
  videoEl.playsInline = true;
  videoEl.setAttribute("webkit-playsinline", ""); // iOS Safari
  videoEl.loop = true; // optional (feel free to set false)
  videoEl.muted = false; // audio allowed, but play requires a gesture (OK click counts)
  videoEl.controls = false;

videoEl.addEventListener("loadeddata", async () => {
  videoReady = true;

  // draw a first frame immediately
  if (tvOn && tvUiState === "VIDEO") drawVideoFrameToTv();

  if (tvOn && tvUiState === "VIDEO" && videoWantsAutoPlay && videoEl.paused) {
    try {
      await playVideo();
      videoWantsAutoPlay = false; // ✅ only clear if play succeeded
    } catch {}
  }

});


  videoEl.addEventListener("pause", () => (videoPlaying = false));
  videoEl.addEventListener("play", () => (videoPlaying = true));
}

function loadVideoAt(index, { autoPlay = false } = {}) {
  if (!tvOn) return;
  if (tvUiState !== "VIDEO") return;

  ensureVideoEl();

  const n = VIDEO_PATHS.length;
  videoIndex = (index + n) % n;

  const url = VIDEO_PATHS[videoIndex];

  console.log("🎬 Loading video:", url);

  videoReady = false;
  videoPlaying = false;

const __endVid = () => {}; // ✅ don't count video in loader


  // IMPORTANT: stop current playback before swapping src
  try {
    videoEl.pause();
    videoEl.currentTime = 0;
 } catch {}

videoEl.src = url;
videoEl.load();

let ended = false; // ✅ NEW: prevents double-calling

const done = () => {
  if (ended) return;          // ✅ NEW
  ended = true;               // ✅ NEW

  __endVid();
  videoEl.removeEventListener("loadedmetadata", done);
  videoEl.removeEventListener("error", done);
};

videoEl.addEventListener("loadeddata", done, { once: true });   // ✅ first frame decodable
videoEl.addEventListener("canplay", done, { once: true });      // ✅ fallback
videoEl.addEventListener("error", done, { once: true });

setTimeout(done, 8000); // ✅ give big mp4 time, still guarantees finish


// show black while loading
clearTvScreen();

if (autoPlay) {
  playVideo();
}
}

async function playVideo() {
  if (!tvOn) return;
  if (tvUiState !== "VIDEO") return;
  if (!videoEl) return;

  try {
    await videoEl.play();
    videoPlaying = true;
  } catch (err) {
    console.warn("Video play blocked (needs user gesture):", err);
    videoPlaying = false;
  }
}

function pauseVideo() {
  if (!videoEl) return;
  videoEl.pause();
  videoPlaying = false;
}

function stopVideoCompletely() {
  if (!videoEl) return;

  // stop playback
  videoEl.pause();
  videoPlaying = false;

  // reset to start so it doesn’t “keep running”
  try {
    videoEl.currentTime = 0;
  } catch {}

  // OPTIONAL but recommended: clear frame + redraw menu/black
  videoReady = false;
}


function toggleVideoPlayPause() {
  if (!videoEl) return;
  if (videoEl.paused) playVideo();
  else pauseVideo();
}

function nextVideo(delta) {
  if (!tvOn) return;
  if (tvUiState !== "VIDEO") return;

  // keep playing state when switching
  const shouldPlay = videoPlaying && videoEl && !videoEl.paused;
  loadVideoAt(videoIndex + delta, { autoPlay: shouldPlay });
}

async function overlayNextVideo(delta) {
  if (!videoOverlayOpen) return;
  if (tvUiState !== "VIDEO") return;

  // move index (wrap)
  const n = VIDEO_PATHS.length;
  videoIndex = (videoIndex + delta + n) % n;

  const url = VIDEO_PATHS[videoIndex];

  // 1) Update the TV video source (keep it paused while overlay is open)
  // (This keeps your app state consistent when you exit overlay.)
  loadVideoAt(videoIndex, { autoPlay: false });

  // 2) Update the overlay player source + keep playing
  try {
    videoOverlayEl.pause();
    videoOverlayEl.src = url;
    videoOverlayEl.currentTime = 0;
    videoOverlayEl.load();

    try { await videoOverlayEl.play(); } catch (err) {
      console.warn("Overlay play blocked:", err);
    }
  } catch (e) {
    console.warn("overlayNextVideo failed:", e);
  }
}

function drawVideoFrameToTv() {
  if (!videoEl || !videoReady) return;

  const w = tvCanvas.width;
  const h = tvCanvas.height;

  tvCtx.clearRect(0, 0, w, h);
  tvCtx.fillStyle = "#000";
  tvCtx.fillRect(0, 0, w, h);

  const iw = videoEl.videoWidth || 16;
  const ih = videoEl.videoHeight || 9;

  // ✅ COVER (same logic as PHOTO)
  const scale = Math.max(w / iw, h / ih);
  const overscan = 1.02;
  const dw = iw * scale * overscan;
  const dh = ih * scale * overscan;
  const dx = (w - dw) * 0.5;
  const dy = (h - dh) * 0.5;

  // draw the current frame
  tvCtx.drawImage(videoEl, dx, dy, dw, dh);

if (tvOn && tvUiState === "VIDEO") {
  const BTN = getTvMenuBtn();
  const bx = w - BTN.pad - BTN.w;
  const by = BTN.pad;

  // ✅ 1) PAUSED overlay FIRST (so MENU can sit on top)
  if (videoEl.paused) {
    tvCtx.save();
    tvCtx.fillStyle = "rgba(0,0,0,0.35)";
    tvCtx.fillRect(0, 0, w, h);

    tvCtx.fillStyle = "#fff";
    tvCtx.font = "bold 64px Arial";
    tvCtx.textAlign = "center";
    tvCtx.textBaseline = "middle";
    tvCtx.fillText("PAUSED", w * 0.5, h * 0.5);

    tvCtx.font = "32px Arial";
    tvCtx.fillText("OK: Play/Pause    ◀/▶: Prev/Next", w * 0.5, h * 0.5 + 80);
    tvCtx.restore();
  }

  // ✅ 2) MENU button SECOND (drawn on top of overlay)
  tvCtx.save();

  if (menuHover) {
    tvCtx.globalAlpha = 0.9;
    tvCtx.fillStyle = "#222";
    tvCtx.shadowColor = "rgba(255,255,255,0.5)";
    tvCtx.shadowBlur = 25;
  } else {
    tvCtx.globalAlpha = 0.65;
    tvCtx.fillStyle = "#000";
  }

  roundRect(tvCtx, bx, by, BTN.w, BTN.h, 18);
  tvCtx.fill();
  tvCtx.restore();

  // border
  tvCtx.save();
  tvCtx.globalAlpha = 0.35;
  tvCtx.strokeStyle = "#fff";
  tvCtx.lineWidth = 3;
  roundRect(tvCtx, bx, by, BTN.w, BTN.h, 18);
  tvCtx.stroke();
  tvCtx.restore();

  // text
  tvCtx.save();
  tvCtx.fillStyle = "#fff";
  tvCtx.globalAlpha = 0.92;
  tvCtx.font = "bold 46px Arial";
  tvCtx.textAlign = "center";
  tvCtx.textBaseline = "middle";
  tvCtx.fillText("MENU", bx + BTN.w * 0.5, by + BTN.h * 0.52);
  tvCtx.restore();
}

  tvTex.needsUpdate = true;
}

// ✅ MODEL MEDIA TYPE HELPERS (put right above MODEL_PATHS)
function isImageUrl(url = "") {
  return /\.(png|jpe?g|webp|gif)$/i.test(url.split("?")[0]);
}
function isVideoUrl(url = "") {
  return /\.(mp4|webm|mov|m4v|ogg)$/i.test(url.split("?")[0]);
}

// ============================================================
// 3D MODEL GALLERY (actually mp4s — same system as VIDEO) ✅
// ============================================================
const MODEL_PATHS = [
  "./assets/3D Model/01-Gate.mp4",
  "./assets/3D Model/02-Skateboard.mp4",
  "./assets/3D Model/03-Skateboard-2.mp4",
  "./assets/3D Model/04-UAP.mp4",
  "./assets/3D Model/05-Morningstar.mp4",
  "./assets/3D Model/06-Bat.mp4",
  "./assets/3D Model/07-Chainsaw.mp4",
  "./assets/3D Model/08-Granade1.mp4",
  
];

let modelIndex = 0;

// ✅ we now support BOTH video + photo
let modelVideoEl = null;          // <video>
let modelImageEl = null;          // HTMLImageElement
let modelMediaType = "video";     // "video" | "image"

let modelReady = false;
let modelPlaying = false;
let modelWantsAutoPlay = false;

let currentModelUrl = null;       // track what is currently loaded
let modelImageLoading = false;


function ensureModelVideoEl() {
  if (modelVideoEl) return;

  modelVideoEl = document.createElement("video");
  modelVideoEl.crossOrigin = "anonymous";
  modelVideoEl.preload = "metadata";
  modelVideoEl.playsInline = true;
  modelVideoEl.setAttribute("webkit-playsinline", "");
  modelVideoEl.loop = true;
  modelVideoEl.muted = false;
  modelVideoEl.controls = false;

  modelVideoEl.addEventListener("loadeddata", async () => {
    modelReady = true;

    if (tvOn && tvUiState === "3D MODEL") drawModelToTv();

    if (tvOn && tvUiState === "3D MODEL" && modelWantsAutoPlay && modelVideoEl.paused) {
      try {
        await playModel();
        modelWantsAutoPlay = false;
      } catch {}
    }
  });

  modelVideoEl.addEventListener("pause", () => (modelPlaying = false));
  modelVideoEl.addEventListener("play", () => (modelPlaying = true));
}

function ensureModelImageEl() {
  if (modelImageEl) return;

  modelImageEl = new Image();
  modelImageEl.crossOrigin = "anonymous";
}

function loadModelAt(index, { autoPlay = false } = {}) {
  if (!tvOn) return;
  if (tvUiState !== "3D MODEL") return;

  const n = MODEL_PATHS.length;
  modelIndex = (index + n) % n;

  const url = MODEL_PATHS[modelIndex];
  currentModelUrl = url;

  modelReady = false;
  modelPlaying = false;

  // show black while loading
  clearTvScreen();

 if (isImageUrl(url)) {
  modelMediaType = "image";
  ensureModelImageEl();

  // ✅ STOP ANY PREVIOUS MODEL VIDEO (prevents flicker/glitch)
  if (modelVideoEl) {
    try { modelVideoEl.pause(); } catch {}
  }
  modelPlaying = false;

  modelImageLoading = true;
  modelImageEl.onload = () => {

      modelImageLoading = false;
      modelReady = true;
      drawModelToTv(); // this function should handle both image/video
    };
    modelImageEl.onerror = (e) => {
      modelImageLoading = false;
      console.warn("❌ Model image failed to load:", url, e);
    };

    modelImageEl.src = url;
    return;
  }

  // ---- VIDEO ----
  modelMediaType = "video";
  ensureModelVideoEl();

  try {
    modelVideoEl.pause();
    modelVideoEl.currentTime = 0;
  } catch {}

  modelVideoEl.src = url;
  modelVideoEl.load();

  if (autoPlay) playModel();
  else pauseModel();
}

async function playModel() {
  if (!tvOn) return;
  if (tvUiState !== "3D MODEL") return;
  if (!modelVideoEl) return;

  try {
    await modelVideoEl.play();
    modelPlaying = true;
  } catch (err) {
    console.warn("3D Model play blocked (needs user gesture):", err);
    modelPlaying = false;
  }
}

function pauseModel() {
  if (modelMediaType !== "video") return; // ✅ ADD THIS LINE HERE
  if (!modelVideoEl) return;
  modelVideoEl.pause();
  modelPlaying = false;
}



function stopModelCompletely() {
  if (!modelVideoEl) return;

  modelVideoEl.pause();
  modelPlaying = false;

  try {
    modelVideoEl.currentTime = 0;
  } catch {}

  modelReady = false;
}

function toggleModelPlayPause() {
  if (modelMediaType !== "video") return; // ✅ ADD THIS LINE HERE
  if (!modelVideoEl) return;
  if (modelVideoEl.paused) playModel();
  else pauseModel();
}


function nextModel(delta) {
  if (!tvOn) return;
  if (tvUiState !== "3D MODEL") return;

  const shouldPlay = modelPlaying && modelVideoEl && !modelVideoEl.paused;

  loadModelAt(modelIndex + delta, { autoPlay: shouldPlay });
}

function drawModelToTv() {
  if (modelMediaType === "image") {
    if (!modelImageEl || !modelReady) return;
    drawPhotoToTv(modelImageEl); // reuse your existing cover-draw logic
    return;
  }

  // video
  drawModelFrameToTv();
}

function drawModelFrameToTv() {
  if (modelMediaType !== "video") return; // ✅ ADD THIS LINE (FIRST)
  if (!modelVideoEl || !modelReady) return;

  const w = tvCanvas.width;
  const h = tvCanvas.height;

  tvCtx.clearRect(0, 0, w, h);
  tvCtx.fillStyle = "#000";
  tvCtx.fillRect(0, 0, w, h);

  const iw = modelVideoEl.videoWidth || 16;
  const ih = modelVideoEl.videoHeight || 9;

  // ✅ COVER (same as PHOTO + VIDEO)
  const scale = Math.max(w / iw, h / ih);
  const overscan = 1.02;
  const dw = iw * scale * overscan;
  const dh = ih * scale * overscan;
  const dx = (w - dw) * 0.5;
  const dy = (h - dh) * 0.5;

  tvCtx.drawImage(modelVideoEl, dx, dy, dw, dh);

  // ✅ MENU button (top-right)
  if (tvOn && tvUiState === "3D MODEL") {
    const BTN = getTvMenuBtn();
    const bx = w - BTN.pad - BTN.w;
    const by = BTN.pad;

    tvCtx.save();

    if (menuHover) {
      tvCtx.globalAlpha = 0.9;
      tvCtx.fillStyle = "#222";
      tvCtx.shadowColor = "rgba(255,255,255,0.5)";
      tvCtx.shadowBlur = 25;
    } else {
      tvCtx.globalAlpha = 0.65;
      tvCtx.fillStyle = "#000";
    }

    roundRect(tvCtx, bx, by, BTN.w, BTN.h, 18);
    tvCtx.fill();
    tvCtx.restore();

    tvCtx.save();
    tvCtx.globalAlpha = 0.35;
    tvCtx.strokeStyle = "#fff";
    tvCtx.lineWidth = 3;
    roundRect(tvCtx, bx, by, BTN.w, BTN.h, 18);
    tvCtx.stroke();
    tvCtx.restore();

    tvCtx.save();
    tvCtx.fillStyle = "#fff";
    tvCtx.globalAlpha = 0.92;
    tvCtx.font = "bold 46px Arial";
    tvCtx.textAlign = "center";
    tvCtx.textBaseline = "middle";
    tvCtx.fillText("MENU", bx + BTN.w * 0.5, by + BTN.h * 0.52);
    tvCtx.restore();
  }

  // ✅ paused overlay (same UI as VIDEO)
  if (modelVideoEl.paused) {
    tvCtx.save();
    tvCtx.fillStyle = "rgba(0,0,0,0.35)";
    tvCtx.fillRect(0, 0, w, h);

    tvCtx.fillStyle = "#fff";
    tvCtx.font = "bold 64px Arial";
    tvCtx.textAlign = "center";
    tvCtx.textBaseline = "middle";
    tvCtx.fillText("PAUSED", w * 0.5, h * 0.5);

    tvCtx.font = "32px Arial";
    tvCtx.fillText("OK: Play/Pause    ◀/▶: Prev/Next", w * 0.5, h * 0.5 + 80);
    tvCtx.restore();
  }

  tvTex.needsUpdate = true;
}


// TV UI HELPERS (clears screen + disables/enables texture)
// PUT DIRECTLY UNDER drawTvMenu()
// ============================================================
function clearTvScreen() {
  const w = tvCanvas.width;
  const h = tvCanvas.height;

  tvCtx.clearRect(0, 0, w, h);
  tvCtx.fillStyle = "#000000";
  tvCtx.fillRect(0, 0, w, h);

  tvTex.needsUpdate = true;
}

function applyTvTextureEnabled(enabled) {
  if (!tvScreenMatRef) return;

  tvScreenMatRef.map = enabled ? tvTex : null;
  tvScreenMatRef.emissiveMap = enabled ? tvTex : null;
  tvScreenMatRef.needsUpdate = true;
}

const tracks = [
  "./assets/Audio/01-Aftonvarldar1.mp3",
  "./assets/Audio/02-rip-fredo-notice-me-011.mp3",
  "./assets/Audio/03-floor-555-011.mp3",
  "./assets/Audio/04-12r-011.mp3",
  "./assets/Audio/05-leave-everything-011.mp3",
  "./assets/Audio/06-27-title-flight-011.mp3",
  "./assets/Audio/07-nwo-ministry-011.mp3",
  "./assets/Audio/08-bline-011.mp3",
  "./assets/Audio/09-centaurella-44-011.mp3",
  "./assets/Audio/10-under-the-same-name-011.mp3",
  "./assets/Audio/11-a-sad-cartoon-011.mp3", 
  "./assets/Audio/12-one-weak-011.mp3",
  "./assets/Audio/13-xo-011.mp3",
  "./assets/Audio/14-min-dag1.mp3",
  "./assets/Audio/15-frosting-011.mp3",
  "./assets/Audio/16-relay-011.mp3",
  "./assets/Audio/17-pistol-011.mp3",
  "./assets/Audio/18-widowdusk-011.mp3",
  "./assets/Audio/19-letters-to-frances_011.mp3",
];

let trackIndex = 0;
let isPlaying = false;

// 🔓 ADD THIS BLOCK RIGHT HERE
let audioUnlocked = false;

let bgAudio = null;
let bgAudioEnabled = true;

async function unlockAudioOnce() {
  if (audioUnlocked) return;

  const a = currentAudio();

  try {
    a.muted = true;
    await a.play();
    a.pause();
    a.currentTime = 0;
    a.muted = false;

    audioUnlocked = true;
    console.log("🔓 Speaker audio unlocked");
  } catch (e) {
    console.warn("Speaker audio unlock failed:", e);
    audioUnlocked = false;
  }
}

const audioEls = tracks.map((src) => {
  const a = new Audio(src);
  a.preload = "metadata"; // ✅ lighter than "auto" (doesn't download whole mp3 immediately)
  a.crossOrigin = "anonymous";

  // ✅ Count each track as an asset, finish when metadata loads (duration available)
  const __endAudio = __beginAsset(src);

  const done = () => {
    __endAudio();
    a.removeEventListener("loadedmetadata", done);
    a.removeEventListener("error", done);
    a.removeEventListener("canplaythrough", done);
  };

  a.addEventListener("loadedmetadata", done, { once: true });
  a.addEventListener("canplaythrough", done, { once: true }); // fallback
  a.addEventListener("error", done, { once: true });

  return a;
});


// ✅ AUTO-NEXT when a song finishes
audioEls.forEach((a, i) => {
  a.addEventListener("ended", () => {
    // only advance if THIS ended track is the active one and we were playing
    if (i !== trackIndex) return;
    if (!isPlaying) return;

    console.log("⏭ Track ended → auto next");
    nextTrack();
  });
});


function currentAudio() {
  return audioEls[trackIndex];
}

function ensureBackgroundAudio() {
  if (bgAudio) return bgAudio;

  bgAudio = new Audio("./assets/Audio/Background-sound11.mp3");
  bgAudio.preload = "auto";
  bgAudio.crossOrigin = "anonymous";
  bgAudio.loop = true;
  bgAudio.volume = 0.60;
  bgAudio.playsInline = true;
  bgAudio.setAttribute?.("webkit-playsinline", "");

  return bgAudio;
}

function stopMusicBecauseUserLeft() {
  // stop speaker music
  for (const a of audioEls) {
    try {
      a.pause();
      a.currentTime = 0;
    } catch {}
  }

  // stop background ambience
  if (bgAudio) {
    try {
      bgAudio.pause();
      bgAudio.currentTime = 0;
    } catch {}
  }

  isPlaying = false;
  updateSpeakerHintText?.();
}

function pauseAll() {
  for (const a of audioEls) {
    a.pause();
    a.currentTime = 0;
  }
  isPlaying = false;
}

async function playBackgroundAudio() {
  if (!bgAudioEnabled) return;

  const bg = ensureBackgroundAudio();

  try {
    if (bg.paused) {
      await bg.play();
      console.log("🌫️ Background ambience playing");
    }
  } catch (err) {
    console.warn("Background ambience play blocked:", err);
  }
}

async function tryAutoStartBackgroundAudio() {
  if (!bgAudioEnabled) return;

  const bg = ensureBackgroundAudio();

  try {
    await bg.play();
    console.log("🌫️ Background ambience autoplay started");
    return true;
  } catch (err) {
    console.warn("Background ambience autoplay blocked:", err);
    return false;
  }
}

function pauseBackgroundAudio() {
  if (!bgAudio) return;
  bgAudio.pause();
}

ensureBackgroundAudio();
tryAutoStartBackgroundAudio();

async function playCurrent() {
  const a = currentAudio();
  try {
    await a.play(); // requires user gesture — click counts ✅
    isPlaying = true;
    console.log("▶️ Playing track:", trackIndex, tracks[trackIndex]);
  } catch (err) {
    console.warn("Audio play blocked:", err);
  }
}

let bgAudioStartedOnce = false;

async function startBackgroundAudioFromUserGesture() {
  if (bgAudioStartedOnce) return;
  if (!bgAudioEnabled) return;

  const bg = ensureBackgroundAudio();

  try {
    await bg.play();
    bgAudioStartedOnce = true;
    console.log("🌫️ Background ambience started from early gesture");
  } catch (err) {
    console.warn("Background ambience early gesture start blocked:", err);
  }
}

async function togglePlayPause() {
  await unlockAudioOnce();

  const a = currentAudio();
  if (!isPlaying || a.paused) {
    await playCurrent();
  } else {
    a.pause();
    isPlaying = false;
    console.log("⏸ Paused track:", trackIndex);
  }

  updateSpeakerHintText?.();
}


async function nextTrack(forcePlay = false) {
  const wasPlaying = isPlaying || forcePlay;

  const a = currentAudio();
  a.pause();
  a.currentTime = 0;

  trackIndex = (trackIndex + 1) % audioEls.length;

  if (wasPlaying) {
    await playCurrent();
  } else {
    isPlaying = false;
  }
}

// TV state + animation
let tvOn = false;
let tvAnim = null; // { from: 0|1, to: 0|1, t0: seconds }
let tvPower = 0; 

let tvBootT0 = 0;
let tvBooting = false; 
let tvUIReady = false;


// ============================================================
// ✅ iOS LANDSCAPE LOCK (pairs with index.html overlay)
// ============================================================
function isIOSDevice() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isLandscapeNow() {
  return window.matchMedia("(orientation: landscape)").matches;
}

function isIOSPortraitBlocked() {
  return isIOSDevice() && !isLandscapeNow();
}

function isInHierarchy(obj, target) {
  let o = obj;
  while (o) {
    if (o === target) return true;
    o = o.parent;
  }
  return false;
}

function hitIsLamp(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    // match either mesh name or material name
    if (n.includes("lamp") || mn.includes("lamp")) return true;

    o = o.parent;
  }
  return false;
}

function hitIsDogTag(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (n.includes("dog_tag1") || mn.includes("dog_tag1")) return true;

    o = o.parent;
  }
  return false;
}

function hitIsDunkeheitAlbum(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (n.includes("dunkeheit_album") || mn.includes("dunkeheit_album")) return true;

    o = o.parent;
  }
  return false;
}

function hitIsAllDVD(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (n.includes("all_dvd") || mn.includes("all_dvd")) return true;

    o = o.parent;
  }
  return false;
}

function hitIsDVDOnPlayer1(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (
      n.includes("dvd_on_player1") ||
      mn.includes("dvd_on_player1")
    ) return true;

    o = o.parent;
  }
  return false;
}

function hitIsBook4(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (n.includes("book4") || mn.includes("book4")) return true;

    o = o.parent;
  }
  return false;
}

function hitIsBoard2(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (n.includes("board2") || mn.includes("board2")) return true;

    o = o.parent;
  }
  return false;
}

function hitIsDoor4(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();

    if (n.includes("door4") || mn.includes("door4")) return true;

    o = o.parent;
  }
  return false;
}

function getTvCanvasPxPyFromUv(uv) {
  if (!uv) return null;

  const w = tvCanvas.width;
  const h = tvCanvas.height;

  const rx = tvTex.repeat?.x ?? 1;
  const ry = tvTex.repeat?.y ?? 1;
  const ox = tvTex.offset?.x ?? 0;
  const oy = tvTex.offset?.y ?? 0;

  // base UV (0..1)
  let u = uv.x * rx + ox;
  let v = uv.y * ry + oy;

  // ✅ normalize in case repeat/offset push out of range
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;

  v = 1 - v;

  return { w, h, px: u * w, py: v * h };
}

function handleIOSTvTap(uv) {
  const pos = getTvCanvasPxPyFromUv(uv);
  if (!pos) return false;

  const { w, h, px, py } = pos;
  
// ✅ If TV is OFF, any tap on the screen turns it ON and shows MENU
if (!tvOn) {
  setTvPower(true);

  // ✅ iOS onboarding hint (4 seconds)
  showIosMenuControlsHintOnce();

  return true;
}


 // MENU button area (top-right) works in all states that show it
const BTN = getTvMenuBtn();   // ✅ ADD THIS

const bx = w - BTN.pad - BTN.w;
const by = BTN.pad;


  // ✅ Robust hit test: some meshes have V flipped, some don’t.
  // We check BOTH possibilities so the MENU button is always clickable.
  const pyA = py;           // current mapping (whatever getTvCanvasPxPyFromUv returned)
  const pyB = h - py;       // alternate mapping (flipped vertically)

const inMenuBtnA =
  px >= bx && px <= bx + BTN.w &&
  pyA >= by && pyA <= by + BTN.h;

const inMenuBtnB =
  px >= bx && px <= bx + BTN.w &&
  pyB >= by && pyB <= by + BTN.h;

if (inMenuBtnA || inMenuBtnB) {
  if (isIOSDevice()) tvIgnoreNextPointerUp = true;
  goBackToTvMenu();
  return true;
}

  // ✅ Double-tap anywhere else = fullscreen overlay (when relevant)
  const now = performance.now();
  const isDoubleTap = (now - lastTvTapTime) < TV_DOUBLE_TAP_MS;
  lastTvTapTime = now;

  const x01 = px / w;  // 0..1
  const y01 = pyA / h; // 0..1  ✅ use primary mapping, not raw py

if (tvUiState === "MENU") {
  // ✅ iOS uses EDIT 2 swipe/tap on pointerup
  if (isIOSDevice()) return false;

  // ✅ Desktop/non-iOS: tap zones on the TV screen
  // top third = up, bottom third = down, middle = OK
  if (y01 < 0.33) {
    moveMenuSelection(-1);
    return true;
  }
  if (y01 > 0.66) {
    moveMenuSelection(+1);
    return true;
  }

  confirmMenuSelection();
  return true;
}

// ------------------------------------------------------------
// ✅ PHOTO: left/right = prev/next
// Double tap = fullscreen overlay (match VIDEO + 3D MODEL)
// ------------------------------------------------------------
if (tvUiState === "PHOTO") {
  if (isDoubleTap) {
    openPhotoOverlay(currentPhotoUrl);
    return true;
  }

  if (x01 < 0.33) {
    nextPhoto(-1);
    return true;
  }
  if (x01 > 0.66) {
    nextPhoto(+1);
    return true;
  }

  // center single tap: do nothing (or keep for future UI)
  return true;
}

  // ------------------------------------------------------------
  // ✅ VIDEO: left/right = prev/next, center = play/pause
  // Double tap = fullscreen overlay
  // ------------------------------------------------------------
  if (tvUiState === "VIDEO") {
    if (isDoubleTap) {
      openVideoOverlay();
      return true;
    }

    if (x01 < 0.33) {
      nextVideo(-1);
      return true;
    }
    if (x01 > 0.66) {
      nextVideo(+1);
      return true;
    }

    toggleVideoPlayPause();
    drawVideoFrameToTv(); // refresh paused overlay text
    return true;
  }

  // ------------------------------------------------------------
  // ✅ 3D MODEL: left/right = prev/next, center = play/pause
  // Double tap = fullscreen overlay
  // ------------------------------------------------------------
  if (tvUiState === "3D MODEL") {
    if (isDoubleTap) {
      openModelOverlay();
      return true;
    }

    if (x01 < 0.33) {
      nextModel(-1);
      return true;
    }
    if (x01 > 0.66) {
      nextModel(+1);
      return true;
    }

    toggleModelPlayPause();
    drawModelFrameToTv();
    return true;
  }

  return false;
}

function openExternal(url) {
  if (!url) return false;

  try {
    // ✅ Safari-friendly: create a real <a> and click it
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    document.body.appendChild(a);

    // ✅ a.click() works better than dispatchEvent on iOS Safari
    a.click();
    a.remove();

    return true;
  } catch (e) {
    console.warn("openExternal failed, falling back:", e);
  }

  // ✅ Always-works fallback (same tab)
  window.location.assign(url);
  return false;
}

function setTvPower(nextOn) {
  log("setTvPower", nextOn, {
    hasScreenMesh: !!tvScreenMeshRef,
    hasScreenMat: !!tvScreenMatRef
  });

  const from = tvOn ? 1 : 0;
  const to = nextOn ? 1 : 0;
  if (from === to) return;

tvOn = nextOn;

if (!tvOn) {
  tvTouchActive = false;
  tvTouchStartedWhileOff = false;
  tvTouchPointerId = null;

  // ✅ reset iOS remote pulse for the next power-on session
  iosRemotePulseArmed = true;
  iosPulseStarted = false;
  iosNextPulseAtMs = 0;
  stopIosRemotePulse();
}

if (!tvOn) {
  stopVideoCompletely();
  stopModelCompletely();
  clearTvScreen();
  applyTvTextureEnabled(false);

  grainOverlay.style.opacity = "0.02"; // softer grain when TV is off
} else {
  applyTvTextureEnabled(true);

  grainOverlay.style.opacity = "0.03"; // normal grain when TV is on
}

    // when turning ON, reset blink and draw the menu immediately
 if (tvOn) {
  blinkT0 = performance.now();
  tvUiState = "MENU";
  menuIndex = 0;
  tvMenuHoverFlipV = null; // ✅ re-detect mapping for menu hover

  // ✅ start boot animation
  tvBootT0 = performance.now();
  tvBooting = true;

  drawTvMenu();
}

  tvAnim = { from, to, t0: performance.now() / 1000 };

// ✅ Keep remote pulses in sync with TV on/off
if (isIOSDevice()) {
  if (tvOn) {
    // ✅ always restart iOS pulse fresh when TV turns on
    iosPulseStarted = false;
    iosNextPulseAtMs = 0;
    startIosRemotePulse();
  } else {
    stopIosRemotePulse();
  }
} else {
  syncDesktopPulseWithTvState();
}

}

function updateTv() {
  if (!tvScreenMeshRef || !tvAnim || !tvScreenMatRef) return;

  const now = performance.now() / 1000;
  const dt = now - tvAnim.t0;

  const DUR = 0.55;
  let t = Math.min(dt / DUR, 1);
  t = 1 - Math.pow(1 - t, 3); // easeOutCubic

  const a = tvAnim.from + (tvAnim.to - tvAnim.from) * t;
  tvPower = a;

  // ✅ CRT squeeze ONLY in Y (no X shrink = no side reveal / "sliding" illusion)
  tvScreenMeshRef.scale.set(
    tvScreenScale0.x,                           // keep width locked
    tvScreenScale0.y * (0.985 + 0.015 * a),     // squeeze in Y only
    tvScreenScale0.z
  );

  // emissive animation (OFF -> ON)
  const offI = 0.0;
  const onI = 1.25;

  const pop = a * (1 - a) * 4;
  let intensity = offI + (onI - offI) * a + 0.35 * pop;

if (tvBooting) {
  const dtBoot = (performance.now() - tvBootT0) / 1000;

  if (dtBoot < 0.08) {
    // quick flash
    intensity += 2.2;
  } 
  else if (dtBoot < 0.23) {
    // short fast flicker
    intensity *= 0.85 + Math.random() * 0.3;
  } 
  else {
    // boot done
    tvBooting = false;
  }
}


tvScreenMatRef.emissiveIntensity = intensity;


  const baseOff = new THREE.Color(0x111111);  // off = dark
  const baseOn  = new THREE.Color(0xd0d0d0);  // on  = bright (IMPORTANT)
  tvScreenMatRef.color.lerpColors(baseOff, baseOn, a);

  tvScreenMatRef.needsUpdate = true;

  if (dt >= DUR) {
    tvAnim = null;
      tvScreenMeshRef.scale.copy(tvScreenScale0);


    tvScreenMatRef.emissiveIntensity = tvOn ? onI : offI;
    tvScreenMatRef.color.copy(tvOn ? baseOn : baseOff);
    tvScreenMatRef.needsUpdate = true;
    tvPower = tvOn ? 1 : 0;
  }
}

// ============================================================
// ✅ iOS TV MENU SWIPE STATE (EDIT 2)
// ============================================================
let tvTouchActive = false;
let tvTouchStartX = 0;
let tvTouchStartY = 0;
let tvTouchStartT = 0;

let tvTouchStartedWhileOff = false;   // ✅ prevents “auto-enter PHOTO” on power-on tap
let tvTouchPointerId = null;          // ✅ for pointer capture


// swipe tuning
const TV_SWIPE_MIN_PX = 34;       // how far finger must move
const TV_TAP_MAX_PX   = 12;       // below this = tap
const TV_SWIPE_MAX_MS = 650;      // ignore slow drags
// ------------------------------------------------------------
// CLICK / DOUBLE-CLICK HANDLER (TV + SPEAKER)
// ------------------------------------------------------------
let lastClickTime = 0;
const DOUBLE_CLICK_MS = 280;

let lastTvTapTime = 0;
const TV_DOUBLE_TAP_MS = 320;
let pendingExternalUrl = null;
let tvIgnoreNextPointerUp = false;
let tvMenuHoverFlipV = null; // null until we detect correct orientation

// ============================================================
// ✅ DESKTOP REMOTE PULSE (match iOS behavior exactly)
// TV OFF  -> Power pulses every ~3.6s with smooth fade
// TV ON   -> OK/UP/DOWN/LEFT/RIGHT pulse TOGETHER every 8s
//           and STOP permanently once user presses any of those buttons
// ============================================================

let desktopPowerPulseTimer = null;
let desktopRemotePulseTimer = null;
let desktopRemoteRippleTimers = [];

let desktopRemotePulseArmed = true; // ✅ true until user presses any remote btn while TV ON

function _setRemoteGlow(mesh, on, color) {
  if (!mesh) return;
  if (typeof setGlowTarget !== "function") return;
  if (typeof color === "undefined") return;
  setGlowTarget(mesh, on, color); // your updateGlow() should do the smoothing fade
}

// ---- POWER PULSE (TV OFF) ----
function stopDesktopPowerPulse() {
  if (desktopPowerPulseTimer) {
    clearTimeout(desktopPowerPulseTimer);
    desktopPowerPulseTimer = null;
  }
  _setRemoteGlow(powerButtonMeshRef, false, POWER_GLOW_COLOR);
}

function startDesktopPowerPulse() {
  if (isIOSDevice()) return;
  if (!powerButtonMeshRef) return;

  stopDesktopPowerPulse();

  // ✅ Match the iOS timing you liked
  const onMs   = IOS_POWER_ON_MS;
  const offMs  = IOS_POWER_OFF_MS;
  const everyMs = onMs + offMs;

  const tick = () => {
    if (tvOn) return;

    _setRemoteGlow(powerButtonMeshRef, true, POWER_GLOW_COLOR);

    setTimeout(() => {
      _setRemoteGlow(powerButtonMeshRef, false, POWER_GLOW_COLOR);
    }, onMs);

    desktopPowerPulseTimer = setTimeout(tick, everyMs);
  };

  tick();
}

function stopDesktopRemoteOnPulse() {
  if (desktopRemotePulseTimer) {
    clearTimeout(desktopRemotePulseTimer);
    desktopRemotePulseTimer = null;
  }

  clearDesktopRemoteRippleTimers();

  _setRemoteGlow(okButtonMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(upArrowMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(downArrowMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(leftArrowMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(rightArrowMeshRef, false, REMOTE_GLOW_COLOR);
}

function clearDesktopRemoteRippleTimers() {
  for (const id of desktopRemoteRippleTimers) clearTimeout(id);
  desktopRemoteRippleTimers.length = 0;
}

function clearIOSRemoteRippleTimers() {
  for (const id of iosRemoteRippleTimers) clearTimeout(id);
  iosRemoteRippleTimers.length = 0;
}

function forceAllRemoteNavGlowOff() {
  setGlowTarget(okButtonMeshRef,    false, REMOTE_GLOW_COLOR);
  setGlowTarget(upArrowMeshRef,     false, REMOTE_GLOW_COLOR);
  setGlowTarget(downArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(leftArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(rightArrowMeshRef,  false, REMOTE_GLOW_COLOR);
}

function startDesktopRemoteOnPulse() {
  if (isIOSDevice()) return;
  if (!desktopRemotePulseArmed) return;

  if (!okButtonMeshRef && !upArrowMeshRef && !downArrowMeshRef && !leftArrowMeshRef && !rightArrowMeshRef) {
    return;
  }

  stopDesktopRemoteOnPulse();

  const onMs = 2000;
  const offMs = 3000;
  const cycleMs = onMs + offMs;
  const firstDelayMs = 250;

  const pulseAll = () => {
    if (!tvOn) return;
    if (!desktopRemotePulseArmed) return;

    clearDesktopRemoteRippleTimers();

    // center → outward ripple
    _setRemoteGlow(okButtonMeshRef, true, REMOTE_GLOW_COLOR);

    desktopRemoteRippleTimers.push(setTimeout(() => {
      if (!tvOn || !desktopRemotePulseArmed) return;
      _setRemoteGlow(upArrowMeshRef, true, REMOTE_GLOW_COLOR);
      _setRemoteGlow(downArrowMeshRef, true, REMOTE_GLOW_COLOR);
    }, 80));

    desktopRemoteRippleTimers.push(setTimeout(() => {
      if (!tvOn || !desktopRemotePulseArmed) return;
      _setRemoteGlow(leftArrowMeshRef, true, REMOTE_GLOW_COLOR);
      _setRemoteGlow(rightArrowMeshRef, true, REMOTE_GLOW_COLOR);
    }, 160));

    desktopRemoteRippleTimers.push(setTimeout(() => {
      if (!desktopRemotePulseArmed) return;

      _setRemoteGlow(okButtonMeshRef, false, REMOTE_GLOW_COLOR);
      _setRemoteGlow(upArrowMeshRef, false, REMOTE_GLOW_COLOR);
      _setRemoteGlow(downArrowMeshRef, false, REMOTE_GLOW_COLOR);
      _setRemoteGlow(leftArrowMeshRef, false, REMOTE_GLOW_COLOR);
      _setRemoteGlow(rightArrowMeshRef, false, REMOTE_GLOW_COLOR);
    }, onMs));

    desktopRemotePulseTimer = setTimeout(pulseAll, cycleMs);
  };

  desktopRemotePulseTimer = setTimeout(pulseAll, firstDelayMs);
}

function markDesktopRemoteUsed() {
  if (isIOSDevice()) return;
  if (!tvOn) return;

  desktopRemotePulseArmed = false;

  if (desktopRemotePulseTimer) {
    clearTimeout(desktopRemotePulseTimer);
    desktopRemotePulseTimer = null;
  }

  clearDesktopRemoteRippleTimers();
  stopDesktopRemoteOnPulse();

  _setRemoteGlow(okButtonMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(upArrowMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(downArrowMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(leftArrowMeshRef, false, REMOTE_GLOW_COLOR);
  _setRemoteGlow(rightArrowMeshRef, false, REMOTE_GLOW_COLOR);
}

function syncDesktopPulseWithTvState() {
  if (isIOSDevice()) return;

  if (!tvOn) {
    // reset only when TV turns OFF
    desktopRemotePulseArmed = true;
    stopDesktopRemoteOnPulse();
    startDesktopPowerPulse();
  } else {
    stopDesktopPowerPulse();

    if (desktopRemotePulseArmed) {
      startDesktopRemoteOnPulse();
    }
  }
}

// ✅ DEBUG: draw a dot where the TV screen was clicked (UV->pixel)
let tvTapDebug = { on: false, x: 0, y: 0, t: 0 };

// ============================================================
// POINTER -> NDC USING FIXED VIEWPORT (keeps raycast correct)
// ============================================================
function setPointerFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  if (!viewW || !viewH) return false;

  // mouse position in canvas pixels
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // viewport-local 0..1
  const vx = (cx - viewX) / viewW;
  const vy = (cy - viewY) / viewH;

  // clicked in the black bars -> ignore
  if (vx < 0 || vx > 1 || vy < 0 || vy > 1) return false;

  pointer.x = vx * 2 - 1;
  pointer.y = -(vy * 2 - 1);

  return true;
}

function hitIsPicture1(obj) {
  let o = obj;
  while (o) {
    const n  = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();
    const pn = (o.parent?.name || "").toLowerCase();

    // ✅ ONLY match Picture1 specifically (not generic "picture")
    if (n.includes("picture1") || mn.includes("picture1") || pn.includes("picture1")) {
      return true;
    }

    o = o.parent;
  }
  return false;
}

function hitIsDrawWall(obj) {
  let o = obj;
  while (o) {
    const n  = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();
    const pn = (o.parent?.name || "").toLowerCase();

    // replace these with your actual wall mesh / material / parent names
    if (
      n.includes("front_wall1") ||
      mn.includes("front wall") ||
      pn.includes("front_wall1") ||
      n.includes("drawwall") ||
      mn.includes("drawwall") ||
      pn.includes("drawwall")
    ) {
      return true;
    }

    o = o.parent;
  }
  return false;
}

async function onPointerDown(e) {
  if (isIOSPortraitBlocked()) return;
  if (isIOSDevice()) nudgeIosRemotePulse();

  if (!setPointerFromEvent(e)) return; // ✅ ignore clicks in black bars
  raycaster.setFromCamera(pointer, camera);

let hits = [];

if (interactivesRootRef) {
  hits = hits.concat(raycaster.intersectObject(interactivesRootRef, true));
}

hits = hits.concat(raycaster.intersectObject(anchor, true));

// ✅ choose the closest hit overall
hits.sort((a, b) => a.distance - b.distance);

if (!hits.length) return;

console.log("HITS:", hits.slice(0, 6).map(h => ({
  name: h.object.name,
  mat: h.object.material?.name,
  dist: h.distance.toFixed(3)
})));

if (overlayOpen || videoOverlayOpen || modelOverlayOpen) return;

// ✅ Pick the actual hit object once
const tvHitInfo =
  (tvScreenMeshRef && hits.length)
    ? hits.find(h => isInHierarchy(h.object, tvScreenMeshRef))
    : null;

const hitInfo = tvHitInfo ?? hits[0];
const hit = hitInfo.object;

// ✅ cigarette click (check ALL hits, not just closest)
const cigaretteHit = hits.find(h => cigaretteRoot && isInHierarchy(h.object, cigaretteRoot));
if (cigaretteHit) {
  console.log("🚬 cigarette hit:", cigaretteHit.object.name);
  playCigaretteAnimation();
  playSmokeTipAnimation();
  return;
}

// ✅ Picture1 click/tap (check ALL hits, not just closest)
const picHit = hits.find(h => hitIsPicture1(h.object));
if (picHit) {
  console.log("🖼 Picture1 hit:", picHit.object.name);
  setPicture1Texture(picture1TexIndex + 1);
  return;
}

console.log("POINTERDOWN HIT:", hit.name);

// ✅ iOS: only pulse the remote hint when you actually touched the remote,
// not when you touched the TV screen.
let hitIsTv = false;
if (tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) hitIsTv = true;

// (optional but recommended) also don't pulse if you hit the speaker (or other interactives)
let hitIsRemoteBtn = false;
if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) hitIsRemoteBtn = true;
if (upArrowMeshRef && isInHierarchy(hit, upArrowMeshRef)) hitIsRemoteBtn = true;
if (downArrowMeshRef && isInHierarchy(hit, downArrowMeshRef)) hitIsRemoteBtn = true;
if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) hitIsRemoteBtn = true;
if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) hitIsRemoteBtn = true;
if (powerButtonMeshRef && isInHierarchy(hit, powerButtonMeshRef)) hitIsRemoteBtn = true;

if (isIOSDevice() && hitIsRemoteBtn) {
  nudgeIosRemotePulse();
}

// ============================================================
// ✅ TV SCREEN HIT: handle TV FIRST and BLOCK remote glow/press
// (MUST be before any remote press/glow logic)
// ============================================================
if (tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) {
  // kill any “stuck” glow/press instantly
   // ✅ Only do the hard "clear everything" on TOUCH.
  // Desktop hover hints should stay responsive.
  if (e.pointerType === "touch") {
    clearAllButtonGlows();
    clearAllButtonPresses();
    setHoverKey(null);
  }

  // ✅ if you have a "remote pulse" timer/state, cancel it here too
// (only add this if you actually have these vars/functions)
if (typeof stopIosRemotePulse === "function") stopIosRemotePulse();

  // iOS swipe/tap tracking (only if you still want it)
  if (isIOSDevice()) {
    tvTouchActive = true;
    tvTouchStartedWhileOff = !tvOn;
    tvTouchPointerId = e.pointerId;

    tvTouchStartX = e.clientX;
    tvTouchStartY = e.clientY;
    tvTouchStartT = performance.now();

    try { renderer.domElement.setPointerCapture(e.pointerId); } catch {}
  }

  const uv = hitInfo?.uv;

  // ✅ TV interaction ONLY (no remote emission / press code allowed to run)
  if (uv) {
    handleIOSTvTap(uv);
  } else {
    // fallback if uv missing
    if (!tvOn) setTvPower(true);
  }

  return; // 🔒 CRITICAL: nothing below runs
}

  // ✅ only toggle lamp + night vision when lamp is clicked
if (hitIsLamp(hit)) {
  lampMood = (lampMood + 1) % 2; // 0<->1
  applyLampMood(lampMood);
  setNightVision(lampMood === 1);
  updateLampHintText();

      // ✅ show Grim only in lampMood 1, hide in lampMood 0
  setGrimVisible(lampMood === 1);

  return;
}

// ✅ Dunkeheit Album click -> open playlist (Safari-safe: open on pointerup)
if (hitIsDunkeheitAlbum(hit)) {
  const url = "https://open.spotify.com/playlist/29St0Hbsl7aWEyq7LBV4O6";
  console.log("💿 Dunkeheit_Album hit — queued for pointerup:", url);
  pendingExternalUrl = url;
  return;
}

// ✅ ALL DVD click -> open Gummo link (Safari-safe: open on pointerup)
if (hitIsAllDVD(hit)) {
  const url = "https://tapemotion.com/en/watch/18415?gummo=";
  console.log("📀 All_DVD hit — queued for pointerup:", url);
  pendingExternalUrl = url;
  return;
}

// ✅ DVD on Player 1 click -> open Decline of Western Civilization (Safari-safe: open on pointerup)
if (hitIsDVDOnPlayer1(hit)) {
  const url = "https://tapemotion.com/en/watch/21137?the-decline-of-western-civilization=";
  console.log("💿 DVD_on_Player1 hit — queued for pointerup:", url);
  pendingExternalUrl = url;
  return;
}

// ✅ Book4 click -> open book link (Safari-safe: open on pointerup)
if (hitIsBook4(hit)) {
  const url = "https://welib.org/md5/0516e985137dba6cae48c7e5a0eeb57d";
  console.log("📖 Book4 hit — queued for pointerup:", url);
  pendingExternalUrl = url;
  return;
}

function hitIsPicture1(obj) {
  let o = obj;
  while (o) {
    const n = (o.name || "").toLowerCase();
    const mn = (o.material?.name || "").toLowerCase();
    const pn = (o.parent?.name || "").toLowerCase();

    // ✅ match picture plane OR frame OR parent group
    if (
      n.includes("picture1") || mn.includes("picture1") || pn.includes("picture1") ||
      n.includes("picture") || mn.includes("picture")  || pn.includes("picture")
    ) return true;

    o = o.parent;
  }
  return false;
}

  log("🖱️ HIT:", hit.name, "layer:", hit.layers.mask, "parent:", hit.parent?.name);
log("💡 lampMeshRef:", lampMeshRef?.name, "layer:", lampMeshRef?.layers?.mask);


   // ✅ Press animation target ON (only for the button you clicked)
if (powerButtonMeshRef && isInHierarchy(hit, powerButtonMeshRef)) {
  setPressAxisFromHit(powerButtonMeshRef, hitInfo);
  setPressTarget(powerButtonMeshRef, true);
}

if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) {
  if (isIOSDevice() && e.pointerType === "touch") {
    iosSoloGlow(okButtonMeshRef);
    markIosRemoteUsed();
  }
  markDesktopRemoteUsed();
  setPressAxisFromHit(okButtonMeshRef, hitInfo);
  setPressTarget(okButtonMeshRef, true);
}

if (upArrowMeshRef && isInHierarchy(hit, upArrowMeshRef)) {
  if (isIOSDevice() && e.pointerType === "touch") {
    iosSoloGlow(upArrowMeshRef);
    markIosRemoteUsed();
  }
  markDesktopRemoteUsed();
  setPressAxisFromHit(upArrowMeshRef, hitInfo);
  setPressTarget(upArrowMeshRef, true);
}

if (downArrowMeshRef && isInHierarchy(hit, downArrowMeshRef)) {
  if (isIOSDevice() && e.pointerType === "touch") {
    iosSoloGlow(downArrowMeshRef);
    markIosRemoteUsed();
  }
  markDesktopRemoteUsed();
  setPressAxisFromHit(downArrowMeshRef, hitInfo);
  setPressTarget(downArrowMeshRef, true);
}

if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) {
  if (isIOSDevice() && e.pointerType === "touch") iosSoloGlow(leftArrowMeshRef);
    markDesktopRemoteUsed();
  setPressAxisFromHit(leftArrowMeshRef, hitInfo);
  setPressTarget(leftArrowMeshRef, true);
}

if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) {
  if (isIOSDevice() && e.pointerType === "touch") {
    iosSoloGlow(rightArrowMeshRef);
    markIosRemoteUsed();
  }
  markDesktopRemoteUsed();
  setPressAxisFromHit(rightArrowMeshRef, hitInfo);
  setPressTarget(rightArrowMeshRef, true);
}

// --------------------------------------------------
// TV POWER BUTTON
// --------------------------------------------------
if (powerButtonMeshRef && isInHierarchy(hit, powerButtonMeshRef)) {
  console.log("📺 TV Power pressed:", hit.name);

  const turningOn = !tvOn;

  setTvPower(turningOn);

  // ✅ iOS: show the MENU controls hint when turning ON via remote power button
  if (turningOn) {
    // optional: ensure it's only shown on iOS (your function already checks)
    showIosMenuControlsHintOnce();
  }

  return;
}

  // --------------------------------------------------
// REMOTE MENU BUTTONS (UP / DOWN / OK)
// --------------------------------------------------
if (tvOn && tvUiState === "MENU") {
  if (downArrowMeshRef && isInHierarchy(hit, downArrowMeshRef)) {
    console.log("⬇️ Down arrow pressed");
    moveMenuSelection(+1);
    return;
  }

  if (upArrowMeshRef && isInHierarchy(hit, upArrowMeshRef)) {
    console.log("⬆️ Up/Top arrow pressed");
    moveMenuSelection(-1);
    return;
  }

  if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) {
    console.log("🆗 OK pressed");
    confirmMenuSelection();
    return;
  }
}

// PHOTO MODE (LEFT / RIGHT to change photos)
// --------------------------------------------------
if (tvOn && tvUiState === "PHOTO") {
  if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) {
    console.log("➡️ Right arrow pressed → next photo");
    nextPhoto(+1);
    return;
  }

  if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) {
    console.log("⬅️ Left arrow pressed → previous photo");
    nextPhoto(-1);
    return;
  }
}

// VIDEO MODE (OK = play/pause, LEFT/RIGHT = prev/next)
// --------------------------------------------------
if (tvOn && tvUiState === "VIDEO") {
  if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) {
    console.log("🆗 OK pressed → toggle play/pause");
    toggleVideoPlayPause();
    drawVideoFrameToTv(); // ✅ refresh overlay text immediately
    return;
  }

  if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) {
    console.log("➡️ Right arrow pressed → next video");
    nextVideo(+1);
    return;
  }

  if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) {
    console.log("⬅️ Left arrow pressed → previous video");
    nextVideo(-1);
    return;
  }
}

// 3D MODEL MODE (OK = play/pause, LEFT/RIGHT = prev/next)
// --------------------------------------------------
if (tvOn && tvUiState === "3D MODEL") {
  if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) {
    console.log("🆗 OK pressed → toggle model play/pause");
    toggleModelPlayPause();
    drawModelFrameToTv(); // refresh paused overlay text immediately
    return;
  }

  if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) {
    console.log("➡️ Right arrow pressed → next 3D model mp4");
    nextModel(+1);
    return;
  }

  if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) {
    console.log("⬅️ Left arrow pressed → previous 3D model mp4");
    nextModel(-1);
    return;
  }
}

// --------------------------------------------------
// BLUETOOTH SPEAKER
// --------------------------------------------------
if (speakerMeshRef && isInHierarchy(hit, speakerMeshRef)) {
  const now = performance.now();
  const isDouble = now - lastClickTime < DOUBLE_CLICK_MS;
  lastClickTime = now;

  // 🔓 make sure audio is unlocked on the same user click
  await unlockAudioOnce();

  if (isDouble) {
    console.log("🔁 Speaker double click → next song");
    await nextTrack(true); // force play
  } else {
    console.log("▶️/⏸ Speaker click → play / pause");
    await togglePlayPause();
  }

  return;
}

}

// ============================================================
// ✅ POINTER UP (EDIT 2): detect swipe vs tap on TV screen (iOS)
// Paste this OUTSIDE onPointerDown, directly after it ends.
// ============================================================
async function onPointerUp(e) {
  if (!tvTouchActive) return;
  tvTouchActive = false;

  // ✅ If we just tapped the MENU button on iOS, ignore this pointerup
if (tvIgnoreNextPointerUp) {
  tvIgnoreNextPointerUp = false;
  return;
}


  try {
    if (tvTouchPointerId != null)
      renderer.domElement.releasePointerCapture(tvTouchPointerId);
  } catch {}
  tvTouchPointerId = null;

  // ignore if overlays are open
  if (overlayOpen || videoOverlayOpen || modelOverlayOpen) return;

  // only applies while TV is ON and in MENU
  if (!tvOn || tvUiState !== "MENU") return;

  const dx = e.clientX - tvTouchStartX;
  const dy = e.clientY - tvTouchStartY;

  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  const dtMs = performance.now() - tvTouchStartT;

  const isTap =
    adx <= TV_TAP_MAX_PX &&
    ady <= TV_TAP_MAX_PX;

  const isSwipe =
    dtMs <= TV_SWIPE_MAX_MS &&
    (adx >= TV_SWIPE_MIN_PX || ady >= TV_SWIPE_MIN_PX);

  // ✅ Swipe changes MENU selection
  if (isSwipe) {
    // pick dominant direction
    if (adx > ady) {
      // left/right swipe
      if (dx > 0) moveMenuSelection(+1);
      else        moveMenuSelection(-1);
    } else {
      // up/down swipe
      if (dy > 0) moveMenuSelection(+1);
      else        moveMenuSelection(-1);
    }
    return;
  }

// ✅ Tap confirms MENU selection
if (isTap) {
  // ✅ If this touch started when TV was OFF, ignore this first pointerup.
  // This prevents “tap to power on” from instantly entering PHOTO.
  if (tvTouchStartedWhileOff) {
    tvTouchStartedWhileOff = false;
    return;
  }

  confirmMenuSelection();
  return;
}

}

// ============================================================
// ✅ POINTER CANCEL SAFETY (EDIT 2)
// ============================================================
function onPointerCancel() {
  tvTouchActive = false;
}

const startBgOnce = async () => {
  await startBackgroundAudioFromUserGesture();
};

window.addEventListener("pointerdown", startBgOnce, { passive: true, once: true });
window.addEventListener("touchstart", startBgOnce, { passive: true, once: true });
window.addEventListener("mousedown", startBgOnce, { passive: true, once: true });
window.addEventListener("pointerenter", startBgOnce, { passive: true, once: true });

// ============================================================
// ✅ POINTER EVENTS (EDIT 2): hook down/up/cancel to canvas
// ============================================================
renderer.domElement.addEventListener("pointerdown", onPointerDown);
renderer.domElement.addEventListener("pointerup", onPointerUp);
renderer.domElement.addEventListener("pointerleave", onPointerCancel);
renderer.domElement.addEventListener("pointercancel", onPointerCancel);

startIosRemotePulse();

// ============================================================
// ✅ iOS: STOP MUSIC when user leaves Safari / tab goes inactive
// ============================================================
if (isIOSDevice()) {
  // 1) Tab/app goes background (most reliable)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMusicBecauseUserLeft();
  });

  // 2) Safari navigates away / app switcher / close tab
  window.addEventListener("pagehide", () => {
    stopMusicBecauseUserLeft();
  });

  // 3) Extra safety: when window loses focus
  window.addEventListener("blur", () => {
    stopMusicBecauseUserLeft();
  });
}

renderer.domElement.addEventListener("pointerup", () => {
  // ✅ If something was queued on pointerdown, open it now
  if (pendingExternalUrl) {
    const url = pendingExternalUrl;
    pendingExternalUrl = null;

    console.log("✅ pointerup — opening queued URL:", url);
    openExternal(url);

    clearAllButtonPresses();
    return;
  }

  clearAllButtonPresses();
}, { passive: true });

window.addEventListener("pointercancel", () => {
  clearAllButtonPresses();
});

// ============================================================
// HOVER DETECTION (TV fullscreen hint + Speaker play hint)
// ============================================================

renderer.domElement.addEventListener("pointermove", (e) => {
  if (isIOSPortraitBlocked()) return;
  if (overlayOpen || videoOverlayOpen || modelOverlayOpen) {
    setHoverKey(null);
    clearAllButtonGlows();
    clearAllButtonPresses();
    return;
  }


  if (!setPointerFromEvent(e)) {
    setHoverKey(null);
    clearAllButtonGlows();
    clearAllButtonPresses();
    return;
  }

  raycaster.setFromCamera(pointer, camera);

  let hits = [];
if (interactivesRootRef) {
  hits = raycaster.intersectObject(interactivesRootRef, true);
}
if (!hits.length) {
  hits = raycaster.intersectObject(anchor, true);
}
if (!hits.length) {
  setHoverKey(null);
  clearAllButtonGlows();
  clearAllButtonPresses();
  return;
}

// ✅ Picture1 hover must check ALL hits (frame/glass may be closer)
const picHoverHit = hits.find(h => hitIsPicture1(h.object));
const hoveringPicture1AllHits = !!picHoverHit;

// ✅ Prefer TV hit for hover too (prevents remote glow while over TV)
const tvHoverHit =
  (tvScreenMeshRef && hits.length)
    ? hits.find(h => isInHierarchy(h.object, tvScreenMeshRef))
    : null;

const hit = (tvHoverHit ?? hits[0]).object;

// ============================================================
// ✅ DESKTOP: hover over MENU rows to change selection (flawless)
// Only runs for mouse, only while tvUiState === "MENU"
// Uses the TV hit UV (NOT hits[0]) and locks V flip once detected.
// ============================================================
if (
  tvOn &&
  tvUiState === "MENU" &&
  e.pointerType === "mouse" &&
  tvScreenMeshRef &&
  tvHoverHit &&                      // ✅ must be hovering the TV mesh
  tvHoverHit.uv                      // ✅ must have uv
) {
  const uv = tvHoverHit.uv;          // ✅ IMPORTANT: use TV hit uv, not hits[0].uv

  const w = tvCanvas.width;
  const h = tvCanvas.height;

  // match mapping rules (repeat/offset + normalize)
  let u = uv.x * (tvTex.repeat?.x ?? 1) + (tvTex.offset?.x ?? 0);
  let v = uv.y * (tvTex.repeat?.y ?? 1) + (tvTex.offset?.y ?? 0);

  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;

  // two possible vertical interpretations
  const pyA = v * h;
  const pyB = (1 - v) * h;

  // these must match drawTvMenu()
  const startY = h * 0.35;
  const gapY = 130;
  const n = MENU_ITEMS.length;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // candidate index for both py versions
  const idxA = clamp(Math.round((pyA - startY) / gapY), 0, n - 1);
  const idxB = clamp(Math.round((pyB - startY) / gapY), 0, n - 1);

  // distance to nearest row center (so we pick correct orientation)
  const centerA = startY + idxA * gapY;
  const centerB = startY + idxB * gapY;

  const distA = Math.abs(pyA - centerA);
  const distB = Math.abs(pyB - centerB);

  const py = tvMenuHoverFlipV ? pyB : pyA;
  const idx = clamp(Math.round((py - startY) / gapY), 0, n - 1);

  if (idx !== menuIndex) {
    menuIndex = idx;
    blinkT0 = performance.now();
    drawTvMenu();
  }
}

const hoveringTvScreen = !!(tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef));

let hoveringTv = false;
let hoveringSpeaker = false;
let hoveringPower = false;
let hoveringCigarette = false;
let hoveringOk = false;
let hoveringUp = false;
let hoveringDown = false;
let hoveringLeft = false;
let hoveringRight = false;
let hoveringLamp = false;
let hoveringAllDvd = false;
let hoveringDvdPlayer1 = false;
let hoveringBook4 = false;
let hoveringDogTag1 = false;
let hoveringDunkeheitAlbum = false;
let hoveringBoard2 = false;
let hoveringDoor4 = false;
let hoveringPicture1 = false;
let hoveringWall = false; 

  if (hitIsLamp(hit)) hoveringLamp = true;
  if (hitIsAllDVD(hit)) hoveringAllDvd = true;
  if (hitIsDVDOnPlayer1(hit)) hoveringDvdPlayer1 = true;
  if (hitIsBook4(hit)) hoveringBook4 = true;
  if (hitIsDunkeheitAlbum(hit)) hoveringDunkeheitAlbum = true;
  if (hitIsDoor4(hit)) hoveringDoor4 = true;
  if (hoveringPicture1AllHits) hoveringPicture1 = true;
  if (hitIsDrawWall(hit)) hoveringWall = true;

  // ✅ CRITICAL: TV hover must not allow remote glow at all
if (hoveringTvScreen) {
  hoveringPower = false;
  hoveringOk = false;
  hoveringUp = false;
  hoveringDown = false;
  hoveringLeft = false;
  hoveringRight = false;

  // optional: hard kill glows instantly
  clearAllButtonGlows();
  clearAllButtonPresses();
}

if (tvOn && (tvUiState === "PHOTO" || tvUiState === "VIDEO" || tvUiState === "3D MODEL") && tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) {
  hoveringTv = true;
}

 // ---------------------------------------------
// MENU hover detection (robust)
// ---------------------------------------------
const prevMenuHover = menuHover;
menuHover = false;

if (
  tvOn &&
  (tvUiState === "PHOTO" || tvUiState === "VIDEO" || tvUiState === "3D MODEL") &&
  tvScreenMeshRef &&
isInHierarchy(hit, tvScreenMeshRef) &&
(tvHoverHit ?? hits[0]).uv
) {
  const uv = (tvHoverHit ?? hits[0]).uv;

  const w = tvCanvas.width;
  const h = tvCanvas.height;

  // match the same mapping rules as click logic (repeat/offset + normalize)
  let u = uv.x * (tvTex.repeat?.x ?? 1) + (tvTex.offset?.x ?? 0);
  let v = uv.y * (tvTex.repeat?.y ?? 1) + (tvTex.offset?.y ?? 0);

  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;

  const px = u * w;

  // ✅ check both vertical interpretations
  const pyA = v * h;
  const pyB = (1 - v) * h;

const BTN = getTvMenuBtn();   // ✅ ADD THIS

const bx = w - BTN.pad - BTN.w;
const by = BTN.pad;

const inBtnA = px >= bx && px <= bx + BTN.w && pyA >= by && pyA <= by + BTN.h;
const inBtnB = px >= bx && px <= bx + BTN.w && pyB >= by && pyB <= by + BTN.h;

  menuHover = (inBtnA || inBtnB);
}

// ✅ PHOTO + 3D-image do not redraw every frame, so force redraw when hover changes
if (menuHover !== prevMenuHover) {
  if (tvOn && tvUiState === "PHOTO" && photoImage) {
    drawPhotoToTv(photoImage);
  } else if (tvOn && tvUiState === "3D MODEL" && modelMediaType === "image" && modelImageEl && modelReady) {
    drawPhotoToTv(modelImageEl);
  }
  // VIDEO + 3D video redraw continuously, so no need here
}

  // Speaker hint (anytime speaker exists)
  if (speakerMeshRef && isInHierarchy(hit, speakerMeshRef)) {
    hoveringSpeaker = true;
  }

  // Cigarette hover hint
if (cigaretteRoot && isInHierarchy(hit, cigaretteRoot)) {
  hoveringCigarette = true;
}

    // Power hint (anytime power button exists)
  if (powerButtonMeshRef && isInHierarchy(hit, powerButtonMeshRef)) {
    hoveringPower = true;
  }

    // Remote button hints (only when TV is ON)
  if (tvOn) {
    if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) hoveringOk = true;
    if (upArrowMeshRef && isInHierarchy(hit, upArrowMeshRef)) hoveringUp = true;
    if (downArrowMeshRef && isInHierarchy(hit, downArrowMeshRef)) hoveringDown = true;
    if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) hoveringLeft = true;
    if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) hoveringRight = true;
  }

  // ------------------------------------------------------------
  // ✅ NEW: Decide ONE hover key (priority order), then auto-hide it
  // ------------------------------------------------------------
  let nextKey = null;

  if (hoveringCigarette) nextKey = "smoke";
  if (hoveringSpeaker) nextKey = "speaker";
  else if (hoveringPower) nextKey = "power";
  else if (hoveringLamp) nextKey = "lamp";
  else if (hoveringAllDvd) nextKey = "alldvd";
  else if (hoveringDvdPlayer1) nextKey = "dvdplayer1";
  else if (hoveringBook4) nextKey = "book4";
  else if (hoveringDunkeheitAlbum) nextKey = "dogtag1";
  else if (hoveringDoor4) nextKey = "door4";
  else if (hoveringPicture1) nextKey = "picture1";
  else if (hoveringWall) nextKey = "wall";
  else if (hoveringOk) nextKey = "ok";
  else if (hoveringUp) nextKey = "up";
  else if (hoveringDown) nextKey = "down";
  else if (hoveringLeft) nextKey = "left";
  else if (hoveringRight) nextKey = "right";
  else if (hoveringTv) nextKey = "tv";

    // ------------------------------------------------------------
  // ✅ HOVER GLOW targets (does not affect your hint logic)
  // ------------------------------------------------------------
  setGlowTarget(powerButtonMeshRef, hoveringPower, POWER_GLOW_COLOR);

  setGlowTarget(okButtonMeshRef,    hoveringOk,   REMOTE_GLOW_COLOR);
  setGlowTarget(upArrowMeshRef,     hoveringUp,   REMOTE_GLOW_COLOR);
  setGlowTarget(downArrowMeshRef,   hoveringDown, REMOTE_GLOW_COLOR);
  setGlowTarget(leftArrowMeshRef,   hoveringLeft, REMOTE_GLOW_COLOR);
  setGlowTarget(rightArrowMeshRef,  hoveringRight,REMOTE_GLOW_COLOR);

  setHoverKey(nextKey);
});

// ✅ if cursor leaves the canvas, clear hover + force all glows off
renderer.domElement.addEventListener("pointerleave", () => {

clearAllButtonPresses();

  setHoverKey(null);

  setGlowTarget(powerButtonMeshRef, false, POWER_GLOW_COLOR);
  setGlowTarget(okButtonMeshRef,    false, REMOTE_GLOW_COLOR);
  setGlowTarget(upArrowMeshRef,     false, REMOTE_GLOW_COLOR);
  setGlowTarget(downArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(leftArrowMeshRef,   false, REMOTE_GLOW_COLOR);
  setGlowTarget(rightArrowMeshRef,  false, REMOTE_GLOW_COLOR);
});

    
function setupNightLights(maxDim) {
  // --- main warm lamp key (rect area) ---
  const lampKey = new THREE.RectAreaLight(
  0xffffff, // temporary
  18,
  maxDim * 0.12,
  maxDim * 0.18
);

// 🔧 Desaturate lamp color 15%
lampKey.color.setHex(0xffe2c6);
lampKey.color.offsetHSL(0, -0.15, 0);

  lampKey.position.set(maxDim * 0.30, maxDim * 0.02, maxDim * 0.18);
  lampKey.lookAt(maxDim * 0.05, maxDim * -0.10, 0);
  scene.add(lampKey);

  // --- shadow caster (warm spotlight) ---
  const lampShadow = new THREE.SpotLight(0xffe2c6, 75);
  lampShadow.position.copy(lampKey.position);
  lampShadow.target.position.set(maxDim * 0.05, maxDim * -0.12, 0);

  lampShadow.angle = Math.PI / 5.5;
  lampShadow.penumbra = 0.95;
  lampShadow.decay = 2;
  lampShadow.distance = maxDim *0.9;

  lampShadow.castShadow = true;
  lampShadow.shadow.mapSize.set(isIOS ? 2048 : 4096, isIOS ? 2048 : 4096);
  lampShadow.shadow.radius = 6;
  lampShadow.shadow.bias = -0.00004;
  lampShadow.shadow.normalBias = 0.02;

  scene.add(lampShadow);
  scene.add(lampShadow.target);

  // --- RIGHT SIDE PUSH (general warm push) ---
  const rightPush = new THREE.SpotLight(
    0xffc07a,
    160,
    maxDim * 4.0,
    Math.PI / 9,
    0.95,
    2
  );

// NEW: keep rightPush tight so it doesn't wash the whole room
rightPush.intensity = 80;
rightPush.distance = maxDim * 1.2;
rightPush.angle = Math.PI / 14;
rightPush.penumbra = 0.8;


  rightPush.castShadow = true;
  rightPush.shadow.bias = -0.00003;
  rightPush.shadow.normalBias = 0.02;
  rightPush.position.set(maxDim * 0.55, maxDim * 0.25, maxDim * 0.30);
  rightPush.target.position.set(maxDim * 0.10, maxDim * -0.10, 0);
  scene.add(rightPush);
  scene.add(rightPush.target);

 const pinRight = new THREE.PointLight(0xffd2a1, 2500, maxDim * 1.2, 2);
pinRight.position.set(maxDim * 0.60, maxDim * 0.18, maxDim * 0.35);
pinRight.castShadow = false;

// NEW: make pin light affect ONLY objects on LAYER_PIN
pinRight.layers.set(LAYER_PIN);

scene.add(pinRight);

  // --- TV/cool fill (Layer 2 only) ---
  const tvFill = new THREE.RectAreaLight(
    0xd9ecff,
    0.55,
    maxDim * 0.28,
    maxDim * 0.18
  );
  tvFill.position.set(maxDim * -0.02, maxDim * -0.03, maxDim * 0.16);
  tvFill.lookAt(0, maxDim * -0.10, 0);
  tvFill.layers.set(LAYER_ACCENT);
  scene.add(tvFill);

  // --- remote boost (Layer 2 only) ---
  const remoteBoost = new THREE.SpotLight(0xfff1df, 45);
  remoteBoost.angle = Math.PI / 10;
  remoteBoost.penumbra = 1.0;
  remoteBoost.decay = 2;
  remoteBoost.distance = maxDim * 3.0; // IMPORTANT: more reach
  remoteBoost.castShadow = false;
  remoteBoost.layers.set(LAYER_ACCENT);
  scene.add(remoteBoost);
  scene.add(remoteBoost.target);

  // --- skateboard accent (Layer 2 only) ---
  const skateAccent = new THREE.SpotLight(0xffe6c6, 140);
  skateAccent.angle = Math.PI / 7;
  skateAccent.penumbra = 1.0;
  skateAccent.decay = 2;
  skateAccent.distance = maxDim * 4.0; // IMPORTANT: more reach
  skateAccent.castShadow = false;
  skateAccent.layers.set(LAYER_ACCENT);
  scene.add(skateAccent);
  scene.add(skateAccent.target);

  const underShelfUp = new THREE.SpotLight(0xffd6a1, 350);

  underShelfUp.angle = Math.PI / 7;
  underShelfUp.penumbra = 0.8;
  underShelfUp.decay = 2;
  underShelfUp.distance = maxDim * 1.2;

  underShelfUp.castShadow = true;
  underShelfUp.shadow.mapSize.set(isIOS ? 1024 : 2048, isIOS ? 1024 : 2048);
  underShelfUp.shadow.bias = -0.00003;
  underShelfUp.shadow.normalBias = 0.02;

  scene.add(underShelfUp);
  scene.add(underShelfUp.target);

  // ============================================================
// ✅ SHELF CAVITY FILL (adds depth separation)
// ============================================================
const shelfFill = new THREE.RectAreaLight(
  0xd9ecff,     // cool bounce
  0.35,         // intensity (small!)
  maxDim * 0.55,
  maxDim * 0.22
);

// place it inside/near the shelf cavity, aimed outward
shelfFill.position.set(maxDim * -0.06, maxDim * 0.10, maxDim * 0.10);
shelfFill.lookAt(maxDim * -0.02, maxDim * 0.06, maxDim * -0.10);

// ✅ only affect your accent layer so it doesn't wash walls
shelfFill.layers.set(LAYER_ACCENT);
scene.add(shelfFill);

  return { lampKey, lampShadow, rightPush, pinRight, tvFill, remoteBoost, skateAccent, underShelfUp, shelfFill };
}

// ============================================================
// ✅ TV MENU INDEX + iOS GESTURE HELPERS
// ============================================================
const TV_TABS = ["PHOTO", "VIDEO", "3D MODEL"];
let tvMenuIndex = 0; // 0=PHOTO,1=VIDEO,2=3D MODEL

function setTvMenuIndex(i) {
  const n = TV_TABS.length;
  tvMenuIndex = ((i % n) + n) % n;
  // redraw highlight immediately if menu is showing
  if (tvOn && tvUiState === "MENU") drawTvMenu();
}

function enterCurrentTvTab() {
  const next = TV_TABS[tvMenuIndex];
  tvUiState = next;

  // kick off lazy loads using your existing logic
  if (tvUiState === "PHOTO") {
    if (!photoImage && !photoLoading) loadPhotoAt(photoIndex);
  }
  // VIDEO + 3D MODEL already handled in your animate redraw logic
}

function turnOnTvToMenu() {
  tvOn = true;
  tvUiState = "MENU";
  drawTvMenu();
}

// ============================================================
// TEXTURE + MATERIALS
// ============================================================
const tl = new THREE.TextureLoader();
const texCache = new Map();
const maxAniso =
  MOBILE_PROFILE.maxAniso ?? (renderer.capabilities.getMaxAnisotropy?.() ?? 1);

function loadTexture(path, { srgb = false } = {}) {
  const key = `${path}__${srgb ? "srgb" : "lin"}`;
  if (texCache.has(key)) return texCache.get(key);

  const __endTex = __beginAsset(path);

const t = tl.load(
  path,
  () => __endTex(),
  undefined,
  () => __endTex()
);

  t.flipY = false;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;

  t.anisotropy = maxAniso;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;

  texCache.set(key, t);
  return t;
}

function loadSRGB(path) {
  return loadTexture(path, { srgb: true });
}
function loadLinear(path) {
  return loadTexture(path, { srgb: false });
}

function makePBR({ albedo, normal, roughness, metalness, ao }, opts = {}) {
  return new THREE.MeshStandardMaterial({
    map: albedo ? loadSRGB(albedo) : null,
    normalMap: normal ? loadLinear(normal) : null,
    roughnessMap: roughness ? loadLinear(roughness) : null,
    metalnessMap: metalness ? loadLinear(metalness) : null,
    aoMap: ao ? loadLinear(ao) : null,
    roughness: opts.roughness ?? 1.0,
    metalness: opts.metalness ?? 0.0,
    side: THREE.DoubleSide,
  });
}

// ✅ ADD THIS DIRECTLY UNDER makePBR()
function makeTransparentPBR({ albedo, normal }, opts = {}) {
  const alphaTex = albedo ? loadLinear(albedo) : null; // use PNG alpha

  return new THREE.MeshStandardMaterial({
    map: albedo ? loadSRGB(albedo) : null,
    normalMap: normal ? loadLinear(normal) : null,

    transparent: true,        // ✅ REQUIRED
    alphaMap: alphaTex,       // ✅ READS alpha from your PNG
    opacity: opts.opacity ?? 1.0,
    depthWrite: false,        // ✅ helps transparency sort issues

    roughness: opts.roughness ?? 0.05,
    metalness: opts.metalness ?? 0.0,
    side: THREE.DoubleSide,
  });
}


function darkenMaterial(
  mat,
  { env = 0.0, rough = 1.0, colorMul = 0.85 } = {}
) {
  if (!mat) return mat;

  if ("envMapIntensity" in mat) mat.envMapIntensity = env;
  if ("roughness" in mat) mat.roughness = Math.min(mat.roughness ?? 1.0, rough);
  if (mat.color) mat.color.multiplyScalar(colorMul);

  mat.needsUpdate = true;
  return mat;
}

const fallbackMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.8,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

// 3 example materials (replace mesh names + paths with yours)
const materials = {

  cabnet: makePBR(
    {
      albedo: "./assets/Textures/Main Cabnet/Main Cabnet Albeto copy.jpg",
      normal: "./assets/Textures/Main Cabnet/Main Cabnet Normal.jpg",
      //roughness: "./assets/Textures/Main Cabnet/Main Cabnet Roughness.jpg",
      //metalness: "./assets/Textures/Main Cabnet/Main Cabnet Metallic.jpg",
      ao:"./assets/Textures/Main Cabnet/Main Cabnet AO.jpg",
    },
    { roughness: 0.85, metalness: 0.0 }
  ),

  //MAIN OBJECTS
  pasted__remote: makePBR({
    albedo: "./assets/Textures/Remote/Main object/Remote Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.2}
),

 TV_Box2: makePBR({
    albedo: "./assets/Textures/TV Box/TV Box Albeto.jpg",
    },
    { roughness: 0.5, metalness: 0.0}
),

TV_stand: makePBR({
    albedo: "./assets/Textures/TV Stand/TV Stand Albeto.jpg",
    ao: "./assets/Textures/TV Stand/TV Stand AO.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

    //ALL DVD's

    All_DVD: makePBR(
    {
      albedo: "./assets/Textures/DVD's/All DVD albeto.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

    DVD_on_Player1: makePBR(
    {
      albedo: "./assets/Textures/DVD's/Dec of West/DVD5 Albeto.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

    DVD_on_Player2: makePBR(
    {
      albedo: "./assets/Textures/DVD's/DVD 22 Akira/DVD22 Albeto.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

//Cigarettes

 Cig2: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig2 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig3: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig3 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig4: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig4 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig5: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig5 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig6: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig6 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig7: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig7 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig8: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig8 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig9: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig9 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig10: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig10 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig11: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig11 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig12: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig12 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig13: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig13 Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

    //WALLS & Door
  front_wall1: makePBR(
    {
      albedo: "./assets/Textures/Walls/Front Wall/Front Wall10 Albedo.jpg",
    },
    { metalness: 0.0, roughness: 2.0 }
  ),

  Left_wall1: makePBR(
    {
      albedo: "./assets/Textures/Walls/Left Wall/Left Wall Albeto.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Floor1: makePBR(
    {
      albedo: "./assets/Textures/Floor/Floor Albedo2.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

Door4: (() => {
  const m = makePBR(
    {
      albedo: "./assets/Textures/new door/New Door Albedo1.jpg",
      normal: "./assets/Textures/new door/New Door Normal1.jpg",
    },
    { roughness: 1.0, metalness: 0.0 }
  );

  m.color.setHex(0xeee6d6);
  m.color.multiplyScalar(1.03);
  m.color.b *= 1.4;

  return m;
})(),


    //DECORATIVE ELEMENTS
  Cardboard_Box: makePBR(
    {
      albedo: "./assets/Textures/Cardboard Box/Cardboard Box Albeto.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Mask1: makePBR(
    {
      albedo: "./assets/Textures/Mask/Mask Albeto1.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

  Book4: makePBR(
    {
      albedo: "./assets/Textures/Books/Book2 Albeto1.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

  Book3: makePBR(
    {
      albedo: "./assets/Textures/Books/Book1 Albeto1.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

 AXE3: makePBR({
    albedo: "./assets/Textures/AXE/AXE Albeto2.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Digi_Cam2: makePBR({
    albedo: "./assets/Textures/Digi Cam/Digi Cam Albeto1.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Dunkeheit_Album: (() => {
  const m = makePBR(
    {
      albedo: "./assets/Textures/Album/Album Albedo2.jpg",
    },
    { roughness: -0.2, metalness: 0.2 }
  );

  // ✅ brighten the texture slightly
  m.color.multiplyScalar(0.7);

  // ✅ subtle self-light so it reads even in dark areas
  m.emissive = new THREE.Color(0xffffff);
  m.emissiveIntensity = 0.0102;

  // ✅ reduce harsh reflections from lamp
  if ("envMapIntensity" in m) m.envMapIntensity = 0.04;

  return m;
})(),

 Sony_Handicam1: makePBR({
    albedo: "./assets/Textures/Sony Handicam/Sony Handicam Albeto2.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Thailand_Box1: makePBR({
    albedo: "./assets/Textures/Thailand Box/Thailand Box Albeto2.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Headphones1: makePBR({
    albedo: "./assets/Textures/Headphones/Headphones Albeto.jpg",
    },
    { roughness: 0.5, metalness: 0.0}
),

 Tank1: makePBR({
    albedo: "./assets/Textures/Tank/Tank Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

 cloth: makePBR({
    albedo: "./assets/Textures/Cloth/Cloth Albeto copy.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 DvD_player: makePBR({
    albedo: "./assets/Textures/DVD Player/DVD Player Albeto.jpg",
    },
    { roughness: 0.5, metalness: 0.0}
),

 Dusty_Beer_2: makePBR({
    albedo: "./assets/Textures/Dusty Beer Bottle/Dusty Beer Bottle Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

Dusty_Beer_1: makePBR({
    albedo: "./assets/Textures/Dusty Beer Bottle/Dusty Beer Bottle Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

power_box: makePBR({
    albedo: "./assets/Textures/Power Box/Power Box Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

Power_Box_Cables: makePBR({
    albedo: "./assets/Textures/Power Box/Power Box Cable Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

ash_tray: makePBR({
    albedo: "./assets/Textures/Ash Tray/Ash Tray Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.5}
),

Glass_Cup3: makeTransparentPBR({
    albedo: "./assets/Textures/Glass/Glass Cup Albedo.png",
    },
    { roughness: 0.0, metalness: 0.0, opacity: 0.1,}
),

Glass_Cup4: makeTransparentPBR({
    albedo: "./assets/Textures/Glass/Glass Cup Albedo.png",
    },
    { roughness: 0.0, metalness: 0.0, opacity: 0.1,}
),

Cabnet_Laches: makePBR({
    albedo: "./assets/Textures/Cabnet Laches/Cabnet Laches Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

Dog_Tag1: makePBR({
    albedo: "./assets/Textures/Dog Tag Necklace/Dog Tag Albeto1.jpg",
    },
    { roughness: 0.2, metalness: 0.0}
),

Washer: makePBR({
    albedo: "./assets/Textures/Dog Tag Necklace/Washer Albeto1.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

Chain: makePBR({
    albedo: "./assets/Textures/Dog Tag Necklace/Chain Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.01}
),

All_Cartridges: makePBR({
    albedo: "./assets/Textures/Cartridges/Cartridges Albedo.jpg",
    },
    { roughness: 0.8, metalness: 0.0}
),

Bed1: makePBR({
    albedo: "./assets/Textures/Bed/Bed Albedo.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Frame: makePBR({
    albedo: "./assets/Textures/Frame/Frame Albedo1.jpg",
 
    },
    { roughness: 1.0, metalness: 0.5}
),

 Bug_1: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_2: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_3: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_4: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_5: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_6: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_7: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Bug_8: makePBR(
    {
      albedo: "./assets/Textures/Bugs/Bugs Albedo.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

cabnet_hinge3: (() => {

  // 1️⃣ Create the material
  const m = makePBR(
    {
      albedo: "./assets/Textures/Hinge/Hinge Albeto1.jpg",
    },
    { roughness: 0.9, metalness: 0.2}
  );

  // 2️⃣ DARKEN IT HERE 👇 (THIS is where multiplyScalar goes)
  m.color.multiplyScalar(0.37);

  // 3️⃣ Optional: subtle reflection
  m.envMapIntensity = 0.10;

  // 4️⃣ Return finished material
  return m;

})(),

cabnet_hinge4: (() => {

  // 1️⃣ Create the material
  const m = makePBR(
    {
      albedo: "./assets/Textures/Hinge/Hinge Albeto1.jpg",
    },
    { roughness: 0.9, metalness: 0.2 }
  );

  // 2️⃣ DARKEN IT HERE 👇 (THIS is where multiplyScalar goes)
  m.color.multiplyScalar(0.37);

  // 3️⃣ Optional: subtle reflection
  m.envMapIntensity = 0.10;

  // 4️⃣ Return finished material
  return m;

})(),

cabnet_hinge5: (() => {

  // 1️⃣ Create the material
  const m = makePBR(
    {
      albedo: "./assets/Textures/Hinge/Hinge Albeto1.jpg",
    },
    { roughness: 0.9, metalness: 0.2 }
  );

  // 2️⃣ DARKEN IT HERE 👇 (THIS is where multiplyScalar goes)
  m.color.multiplyScalar(0.2);

  // 3️⃣ Optional: subtle reflection
  m.envMapIntensity = 0.05;

  // 4️⃣ Return finished material
  return m;

})(),


Green_Beer_Bottle1: makePBR({
    albedo: "./assets/Textures/Green Bottle/Green bottle Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

White_VCR_Cable: makePBR({
    albedo: "./assets/Textures/VCR Cords/White VCR Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Red_VCR_Cable: makePBR({
    albedo: "./assets/Textures/VCR Cords/Red VCR Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Yellow_VCR_Cable: makePBR({
    albedo: "./assets/Textures/VCR Cords/Yellow VCR Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Black_VCR_Cable: makePBR({
    albedo: "./assets/Textures/VCR Cords/Black VCR Cable Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Blade: makePBR({
    albedo: "./assets/Textures/Knife/Knife Albeto1.jpg",
    },
    { roughness: 0.3, metalness: 0.1}
),

Handle: makePBR({
    albedo: "./assets/Textures/Knife/Knife Handle Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Board2: makePBR({
    albedo: "./assets/Textures/Skateboard/Board Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.2}
),

Grinding_Treck2: makePBR({
    albedo: "./assets/Textures/Skateboard/Treck Grinder Albeto2.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Grinding_Teck1: makePBR({
    albedo: "./assets/Textures/Skateboard/Treck Grinder Albeto2.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Right_Wheel2: makePBR({
    albedo: "./assets/Textures/Skateboard/Right Wheel Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Right_Wheel1: makePBR({
    albedo: "./assets/Textures/Skateboard/Right Wheel Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Left_Wheel: makePBR({
    albedo: "./assets/Textures/Skateboard/Left Wheel Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Left_Wheel1: makePBR({
    albedo: "./assets/Textures/Skateboard/Left Wheel Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Top_of_Treck: makePBR({
    albedo: "./assets/Textures/Skateboard/Top of Treck Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Top_of_Treck1: makePBR({
    albedo: "./assets/Textures/Skateboard/Top of Treck Albeto1.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Picture1: (() => {
  const m = makePBR(
    { albedo: "./assets/Textures/Picture/01_Picture1.jpg" },
    { roughness: 0.95, metalness: 0.0 }
  );

  // ✅ stop reflections from washing it out / killing contrast
  m.envMapIntensity = 0.0;

  // ✅ bring “life” back without making it neon
  m.emissive = new THREE.Color(0xffffff);
  m.emissiveIntensity = 0.07; // 🔥 tweak 0.15–0.35

  return m;
})(),

Picture_Frame: makePBR({
    albedo: "./assets/Textures/Picture/Picture Frame Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

Lamp1: (() => {
  const m = makePBR(
    { albedo: "./assets/Textures/Lamp/Lamp Albeto.jpg" },
    { roughness: 1.0, metalness: 0.0 }
  );

  // emission glow BUT texture stays visible
  m.emissive = new THREE.Color(0xffb45a);      // warm glow color
  m.emissiveIntensity = 2.0;                  // keep low so texture still shows
  m.emissive.offsetHSL(0, -0.07, 0);
  m.emissiveMap = m.map;                       // uses the lamp texture as the glow pattern
  m.toneMapped = true;
  return m;
})(),


Treck_Screw4: makePBR({
    albedo: "./assets/Textures/Skateboard/Treck screw.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

Shoelase: makePBR({
    albedo: "./assets/Textures/Shoelace/Shoelace Albeto.jpg",
    },
    { roughness: 0.2, metalness: 0.0}
),

//INTERACTIVE MATERIALS

BluetoothSpeaker: makePBR(
{
      albedo: "./assets/Textures/Speaker/Speaker Albeto.jpg",
    },
    { roughness: 0.3, metalness: 0.0 }
  ),

  Left_Button_Remote: makePBR(
{
      albedo: "./assets/Textures/Remote/Left Arrow Button/Left Arrow Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

 Ok_Button_Remote2: makePBR(
{
      albedo: "./assets/Textures/Remote/Ok Button/Ok Button Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

   Right_Button_Remote: makePBR(
{
      albedo: "./assets/Textures/Remote/Right Button/Right Arrow Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

  Power_Button_Remote: makePBR(
{
      albedo: "./assets/Textures/Remote/Power Button/Power Button Albeto1.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

     Down_Arrow_Button: makePBR(
{
      albedo: "./assets/Textures/Remote/Down Arrow Button/Down Arrow Button Albedo.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

    Top_Arrow_Button: makePBR(
{
      albedo: "./assets/Textures/Remote/Top Arrow Button/Top Arrow Button Albedo.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

   TV_Screen: makePBR(
{
      albedo: "./assets/Textures/TV Screen/TV Screen Albeto.jpg",
      normal: "./assets/Textures/TV Screen/TV Screen Normal.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),

     Food_Bowl: makePBR(
{
      albedo: "./assets/Textures/Food/Food albedo1.jpg",
    },
    { roughness: 0.2, metalness: 0.0 }
  ),
  
     Foot: makePBR(
{
      albedo: "./assets/Textures/Foot/Foot albedo.jpg",
    },
    { roughness: 0.9, metalness: 0.0 }
  ),

       Toe_Nail: makePBR(
{
      albedo: "./assets/Textures/Foot/Toe albedo.jpg",
    },
    { roughness: 0.3, metalness: 0.0 }
  ),
  
       Garbage_Bag: makePBR(
{
      albedo: "./assets/Textures/Garbage/Garbage albedo1.jpg",
    },
    { roughness: 0.0, metalness: 0.0 }
  ),
  
       Grim_reaper: makePBR(
{
      albedo: "./assets/Textures/Angel/Angel albedo",
      normal: "./assets/Textures/Angel/Angel Normal.jpg",
    },
    { roughness: 0.5, metalness: 0.0 }
  ),
  
       Rag1: makePBR(
{
      albedo: "./assets/Textures/Rag/Dirty Rag Albedo2.jpg",
    },
    { roughness: 0.3, metalness: 0.0 }
  ),

       Underwear2: makePBR(
{
      albedo: "./assets/Textures/Underwear/Underwear2.jpg",
    },
    { roughness: 0.2, metalness: 0.0 }
  ),

};

const cigaretteFilterMat = makePBR(
  {
    albedo: "./assets/Textures/New Cigarette Folder/Cig Filter Albeto.jpg",
  },
  { roughness: 1.0, metalness: 0.0 }
);

const cigaretteTobaccoMat = makePBR(
  {
    albedo: "./assets/Textures/New Cigarette Folder/Cig Tobacco Albeto.jpg",
  },
  { roughness: 1.0, metalness: 0.0 }
);

function makeBurnBandTexture(size = 256) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");

  // base horizontal band
 const g = ctx.createLinearGradient(0, 0, size, 0);
g.addColorStop(0.00, "rgba(0,0,0,0.0)");
g.addColorStop(0.10, "rgba(20,0,0,0.05)");
g.addColorStop(0.24, "rgba(60,0,0,0.16)");
g.addColorStop(0.36, "rgba(110,0,0,0.34)");
g.addColorStop(0.45, "rgba(165,10,0,0.62)");
g.addColorStop(0.49, "rgba(235,70,12,0.88)");
g.addColorStop(0.505, "rgba(255,150,45,0.78)");
g.addColorStop(0.525, "rgba(255,210,120,0.22)");
g.addColorStop(0.56, "rgba(150,8,0,0.58)");
g.addColorStop(0.70, "rgba(55,0,0,0.18)");
g.addColorStop(1.00, "rgba(0,0,0,0.0)");

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y++) {
  const breakChance = Math.random();

  // 🔥 kill parts of the ring (dead ash sections)
  if (breakChance > 0.78) {
    ctx.fillStyle = `rgba(0,0,0,${0.35 + Math.random() * 0.4})`;
    ctx.fillRect(0, y, size, 1);
    continue;
  }

  // 🔥 dim uneven areas
  if (breakChance > 0.55) {
    ctx.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.25})`;
    ctx.fillRect(0, y, size, 1);
  }

  // 🔥 rare hot bright streaks
  if (Math.random() > 0.92) {
    ctx.fillStyle = `rgba(255,200,120,${0.12 + Math.random() * 0.18})`;
    ctx.fillRect(size * (0.45 + Math.random() * 0.1), y, 6, 1);
  }
}

  // add a few brighter hot streaks / flecks
for (let i = 0; i < 14; i++) {
  const x = size * (0.44 + Math.random() * 0.12);
  const y = Math.random() * size;
  const w = 4 + Math.random() * 10;
  const h = 1 + Math.random() * 3;

  const isHot = Math.random() > 0.72;

  ctx.fillStyle = isHot
  ? `rgba(255,190,90,${0.14 + Math.random() * 0.16})`
  : `rgba(220,45,8,${0.08 + Math.random() * 0.10})`;

  ctx.fillRect(x, y, w, h);
}

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

const ashGlowTex = makeBurnBandTexture();

function makeEmberHaloTexture(size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");

  const g = ctx.createRadialGradient(
    size * 0.5, size * 0.5, size * 0.18,
    size * 0.5, size * 0.5, size * 0.5
  );

 g.addColorStop(0.00, "rgba(255,120,50,0.16)");
g.addColorStop(0.14, "rgba(190,28,0,0.22)");
g.addColorStop(0.34, "rgba(95,0,0,0.14)");
g.addColorStop(0.70, "rgba(30,0,0,0.03)");
g.addColorStop(1.00, "rgba(0,0,0,0.0)");

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // 🔥 darken lower half (adds depth / realism)
const shadowGrad = ctx.createLinearGradient(0, 0, 0, size);
shadowGrad.addColorStop(0.0, "rgba(0,0,0,0.0)");
shadowGrad.addColorStop(0.5, "rgba(0,0,0,0.15)");
shadowGrad.addColorStop(1.0, "rgba(0,0,0,0.35)");

ctx.fillStyle = shadowGrad;
ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

const emberHaloTex = makeEmberHaloTexture();

function makeSmokeSpriteTexture(size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");

  ctx.clearRect(0, 0, size, size);

  // build a soft irregular cloud out of overlapping blobs
  for (let i = 0; i < 14; i++) {
    const x = size * (0.28 + Math.random() * 0.44);
    const y = size * (0.18 + Math.random() * 0.64);

    const rx = size * (0.10 + Math.random() * 0.16);
    const ry = size * (0.06 + Math.random() * 0.14);

    const a = 0.035 + Math.random() * 0.05;

    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
    g.addColorStop(0.00, `rgba(255,255,255,${a})`);
    g.addColorStop(0.45, `rgba(235,235,235,${a * 0.7})`);
    g.addColorStop(1.00, "rgba(0,0,0,0.0)");

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((Math.random() - 0.5) * 1.2);
    ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
    ctx.translate(-x, -y);

    ctx.fillStyle = g;
    ctx.fillRect(x - Math.max(rx, ry), y - Math.max(rx, ry), Math.max(rx, ry) * 2, Math.max(rx, ry) * 2);
    ctx.restore();
  }

  // lightly erase the center so it doesn't look like a perfect puff stamp
  for (let i = 0; i < 6; i++) {
    const x = size * (0.35 + Math.random() * 0.30);
    const y = size * (0.25 + Math.random() * 0.50);
    const r = size * (0.05 + Math.random() * 0.08);

    const cut = ctx.createRadialGradient(x, y, 0, x, y, r);
    cut.addColorStop(0.00, "rgba(0,0,0,0.06)");
    cut.addColorStop(1.00, "rgba(0,0,0,0.0)");

    ctx.fillStyle = cut;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

const cigaretteSmokeTex = makeSmokeSpriteTexture();

function getSafeRoomMaxDim() {
  return Number.isFinite(roomMaxDim) && roomMaxDim > 0 ? roomMaxDim : 10;
}

function getSmokeScaleUnit() {
  return Math.max(0.001, getSafeRoomMaxDim() * 0.01);
}

function getSmokeOffsetUnit() {
  return Math.max(0.001, getSafeRoomMaxDim() * 0.003);
}

function ensureSmokeWorldRoot() {
  if (smokeWorldRoot) return smokeWorldRoot;

  smokeWorldRoot = new THREE.Group();
  smokeWorldRoot.name = "SmokeWorldRoot";
  scene.add(smokeWorldRoot);

  return smokeWorldRoot;
}

function buildFrontWallDrawPlane() {
  if (wallDrawPlaneRef) return wallDrawPlaneRef;

  wallDrawCanvas = document.createElement("canvas");
  wallDrawCanvas.width = WALL_DRAW_SIZE;
  wallDrawCanvas.height = WALL_DRAW_SIZE;

  wallDrawCtx = wallDrawCanvas.getContext("2d");
  wallDrawCtx.clearRect(0, 0, WALL_DRAW_SIZE, WALL_DRAW_SIZE);
  wallDrawCtx.fillStyle = "rgba(0,0,0,0)";
wallDrawCtx.fillRect(0, 0, WALL_DRAW_SIZE, WALL_DRAW_SIZE);

  wallDrawTex = new THREE.CanvasTexture(wallDrawCanvas);
  wallDrawTex.colorSpace = THREE.SRGBColorSpace;
  wallDrawTex.flipY = true;
  wallDrawTex.needsUpdate = true;

const wallDrawMat = new THREE.MeshBasicMaterial({
  map: wallDrawTex,
  transparent: true,
  opacity: 1.0,
  depthTest: true,
  depthWrite: false,
  side: THREE.DoubleSide
});

  const wallDrawGeo = new THREE.PlaneGeometry(1, 1);
  wallDrawPlaneRef = new THREE.Mesh(wallDrawGeo, wallDrawMat);
  wallDrawPlaneRef.name = "WallDrawPlane";
  wallDrawPlaneRef.renderOrder = 0;

  // start disabled so it does NOT block existing interactions
  wallDrawPlaneRef.raycast = () => {};

  scene.add(wallDrawPlaneRef);
  return wallDrawPlaneRef;
}

function placeFrontWallDrawPlane(maxDim) {
  if (!wallDrawPlaneRef) return;

 wallDrawPlaneRef.position.set(
  maxDim * 0.28,   // X
  maxDim * -0.17,  // Y
  maxDim * -0.482   // Z
);

  wallDrawPlaneRef.rotation.set(0, -0.015, 0);

  wallDrawPlaneRef.scale.set(
    maxDim * 0.38,    // width
    maxDim * 0.77,    // height
    1
  );

  wallDrawPlaneRef.updateMatrixWorld(true);
}

function setWallDrawMode(on) {
  drawMode = on;

  if (!wallDrawPlaneRef) return;

  if (drawMode) {
    delete wallDrawPlaneRef.raycast;
  } else {
    wallDrawPlaneRef.raycast = () => {};
    isWallDrawing = false;
    hasLastWallDrawUv = false;
  }
}

function toggleWallTool() {
  wallTool = wallTool === "pen" ? "eraser" : "pen";
  console.log(`Wall tool is now: ${wallTool}`);
}

function cycleWallMarkerColor() {
  wallMarkerColorIndex = (wallMarkerColorIndex + 1) % WALL_MARKER_COLORS.length;
  wallMarkerColor = WALL_MARKER_COLORS[wallMarkerColorIndex];
  console.log(`Wall marker color is now: ${wallMarkerColor}`);
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgbObject(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbaFromRgbObject(rgb, alpha) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function getWallPaintRgb(hex) {
  const h = hex.toUpperCase();

  // white: make it wall-dirty, not digital white
  if (h === "#FFFFFF") {
    return { r: 198, g: 190, b: 178 };
  }

  // black: slightly warm charcoal
  if (h === "#000000") {
    return { r: 22, g: 18, b: 16 };
  }

  // red: darker, dried spray-paint red
  if (h === "#6D120D") {
    return { r: 90, g: 18, b: 16 };
  }

  // blue: much less neon / less clean
  if (h === "#5D7A91") {
    return { r: 86, g: 111, b: 126 };
  }

  // orange: less bright, more dusty
  if (h === "#E57B36") {
    return { r: 188, g: 112, b: 58 };
  }

  // pink: muted pastel, less synthetic
  if (h === "#B396B7") {
    return { r: 157, g: 132, b: 162 };
  }

  // green: darker, dirtier green
  if (h === "#2A6231") {
    return { r: 40, g: 84, b: 47 };
  }

  const rgb = hexToRgbObject(hex);

  return {
    r: Math.round(rgb.r * 0.82),
    g: Math.round(rgb.g * 0.80),
    b: Math.round(rgb.b * 0.78),
  };
}

function wallHash2D(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function wallNoise2D(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = x - x0;
  const sy = y - y0;

  const n00 = wallHash2D(x0, y0);
  const n10 = wallHash2D(x1, y0);
  const n01 = wallHash2D(x0, y1);
  const n11 = wallHash2D(x1, y1);

  const ix0 = n00 + (n10 - n00) * sx;
  const ix1 = n01 + (n11 - n01) * sx;

  return ix0 + (ix1 - ix0) * sy;
}

function getWallSurfaceAlpha(x, y) {
  // small grain
  const grain = wallNoise2D(x * 0.18, y * 0.18);

  // bigger plaster breakup
  const plaster = wallNoise2D(x * 0.045, y * 0.045);

  // faint streaking / wall unevenness
  const streak = wallNoise2D(x * 0.015, y * 0.09);

  let a = 0.78 + grain * 0.16 + plaster * 0.12 + streak * 0.08;

  // clamp
  if (a < 0.58) a = 0.58;
  if (a > 1.0) a = 1.0;

  return a;
}

function sprayDot(x, y) {
  if (!wallDrawCtx) return;

  const paintRgb = getWallPaintRgb(wallMarkerColor);

  wallDrawCtx.save();
  wallDrawCtx.globalCompositeOperation = "source-over";

  // --------------------------------------------------
  // PASS 1: main body of paint
  // --------------------------------------------------
  for (let i = 0; i < WALL_SPRAY_CORE_DABS; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.pow(Math.random(), 2.35) * WALL_SPRAY_JITTER;

    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;

    const px = x + dx;
    const py = y + dy;

  const r =
  (WALL_SPRAY_DOT_MIN +
    Math.random() * (WALL_SPRAY_DOT_MAX - WALL_SPRAY_DOT_MIN)) *
  (0.85 + Math.random() * 0.35);

    const baseAlpha =
      WALL_PAINT_ALPHA_MIN +
      Math.random() * (WALL_PAINT_ALPHA_MAX - WALL_PAINT_ALPHA_MIN);

    const wallAlpha = getWallSurfaceAlpha(px, py);
    const alpha = baseAlpha * wallAlpha;

    wallDrawCtx.fillStyle = rgbaFromRgbObject(paintRgb, alpha);
    wallDrawCtx.beginPath();
    wallDrawCtx.arc(px, py, r, 0, Math.PI * 2);
    wallDrawCtx.fill();
  }

  // --------------------------------------------------
  // PASS 2: subtle edge dust
  // --------------------------------------------------
  for (let i = 0; i < WALL_SPRAY_EDGE_DABS; i++) {
    const angle = Math.random() * Math.PI * 2;

    const dist =
      WALL_SPRAY_JITTER +
      Math.random() * (WALL_SPRAY_EDGE_JITTER - WALL_SPRAY_JITTER);

    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;

    const px = x + dx;
    const py = y + dy;

    const r = 0.25 + Math.random() * 0.55;
    const wallAlpha = getWallSurfaceAlpha(px, py);
    const alpha = (0.008 + Math.random() * 0.012) * wallAlpha * 0.9;

    wallDrawCtx.fillStyle = rgbaFromRgbObject(paintRgb, alpha);
    wallDrawCtx.beginPath();
    wallDrawCtx.arc(px, py, r, 0, Math.PI * 2);
    wallDrawCtx.fill();
  }

  // --------------------------------------------------
  // PASS 3: minimal distressed breakup
  // --------------------------------------------------
  for (let i = 0; i < 10; i++) {
    if (Math.random() > WALL_SPRAY_HOLE_CHANCE) continue;

    const angle = Math.random() * Math.PI * 2;
    const dist = Math.pow(Math.random(), 2.2) * WALL_SPRAY_JITTER;

    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;

    const px = x + dx;
    const py = y + dy;

    const r = 0.18 + Math.random() * 0.30;

    wallDrawCtx.globalCompositeOperation = "destination-out";
    wallDrawCtx.beginPath();
    wallDrawCtx.arc(px, py, r, 0, Math.PI * 2);
    wallDrawCtx.fill();
    wallDrawCtx.globalCompositeOperation = "source-over";
  }

  wallDrawCtx.restore();
}

function drawOnWallAtUV(uv) {
  if (!wallDrawCtx || !wallDrawTex) return;

  const x = uv.x * WALL_DRAW_SIZE;
  const y = (1.0 - uv.y) * WALL_DRAW_SIZE;

  wallDrawCtx.save();

  if (wallTool === "eraser") {
    wallDrawCtx.globalCompositeOperation = "destination-out";
    wallDrawCtx.beginPath();
    wallDrawCtx.arc(x, y, WALL_ERASER_RADIUS, 0, Math.PI * 2);
    wallDrawCtx.fill();
  } else {
    sprayDot(x, y);
  }

  wallDrawCtx.restore();
  wallDrawTex.needsUpdate = true;
}

function drawWallLineUV(uvA, uvB) {
  if (!wallDrawCtx || !wallDrawTex) return;

  const x1 = uvA.x * WALL_DRAW_SIZE;
  const y1 = (1.0 - uvA.y) * WALL_DRAW_SIZE;
  const x2 = uvB.x * WALL_DRAW_SIZE;
  const y2 = (1.0 - uvB.y) * WALL_DRAW_SIZE;

  wallDrawCtx.save();

  if (wallTool === "eraser") {
    wallDrawCtx.globalCompositeOperation = "destination-out";
    wallDrawCtx.lineCap = "round";
    wallDrawCtx.lineJoin = "round";
    wallDrawCtx.lineWidth = WALL_ERASER_LINE_WIDTH;

    wallDrawCtx.beginPath();
    wallDrawCtx.moveTo(x1, y1);
    wallDrawCtx.lineTo(x2, y2);
    wallDrawCtx.stroke();
  } else {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / (0.8 + Math.random() * 0.3)));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      sprayDot(x, y);
    }
  }

  wallDrawCtx.restore();
  wallDrawTex.needsUpdate = true;
}

function clearWallDrawing() {
  if (!wallDrawCtx || !wallDrawTex) return;

  wallDrawCtx.clearRect(0, 0, WALL_DRAW_SIZE, WALL_DRAW_SIZE);
  wallDrawCtx.fillStyle = "rgba(0,0,0,0)";
  wallDrawCtx.fillRect(0, 0, WALL_DRAW_SIZE, WALL_DRAW_SIZE);

  wallDrawTex.needsUpdate = true;
}

function buildCigaretteSmoke(emitterParent) {
  if (!emitterParent) {
    console.warn("buildCigaretteSmoke: emitterParent missing");
    return;
  }

  const worldRoot = ensureSmokeWorldRoot();

  if (cigaretteSmokePoints) {
    cigaretteSmokePoints.removeFromParent();
    cigaretteSmokeGeo?.dispose?.();
    cigaretteSmokeMat?.dispose?.();
    cigaretteSmokeGeo = null;
    cigaretteSmokeMat = null;
    cigaretteSmokePoints = null;
    cigaretteSmokeData.length = 0;
  }

  cigaretteSmokeGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(CIG_SMOKE_COUNT * 3);

  cigaretteSmokeData.length = 0;

  // IMPORTANT:
  // particles now simulate in WORLD SPACE,
  // so start them at 0 and position the whole Points object in world coords
  for (let i = 0; i < CIG_SMOKE_COUNT; i++) {
    const i3 = i * 3;

    const x = 0;
const y = 0;
const z = 0;

positions[i3 + 0] = x;
positions[i3 + 1] = y;
positions[i3 + 2] = z;

cigaretteSmokeData.push({
  x,
  y,
  z,
  vx: (Math.random() - 0.5) * 0.03,
  vy: 0.14 + Math.random() * 0.08,
  vz: (Math.random() - 0.5) * 0.03,
  age: 0, // ✅ start fresh
  life: 3.0 + Math.random() * 2.0,
  swirl: Math.random() * Math.PI * 2,
});
  }

  cigaretteSmokeGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );

cigaretteSmokeMat = new THREE.PointsMaterial({
  color: 0xf0f0f0,
  map: cigaretteSmokeTex,
  alphaMap: cigaretteSmokeTex,
  transparent: true,
  opacity: 0.39, // 🔥 increased
  size: 0.50,    // 🔥 slightly bigger
  sizeAttenuation: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NormalBlending,
  fog: true
});

 cigaretteSmokePoints = new THREE.Points(cigaretteSmokeGeo, cigaretteSmokeMat);
cigaretteSmokePoints.frustumCulled = false;
cigaretteSmokePoints.renderOrder = 999;

  // put smoke into WORLD space, not under the tilted mesh
  worldRoot.add(cigaretteSmokePoints);

  // initial world position from emitter
  emitterParent.updateMatrixWorld(true);
  emitterParent.getWorldPosition(smokeSourceWorld);
smokeSourceWorld.y += 0.15; // 🔥 same offset here
cigaretteSmokePoints.position.copy(smokeSourceWorld);

  console.log("✅ cigarette smoke built in WORLD space at:", smokeSourceWorld);
}

function resetSmokeParticle(p) {
  const U = Math.max(0.001, roomMaxDim * 0.01);

  p.x = (Math.random() - 0.5) * U * 0.8;
  p.y = Math.random() * U * 0.004;
  p.z = (Math.random() - 0.5) * U * 0.8;

  p.vx = (Math.random() - 0.5) * U * 0.4;
  p.vy = U * (1.0 + Math.random() * 0.8);
  p.vz = (Math.random() - 0.5) * U * 0.4;

  p.age = 0;

// ✅ longer life so smoke rises higher
p.life = 5.5 + Math.random() * 3.5;

p.swirl = Math.random() * Math.PI * 2;
}

function resetAllSmokeParticlesToEmitter() {
  if (!cigaretteSmokeGeo) return;

  const pos = cigaretteSmokeGeo.attributes.position.array;

  for (let i = 0; i < CIG_SMOKE_COUNT; i++) {
    const p = cigaretteSmokeData[i];
    const i3 = i * 3;

    p.x = 0;
    p.y = 0;
    p.z = 0;

    p.vx = (Math.random() - 0.5) * 0.03;
    p.vy = 0.14 + Math.random() * 0.08;
    p.vz = (Math.random() - 0.5) * 0.03;

    p.age = 0;
    p.life = 3.0 + Math.random() * 2.0;
    p.swirl = Math.random() * Math.PI * 2;

    pos[i3 + 0] = 0;
    pos[i3 + 1] = 0;
    pos[i3 + 2] = 0;
  }

  cigaretteSmokeGeo.attributes.position.needsUpdate = true;
}

function updateCigaretteSmoke(dt) {
    if (!smokeEmitterRef) return;

  const now = performance.now() * 0.001;

  // keep emitter world position fresh
  smokeEmitterRef.updateMatrixWorld(true);
  smokeEmitterRef.getWorldPosition(smokeSourceWorld);
  smokeSourceWorld.y += 0.15; // 🔥 raise smoke here

    if (!cigaretteSmokeBuilt) {
    if ((now - cigaretteSmokeStartTime) < CIGARETTE_SMOKE_DELAY) {
      return;
    }

    buildCigaretteSmoke(smokeEmitterRef);
    cigaretteSmokeBuilt = true;
    cigaretteSmokeStarted = true;

    if (!cigaretteSmokeGeo || !cigaretteSmokePoints) return;

    cigaretteSmokePoints.visible = true;
  }

  if (!cigaretteSmokeGeo || !cigaretteSmokePoints) return;

  cigaretteSmokePoints.position.copy(smokeSourceWorld);

  const pos = cigaretteSmokeGeo.attributes.position.array;
  const t = performance.now() * 0.001;

  for (let i = 0; i < CIG_SMOKE_COUNT; i++) {
    const p = cigaretteSmokeData[i];
    const i3 = i * 3;

    p.age += dt;

    if (p.age >= p.life) {
        p.x = (Math.random() - 0.5) * 0.010;
        p.y = Math.random() * 0.004;
        p.z = (Math.random() - 0.5) * 0.010;

        p.vx = (Math.random() - 0.5) * 0.020;
        p.vy = 0.11 + Math.random() * 0.05;
        p.vz = (Math.random() - 0.5) * 0.020;

      p.age = 0;

      // ✅ LONGER LIFE (linger)
      p.life = 5.5 + Math.random() * 3.5;

      p.swirl = Math.random() * Math.PI * 2;
    }

    const k = p.age / p.life;

    // ✅ VERY SOFT MOTION
        const curl = 0.020 + k * 0.032;
const spread = 0.050 + k * 0.12;

    // gentle curl + slow drift
    p.x += p.vx * dt + Math.sin(t * 1.2 + p.swirl + k * 3.0) * curl * dt;
    p.y += p.vy * dt * 0.95;
    p.z += p.vz * dt + Math.cos(t * 1.1 + p.swirl + k * 3.0) * curl * dt;

    // ✅ DRAG (this is key for realism)
    p.vx *= 0.985;
    p.vy *= 0.997;
    p.vz *= 0.985;

    // gentle outward bloom over time
    p.x *= (1.0 + spread * dt * 0.45);
    p.z *= (1.0 + spread * dt * 0.45);

    pos[i3 + 0] = p.x;
    pos[i3 + 1] = p.y;
    pos[i3 + 2] = p.z;
  }

  cigaretteSmokeGeo.attributes.position.needsUpdate = true;

  if (cigaretteSmokeMat) {
    cigaretteSmokeMat.opacity = 0.26;
  }
}

const cigaretteAshMat = (() => {
  const m = makePBR(
    {
      albedo: "./assets/Textures/New Cigarette Folder/Cig Ash Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0 }
  );

  // darker coal/ash base
  m.color.multiplyScalar(0.82);

  // subtle built-in heat, not the main visible glow
  m.emissive = new THREE.Color(0x5a0500);
m.emissiveIntensity = 3.2;

  // ✅ IMPORTANT: no emissiveMap here anymore
  m.emissiveMap = null;

  m.toneMapped = false;
  return m;
})();

const cigaretteEmberMat = new THREE.MeshStandardMaterial({
  color: 0x2a0500,
  emissive: 0xff5a10,
  emissiveIntensity: 11.0,
  roughness: 1.0,
  metalness: 0.0,
  side: THREE.DoubleSide,
  toneMapped: false,
});

darkenMaterial(cigaretteFilterMat, {
  env: 0.0,
  rough: 1.0,
  colorMul: 0.7,
});

darkenMaterial(cigaretteTobaccoMat, {
  env: 0.0,
  rough: 1.0,
  colorMul: 0.7,
});

darkenMaterial(cigaretteAshMat, {
  env: 0.0,
  rough: 1.0,
  colorMul: 0.7,
});

// ============================================================
// ✅ WALL DETAIL BOOST (micro-contrast without "brightening")
// Paste directly under: const materials = { ... };
// ============================================================
if (materials.front_wall1) {
  // small lift so cracks/details show
  materials.front_wall1.color.multiplyScalar(1.12);
  // slightly less chalk-flat
  materials.front_wall1.roughness = Math.min(materials.front_wall1.roughness ?? 1.0, 0.92);
  if ("envMapIntensity" in materials.front_wall1) materials.front_wall1.envMapIntensity = 0.03;
  materials.front_wall1.needsUpdate = true;
}

if (materials.Left_wall1) {
  materials.Left_wall1.color.multiplyScalar(1.10);
  materials.Left_wall1.roughness = Math.min(materials.Left_wall1.roughness ?? 1.0, 0.90);
  if ("envMapIntensity" in materials.Left_wall1) materials.Left_wall1.envMapIntensity = 0.035;
  materials.Left_wall1.needsUpdate = true;
}

// ============================================================
// ✅ Picture1 material tuning (prevents over-bright photos)
// Paste DIRECTLY after: const materials = { ... };
// ============================================================
if (materials.Picture1) {
  // isolate so nothing else sharing this material gets affected
  materials.Picture1 = materials.Picture1.clone();

  // kill reflections / IBL on the photo
  if ("envMapIntensity" in materials.Picture1) materials.Picture1.envMapIntensity = 0.0;

  // make it "paper-like"
  materials.Picture1.metalness = 0.0;
  materials.Picture1.roughness = 0.9;

  // reduce brightness without changing your textures
  materials.Picture1.color.setHex(0xffffff);
  materials.Picture1.color.multiplyScalar(0.75); // ✅ try 0.70–0.90

  materials.Picture1.needsUpdate = true;
}

// ============================================================
// ✅ Picture1 interchangeable textures (01–06)
// ============================================================
const PICTURE1_TEXTURES = [
  "./assets/Textures/Picture/01_Picture11.jpg",
  "./assets/Textures/Picture/02_Picture21.jpg",
  "./assets/Textures/Picture/03_Picture31.jpg",
  "./assets/Textures/Picture/04_Picture41.jpg",
  "./assets/Textures/Picture/05_Picture51.jpg",
  "./assets/Textures/Picture/06_Picture61.jpg",
  "./assets/Textures/Picture/07_Picture71.jpg",
  "./assets/Textures/Picture/08_Picture81.jpg",
  "./assets/Textures/Picture/09_Picture91.jpg",
  "./assets/Textures/Picture/10_Picture101.jpg",
  
];

let picture1TexIndex = 0;
let picture1MeshRef = null; // will be captured from Main GLB
let grimReaperRef = null;

let wallDrawPlaneRef = null;
let wallDrawCanvas = null;
let wallDrawCtx = null;
let wallDrawTex = null;

let drawMode = false;
let isWallDrawing = false;
let hasLastWallDrawUv = false;

let wallTool = "pen"; // "pen" or "eraser"

const WALL_MARKER_COLORS = [
  "#000000", // black
  "#FFFFFF", // white
  "#6D120D", // red
  "#5D7A91", // blue
  "#E57B36", // orange
  "#B396B7", // pink
  "#2A6231", // green
];

let wallMarkerColorIndex = 0;
let wallMarkerColor = WALL_MARKER_COLORS[wallMarkerColorIndex];

const WALL_PEN_RADIUS = 8.0;
const WALL_PEN_LINE_WIDTH = 10;

const WALL_SPRAY_CORE_DABS = 34;
const WALL_SPRAY_EDGE_DABS = 7;

const WALL_SPRAY_JITTER = 6.0;
const WALL_SPRAY_EDGE_JITTER = 9.5;

const WALL_SPRAY_DOT_MIN = 0.45;
const WALL_SPRAY_DOT_MAX = 1.2;

const WALL_SPRAY_HOLE_CHANCE = 0.06;

const WALL_PAINT_SHADOW_OFFSET_X = 0.85;
const WALL_PAINT_SHADOW_OFFSET_Y = 0.55;
const WALL_PAINT_SHADOW_ALPHA = 0.030;

const WALL_PAINT_ALPHA_MIN = 0.04;
const WALL_PAINT_ALPHA_MAX = 0.090;

const WALL_ERASER_RADIUS = 14.0;
const WALL_ERASER_LINE_WIDTH = 24;

const wallDrawUv = new THREE.Vector2();
const lastWallDrawUv = new THREE.Vector2();
const wallDrawRaycastHits = [];

const WALL_DRAW_SIZE = 1024;

let cigaretteRoot = null;
let cigaretteMeshRef = null;
let cigaretteSmokeAnchor = null;
let emberTipRef = null;
let emberTipMatRef = null;
let emberTipMatIndex = -1;
let ashMatRef = null;
let ashMeshRef = null;
let emberLightRef = null;
let hoveringCigarette = false;

let emberHaloRef = null;
let emberHaloMatRef = null;

let smokeTipRoot = null;
let smokeTipMeshRef = null;
let smokeEmitterRef = null;
let smokeEmitterAnchor = null;

const SMOKE_EMITTER_LOCAL_OFFSET = new THREE.Vector3(-0.080, 0.09, -0.245);

let smokeWorldRoot = null;
let smokeSourceWorld = new THREE.Vector3();

let cigaretteSmokePoints = null;
let cigaretteSmokeGeo = null;
let cigaretteSmokeMat = null;

let cigaretteSmokeBuilt = false;
let cigaretteSmokeStarted = false;
let cigaretteSmokeStartTime = 0;
const CIGARETTE_SMOKE_DELAY = 8.0;
let cigaretteSmokeTimerArmed = false;

let smokeDebugRoot = null;
let smokeDebugBox = null;
let smokeDebugSphere = null;

const CIG_SMOKE_COUNT = 160;
const cigaretteSmokeData = [];

let emberCrackle = 0.72;
let emberCrackleTarget = 0.72;
let emberCrackleNextT = 0;

let cigaretteMixer = null;
let cigaretteActions = [];

let smokeTipMixer = null;
let smokeTipActions = [];

const CIG_START_FRAME = 200;
const CIG_FPS = 24;
const CIG_START_TIME = CIG_START_FRAME / CIG_FPS;

const SMOKE_TIP_START_FRAME = 200;
const SMOKE_TIP_FPS = 24;
const SMOKE_TIP_START_TIME = SMOKE_TIP_START_FRAME / SMOKE_TIP_FPS;

function playCigaretteAnimation() {
  if (!cigaretteActions.length) {
    console.warn("⚠️ cigaretteActions missing");
    return;
  }

  for (const action of cigaretteActions) {
    action.enabled = true;
    action.paused = false;
    action.reset();
    action.time = CIG_START_TIME;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
  }

  console.log("▶️ cigarette animation triggered", cigaretteActions.map(a => a.getClip().name));
}

function playSmokeTipAnimation() {
  if (!smokeTipActions.length) {
    console.warn("⚠️ smokeTipActions missing");
    return;
  }

  for (const action of smokeTipActions) {
    action.enabled = true;
    action.paused = false;
    action.reset();
    action.time = SMOKE_TIP_START_TIME;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
  }

  console.log(
    "💨 smoke tip animation triggered",
    smokeTipActions.map(a => a.getClip().name)
  );
}

function updateCigaretteEmber() {
  const now = performance.now() * 0.001;

  // slow stepped coal crackle — not stroby
  if (now > emberCrackleNextT) {
    emberCrackleNextT = now + 0.09 + Math.random() * 0.20;

    const r = Math.random();

    if (r < 0.58) {
      emberCrackleTarget = 0.68 + Math.random() * 0.08; // stable burn
    } else if (r < 0.86) {
      emberCrackleTarget = 0.54 + Math.random() * 0.08; // slight dim
    } else {
      emberCrackleTarget = 0.86 + Math.random() * 0.12; // crack/pop
    }
  }

  emberCrackle += (emberCrackleTarget - emberCrackle) * 0.12;

  // subtle slow breathing underneath
  const breathe =
    0.025 * Math.sin(now * 1.6) +
    0.012 * Math.sin(now * 3.7);

  const heat = Math.max(0.35, emberCrackle + breathe);

if (emberTipMatRef) {
  const flare =
    Math.max(0, Math.sin(now * 8.0)) * 0.28 +
    Math.max(0, Math.sin(now * 13.0)) * 0.12;

  emberTipMatRef.emissive.setRGB(
    0.78 + heat * 0.16,
    0.035 + heat * 0.030 + flare * 0.025,
    0.0
  );

  emberTipMatRef.emissiveIntensity = 5.4 + heat * 2.0 + flare * 0.6;

  emberTipMatRef.color.setRGB(
    0.14 + heat * 0.05,
    0.01,
    0.0
  );

  emberTipMatRef.needsUpdate = true;
}

if (ashMatRef) {
  ashMatRef.emissive.setRGB(
    0.22 + heat * 0.08,
    0.003,
    0.0
  );

  ashMatRef.emissiveIntensity = 0.42 + heat * 0.22;
  ashMatRef.needsUpdate = true;
}

if (emberLightRef) {
  const flare =
    Math.max(0, Math.sin(now * 8.0)) * 0.12 +
    Math.max(0, Math.sin(now * 13.0)) * 0.05;

  emberLightRef.intensity = 0.36 + heat * 0.20 + flare;
  emberLightRef.distance = 0.10 + heat * 0.025;

  emberLightRef.color.setRGB(
    1.0,
    0.10 + heat * 0.03,
    0.02
  );
}

if (emberHaloMatRef && emberHaloRef) {
  emberHaloMatRef.opacity = 0.10 + heat * 0.08;

  const sx = 0.026 + heat * 0.008;
  const sy = 0.014 + heat * 0.006;
  emberHaloRef.scale.set(sx, sy, 1.0);
}
}

function setPicture1Texture(index) {
  const n = PICTURE1_TEXTURES.length;
  picture1TexIndex = (index + n) % n;

  const path = PICTURE1_TEXTURES[picture1TexIndex];
  console.log("🖼 Picture1 texture ->", picture1TexIndex, path);

  const tex = loadSRGB(path);

  // ✅ GLTF-safe defaults (you already set flipY=false in loadTexture)
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;

  // ✅ CROPPING / FRAMING:
  // s < 1 zooms IN (crops edges). s > 1 zooms OUT (can reveal borders).
  const s = 0.92; // ✅ change this (0.88–0.96 usually good)
  tex.repeat.set(s, s);

  // Center it by default
  let ox = (1 - s) * 0.5;
  let oy = (1 - s) * 0.5;

  // ✅ NUDGES MUST BE SMALL because range is only 0..(1-s)
  // Example: if s=0.92 then (1-s)=0.08, so safe nudges are like ±0.00..0.04
  const nudgeX = 0.00;
  const nudgeY = 0.01; // ✅ tiny down/up nudge (try 0.00–0.03)

  ox += nudgeX;
  oy += nudgeY;

  // Clamp offsets so it never smears/tiles
  const maxO = 1 - s;
  ox = Math.max(0, Math.min(maxO, ox));
  oy = Math.max(0, Math.min(maxO, oy));

  tex.offset.set(ox, oy);
  tex.needsUpdate = true;

if (materials.Picture1) {
  materials.Picture1.map = tex;

  // ✅ CRITICAL: use the SAME texture to gently self-light the photo
  materials.Picture1.emissiveMap = tex;

  materials.Picture1.needsUpdate = true;
}

  // ✅ ALSO update actual mesh material (handles array or single)
  if (picture1MeshRef && picture1MeshRef.material) {
    const mat = picture1MeshRef.material;

    if (Array.isArray(mat)) {
      for (const m of mat) {
        if (!m) continue;
        m.map = tex;
        m.needsUpdate = true;
      }
    } else {
      mat.map = tex;
      mat.needsUpdate = true;
    }
  }
}

// Darken cigarette materials (Cig1–Cig13)
for (let i = 1; i <= 13; i++) {
  const key = `Cig${i}`;
  if (materials[key]) {
    darkenMaterial(materials[key], {
      env: 0.0,
      rough: 1.0,
      colorMul: 0.7,
    });
  }
}

if (materials.Foot && materials.Foot.color) {
  materials.Foot.color.multiplyScalar(0.65); // 0.7 darker, 0.9 subtle
}

// Darken cabinet / shelves
if (materials.cabnet) {
  darkenMaterial(materials.cabnet, {
    env: 0.0,
    rough: 0.75,
    colorMul: 0.25,
  });
}

const loader = new GLTFLoader();

const __endMainGLB = __beginAsset("Main GLB");

loader.load(
  "./assets/models/Final Static Materials3.glb",
  (gltf) => {
    __endMainGLB();

    const model = gltf.scene;
anchor.add(model);

console.log("======== FINAL STATIC MATERIALS GLB MESH LIST ========");

model.traverse((o) => {
  if (!o.isMesh) return;

  console.log(
    "[MESH]",
    "name:", o.name,
    "| material:", o.material?.name,
    "| parent:", o.parent?.name
  );
});

// ============================================================
// ✅ START GLB ANIMATIONS (bugs)
// ============================================================
if (gltf.animations && gltf.animations.length) {
  bugMixer = new THREE.AnimationMixer(model);

bugActions = gltf.animations.map((clip) => {
  const action = bugMixer.clipAction(clip);

  action.reset();

  // ✅ slow speed (keep your value)
  action.timeScale = 0.25;

  // ✅ play ONCE, not loop
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;

  action.play();

  return action;
});

// ============================================================
// ✅ WAIT 6s AFTER FINISH, THEN RESTART
// ============================================================
const bugRestartTimers = new Map(); // action -> timeoutId

bugMixer.addEventListener("finished", (e) => {
  const action = e.action;
  if (!action) return;

  // prevent double-scheduling (finished can fire more than once in some setups)
  if (bugRestartTimers.has(action)) return;

  const id = setTimeout(() => {
    bugRestartTimers.delete(action);

    action.reset();
    action.play();
  }, 6000);

  bugRestartTimers.set(action, id);
});


  console.log("🐛 Bug animations started:", gltf.animations.map(a => a.name));
} else {
  console.log("⚠️ No animations found in Final Static Materials3.glb");
}
    model.traverse((o) => {
      if (!o.isMesh) return;

      // ✅ ensure all static meshes are raycastable on WORLD layer
o.layers.enable(LAYER_WORLD);


if (o.isMesh && o.geometry && o.geometry.attributes.uv && !o.geometry.attributes.uv2) {
  o.geometry.setAttribute("uv2", o.geometry.attributes.uv);
}

      const n = (o.name || "").toLowerCase();

      // ============================================================
// ✅ FOOT — reduce brightness without killing color
// ============================================================
if (n.includes("foot") && o.material) {

  o.material = o.material.clone(); // isolate

  // reduce reflections (this is the main fix)
  if ("envMapIntensity" in o.material) {
    o.material.envMapIntensity = 0.01;  // was 0.02 globally
  }

  // make it less shiny
  o.material.roughness = Math.max(o.material.roughness ?? 0.8, 0.95);

  // slightly reduce highlight strength
  if ("metalness" in o.material) {
    o.material.metalness = 0.0;
  }

  o.material.needsUpdate = true;
}

// ✅ FOOD — STOP lamp blowout (darken diffuse + kill reflections)
if (
  (n.includes("food") || n.includes("popcorn") || n.includes("bowl")) &&
  o.material
) {
  o.material = o.material.clone(); // isolate (important)

  // 1) darken the diffuse response (this is the main brightness fix)
  if (o.material.color) {
    o.material.color.setHex(0xffffff);       // reset any tint first
    o.material.color.multiplyScalar(0.45);   // ✅ try 0.45–0.70
  }

  // 2) kill strong reflections (often reads as "too bright")
  if ("envMapIntensity" in o.material) {
    o.material.envMapIntensity = 0.0;        // ✅ hard stop IBL washout
  }

  // 3) make highlights broader + weaker
  if ("roughness" in o.material) {
    o.material.roughness = 1.0;
  }
  if ("metalness" in o.material) {
    o.material.metalness = 0.0;
  }

  o.material.needsUpdate = true;
}

if (!grimReaperRef && n === "grim_reaper") {
  grimReaperRef = o;

  grimReaperRef.visible = false;
  grimReaperRef.castShadow = false;
  grimReaperRef.receiveShadow = false;
  grimReaperRef.raycast = () => null;

  console.log("☠️ Grim_reaper permanently hidden:", o.name, "| material:", o.material?.name);
}

      // ✅ Capture Picture1 mesh by name OR material name
      const mnLower = (o.material?.name || "").toLowerCase();
      if (!picture1MeshRef && (n.includes("picture1") || mnLower.includes("picture1"))) {
        picture1MeshRef = o;
        console.log("🖼 Picture1 mesh found:", o.name, "material:", o.material?.name);

        // Force it to use your Picture1 material so swapping always works
        if (materials.Picture1) {
          o.material = materials.Picture1;
          o.material.needsUpdate = true;
        }
      }

          // ✅ CHAIN (clickable)
    const matN = (o.material?.name || "").toLowerCase();
    if (!chainMeshRef && (n.includes("chain") || matN.includes("chain"))) {
      chainMeshRef = o;
      console.log("⛓️ Chain mesh found:", o.name, "material:", o.material?.name);
    }

  
      // ===== DOOR COLOR / REALISM FIX =====
if (n.includes("door") && o.material && o.material.color) {
  o.material = o.material.clone();

  // Cream base (brighter)
  o.material.color.multiplyScalar(1.7);

  // Warm cream tint
  o.material.color.r *= 1.08;
  o.material.color.g *= 1.05;
  o.material.color.b *= 0.90;

  // Subtle dirt / age
  o.material.color.multiplyScalar(0.92);

  // Kill plastic shine
  o.material.roughness = Math.max(o.material.roughness, 0.85);

  // Small reflection = realism
  o.material.envMapIntensity = 0.04;

  o.material.needsUpdate = true;
}

// ============================================================
// ✅ REMOTE — reduce visual dominance (hierarchy control)
// ============================================================
if (n.includes("remote") && o.material) {
  remoteMeshRef = o; // ✅ store the main remote body mesh

  o.material = o.material.clone(); // isolate

  // Slightly darken overall
  if (o.material.color) {
    o.material.color.multiplyScalar(0.93); // subtle (0.88–0.95)
  }

  // Reduce highlight sharpness
  if ("roughness" in o.material) {
    o.material.roughness = Math.max(o.material.roughness ?? 0.6, 0.75);
  }

  // Kill excessive reflections
  if ("envMapIntensity" in o.material) {
    o.material.envMapIntensity = 0.01;
  }

  o.material.needsUpdate = true;
}

if (n.includes("board") || n.includes("skate")) {
  skateboardMeshRef = o;

  o.layers.enable(LAYER_ACCENT);

  // NEW: allow pin light to affect skateboard (remove if you don't want it)
  o.layers.enable(LAYER_PIN);
}

// ============================================================
// ✅ SHELF CONTENTS: allow depth fill to hit shelf items only
// (adjust names if needed)
// ============================================================
const shelfy =
  n.includes("book") ||
  n.includes("dvd") ||
  n.includes("mask") ||
  n.includes("cam") ||
  n.includes("cartridge") ||
  n.includes("box") ||
  n.includes("beer") ||
  n.includes("ash") ||
  n.includes("glass");

if (shelfy) {
  o.layers.enable(LAYER_ACCENT); // lets shelfFill light them
}

// ✅ DO NOT let the generic material assign overwrite Picture1
if (picture1MeshRef && o === picture1MeshRef) {
  // keep whatever we forced onto it (materials.Picture1)
  return;
}

const originalMatName = o.material?.name;
const keysToTry = [
  o.name,
  o.parent?.name,
  originalMatName,
  o.parent?.parent?.name,
].filter(Boolean);

let mat = null;
let matchedKey = null;

for (const k of keysToTry) {
  if (materials[k]) {
    mat = materials[k];
    matchedKey = k;
    break;
  }
}

// ✅ DEBUG: show exactly which mesh got Lamp1 material
if (matchedKey === "Lamp1") {
  console.log("🔥 LAMP1 MATERIAL APPLIED TO:", {
    meshName: o.name,
    parentName: o.parent?.name,
    grandParentName: o.parent?.parent?.name,
    originalMatName,
    matchedKey,
  });
}

// ✅ only fallback if nothing matched
o.material = mat ? mat : fallbackMat;

// ============================================================
// TV SCREEN — subtle cool emissive glow (not frame/bezel)
// ============================================================
if (
  n.includes("screen") &&
  !n.includes("frame") &&
  !n.includes("bezel") &&
  o.material
) {
  o.material = o.material.clone(); // isolate from shared mat

  if ("metalness" in o.material) o.material.metalness = 0.0;
  if ("roughness" in o.material) o.material.roughness = 1.0;

  o.material.color.setHex(0x000000); // keep screen dark

  o.material.emissive = new THREE.Color(0x0a0f1c); // subtle cool blue
  o.material.emissiveIntensity = 0.4;

  o.material.needsUpdate = true;
}

// ✅ FORCE Picture1 after material assignment so it can't be overwritten
if (materials.Picture1) {
  const nn = (o.name || "").toLowerCase();
  const mm = (originalMatName || "").toLowerCase(); // you already declared originalMatName above

  if (nn.includes("picture1") || mm.includes("picture1")) {
    picture1MeshRef = o;

    o.material = materials.Picture1;
    o.material.needsUpdate = true;

    // start at first texture if needed
    setPicture1Texture(picture1TexIndex);

    console.log("🖼 Picture1 forced material on mesh:", o.name, "origMat:", originalMatName);
  }
}

      // ✅ Make door more cream colored
if (n.includes("door") && o.material && o.material.color) {
  o.material = o.material.clone();

  // Brighten
  o.material.color.multiplyScalar(1.8);

  // Warm / cream tint
  o.material.color.r *= 1.10;
  o.material.color.g *= 1.07;
  o.material.color.b *= 0.88;

  o.material.needsUpdate = true;
}

// ============================================================
// ✅ PICTURE FRAME — brighten + restore detail
// ============================================================
if (
  (n.includes("picture_frame") || n.includes("frame")) &&
  o.material
) {
  o.material = o.material.clone(); // isolate so we don't affect others

  // brighten base color slightly
  if (o.material.color) {
    o.material.color.multiplyScalar(1.18); // 🔥 try 1.2–1.5
  }

  // allow subtle reflections for edge detail
  if ("envMapIntensity" in o.material) {
    o.material.envMapIntensity = 0.06; // small reflection
  }

  // reduce roughness so highlights show shape
  if ("roughness" in o.material) {
    o.material.roughness = 0.7; // was likely ~1.0
  }

  // ensure not metallic unless it actually is
  if ("metalness" in o.material) {
    o.material.metalness = 0.0;
  }

  o.material.needsUpdate = true;
}

// ============================================================
// ✅ TV BEZEL (metal around screen) — improve edge definition
// ============================================================
if (
  o.material &&
  (
    n.includes("tv") ||
    n.includes("monitor") ||
    n.includes("screen_frame") ||
    n.includes("bezel")
  ) &&
  !n.includes("screen")
) {
  o.material = o.material.clone();

  // Slight brightness lift
  if (o.material.color) {
    o.material.color.multiplyScalar(1.12);
  }

  // Controlled reflections for edge separation
  if ("envMapIntensity" in o.material) {
    o.material.envMapIntensity = 0.08;
  }

  // Proper metal look
  if ("roughness" in o.material) {
    o.material.roughness = 0.45;
  }

  if ("metalness" in o.material) {
    o.material.metalness = 0.6;
  }

  o.material.needsUpdate = true;
}

if (
  o.material &&
  "envMapIntensity" in o.material &&
  !(
    n.includes("tv") ||
    n.includes("monitor") ||
    n.includes("screen_frame") ||
    n.includes("bezel")
  )
) {
  o.material.envMapIntensity = 0.012;
}

      o.castShadow = true;
      o.receiveShadow = true;
    ;
    });
    

      // ✅ FINALIZE Picture1 AFTER traverse so nothing overwrites it
    if (picture1MeshRef) {
      if (materials.Picture1) {
        picture1MeshRef.material = materials.Picture1;
        picture1MeshRef.material.needsUpdate = true;
      }
      setPicture1Texture(picture1TexIndex); // starts at 0 unless changed
    }

   // Center the whole anchor based on the ROOM bounds
const box = new THREE.Box3().setFromObject(model);
const center = box.getCenter(new THREE.Vector3());
anchor.position.sub(center);
anchor.updateMatrixWorld(true);


const box2 = new THREE.Box3().setFromObject(model);
const size2 = box2.getSize(new THREE.Vector3());
const maxDim = Math.max(size2.x, size2.y, size2.z);
roomMaxDim = maxDim;

buildFrontWallDrawPlane();
placeFrontWallDrawPlane(maxDim);
setWallDrawMode(true);

console.log("✅ roomMaxDim is now ready:", roomMaxDim);

__roomMaxDimForCamera = roomMaxDim;

if (isIOSDevice()) {
  applyVisibleViewportToRendererAndCamera();
  setIOSCameraFraming(roomMaxDim);
} else {
  // ✅ Desktop stays EXACTLY the same
  applyVisibleViewportToRendererAndCamera();
  setInitialCameraFraming(roomMaxDim);
}

    // Setup lights
    nightLights = setupNightLights(maxDim);

// ============================================================
// ✅ SHELF DEPTH FILL (subtle, no shadows, helps objects read)
// Paste directly under: nightLights = setupNightLights(maxDim);
// ============================================================
const shelfFill = new THREE.SpotLight(0xffd2a6, 10); // warm low fill
shelfFill.layers.set(LAYER_ACCENT);
shelfFill.castShadow = false;
shelfFill.decay = 2;
shelfFill.distance = maxDim * 0.55;
shelfFill.angle = Math.PI / 7;
shelfFill.penumbra = 1.0;

// Position: slightly inside / above shelf opening
shelfFill.position.set(maxDim * -0.18, maxDim * 0.14, maxDim * 0.22);
shelfFill.target.position.set(maxDim * -0.18, maxDim * 0.02, maxDim * -0.32);
scene.add(shelfFill);
scene.add(shelfFill.target);

    // ============================================================
// UNDER-SHELF UP LIGHT (THIS is what creates the shadow "upward")
// Put this RIGHT AFTER: nightLights = setupNightLights(maxDim);
// ============================================================
if (nightLights.underShelfUp) {
  // Position slightly below the shelf and centered
  nightLights.underShelfUp.position.set(
    0,              // center X
    maxDim * -0.10, // BELOW shelf (tweak this)
    maxDim * 0.10   // slightly forward
  );

  // Aim upward toward the back wall / top shelf area
  nightLights.underShelfUp.target.position.set(
    0,
    maxDim * 0.35,  // aim UP
    0
  );

  nightLights.underShelfUp.target.updateMatrixWorld(true);
}

const contactShadow = new THREE.SpotLight(0xffcfa5, 25);
contactShadow.position.set(
  0,
  maxDim * 0.1,
  maxDim * 0.35
);
contactShadow.angle = Math.PI / 5;
contactShadow.penumbra = 1.0;
contactShadow.distance = maxDim * 0.6;
contactShadow.castShadow = true;

scene.add(contactShadow);
scene.add(contactShadow.target);

if (lampMeshRef && lampMeshRef.material) {
  const m = lampMeshRef.material;
  m.emissiveIntensity = 1.6;
  m.needsUpdate = true;
}

    if (skateboardMeshRef) {
      const skatePos = new THREE.Vector3();
      skateboardMeshRef.getWorldPosition(skatePos);

      // Skate accent position + target
      nightLights.skateAccent.position.copy(skatePos).add(
        new THREE.Vector3(maxDim * 0.60, maxDim * 0.30, maxDim * 0.75)
      );
      nightLights.skateAccent.target.position.copy(skatePos);
      nightLights.skateAccent.target.updateMatrixWorld(true);
    }
    
    const fov = camera.fov * (Math.PI / 180);
    const baseDist = maxDim / (2 * Math.tan(fov / 2));

    const camX = maxDim * 0.030; // (+) Right (-) Left
    const camY = maxDim * -0.146; // (+) Up (-) Down
    const camZ = baseDist * 0.282; // (+) Farther (-) Closer

    const targetX = 1.18;
    const targetY = maxDim * -0.186;
    const targetZ = 0;

    // ✅ NEW: store the exact target we framed for desktop
    baseCamTarget0 = new THREE.Vector3(targetX, targetY, targetZ);

    // ✅ capture baseline for resize-based camera push-back
    baseCamPos0 = camera.position.clone();
    baseCamDir0 = new THREE.Vector3();
    camera.getWorldDirection(baseCamDir0); // direction camera is looking
    baseCamFov0 = camera.fov;

    
    if (baseFovDeg === null) baseFovDeg = camera.fov;

    // 🔥 Force resize AFTER camera baseline is locked
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 0);


    // ✅ store base camera position for breathing offsets
    baseCamPos = camera.position.clone();

    camera.near = maxDim / 1000;
    camera.far = maxDim * 1000;
    camera.updateProjectionMatrix();

baseFovDeg = camera.fov;
baseFovCaptured = true;

scheduleResize();
setTimeout(scheduleResize, 120);
setTimeout(() => {
  scheduleResize();

  // ✅ NOW that the final resize has happened, lock the “never move” camera
  captureFixedCameraBaseline();

  // ✅ iOS only: fix remote body perspective after camera/layout settle
  applyIOSRemoteTweaks();
  applyIOSLampTransform();

}, 260);

  },
  
  undefined,
  (err) => {
    console.error("GLB failed to load ❌", err);
    __endMainGLB(); // ✅ count errors as "done" so loader doesn't hang forever
  }
);


const interactiveLoader = new GLTFLoader();

const newMaterialsLoader = new GLTFLoader();

const cigaretteLoader = new GLTFLoader();

const smokeTipLoader = new GLTFLoader();


const __endUI = __beginAsset("Interactives GLB");

interactiveLoader.load(
  "./assets/models/Interactive Materials.glb",
  (gltf) => {
    __endUI();

    const ui = gltf.scene;
    anchor.add(ui);

    interactivesRootRef = ui;

    lampMeshRef = null;
    lampGroupRef = null;

    ui.traverse((o) => {
      const n = (o.name || "").toLowerCase();

      if (n === "lamp1") {
  lampMeshRef = o;
  lampGroupRef = o; // ✅ IMPORTANT: do NOT use parent, parent is the whole Scene

  console.log("💡 Lamp found in Interactive Materials GLB:", {
    objectName: o.name,
    parentName: o.parent?.name,
    type: o.type,
  });
}
    });

    console.log("💡 FINAL interactive lampMeshRef:", lampMeshRef?.name);
    console.log("💡 FINAL interactive lampGroupRef:", lampGroupRef?.name);

    applyIOSLampTransform();

    if (lampMeshRef && lampMeshRef.material) {
  lampMeshRef.material = lampMeshRef.material.clone();
  lampMeshRef.material.emissiveIntensity = 1.6;
  lampMeshRef.material.needsUpdate = true;
}

  ui.traverse((o) => {
  if (!o.isMesh) return;

    // 🚬 HIDE Cig1 from Interactive Materials GLB
  const on = (o.name || "").toLowerCase();
  const mn = (o.material?.name || "").toLowerCase();
  const pn = (o.parent?.name || "").toLowerCase();

  if (
    on.includes("mesh.011") ||
    on.includes("cig1") ||
    mn.includes("cig1") ||
    pn.includes("cig1")
  ) {
    console.log("🚬 Hiding Interactive Cig1:", {
      meshName: o.name,
      materialName: o.material?.name,
      parentName: o.parent?.name,
    });

    o.visible = false;
    o.castShadow = false;
    o.receiveShadow = false;
    return;
  }

  // ensure uv2 exists if we use AO maps
  if (o.geometry && o.geometry.attributes.uv && !o.geometry.attributes.uv2) {
    o.geometry.setAttribute("uv2", o.geometry.attributes.uv);
  }

  const meshName = (o.name || "").toLowerCase();
  const matName  = (o.material?.name || "").toLowerCase();

  // -------------------------
// REMOTE UI BUTTONS

// ----- DOWN ARROW -----
const isDownArrow =
  meshName.includes("down") && meshName.includes("arrow") ||
  matName.includes("down") && matName.includes("arrow") ||
  matName.includes("down_arrow_button") ||
  meshName.includes("down_arrow_button");

if (isDownArrow) {
  downArrowMeshRef = o;
  ensurePressState(o);

  // ✅ isolate emissive glow
  if (o.material) {
    o.material = o.material.clone();
    o.material.needsUpdate = true;
  }

  console.log("✅ Down arrow button:", o.name, "material:", o.material?.name);
}

// ----- UP ARROW -----
const isUpArrow =
  meshName.includes("top") && meshName.includes("arrow") ||
  meshName.includes("up") && meshName.includes("arrow") ||
  matName.includes("top") && matName.includes("arrow") ||
  matName.includes("up") && matName.includes("arrow") ||
  matName.includes("top_arrow_button") ||
  meshName.includes("top_arrow_button");

if (isUpArrow) {
  upArrowMeshRef = o;
  ensurePressState(o);

  // ✅ isolate emissive glow
  if (o.material) {
    o.material = o.material.clone();
    o.material.needsUpdate = true;
  }

  console.log("✅ Up arrow button:", o.name, "material:", o.material?.name);
}

// ----- OK BUTTON -----
const isOkButton =
  meshName.includes("ok") && meshName.includes("button") ||
  matName.includes("ok") && matName.includes("button") ||
  matName.includes("ok_button_remote2") ||
  meshName.includes("ok_button_remote2");

if (isOkButton) {
  okButtonMeshRef = o;
  ensurePressState(o);

  // ✅ isolate emissive glow
  if (o.material) {
    o.material = o.material.clone();
    o.material.needsUpdate = true;
  }

  console.log("✅ OK button:", o.name, "material:", o.material?.name);
}

// ----- LEFT ARROW -----
const isLeftArrow =
  (meshName.includes("left") && meshName.includes("button")) ||
  (meshName.includes("left") && meshName.includes("arrow")) ||
  matName.includes("left_button_remote");

if (isLeftArrow) {
  leftArrowMeshRef = o;
  ensurePressState(o);

  // ✅ isolate emissive glow
  if (o.material) {
    o.material = o.material.clone();
    o.material.needsUpdate = true;
  }

  console.log("✅ Left arrow button:", o.name, "material:", o.material?.name);
}

// ----- RIGHT ARROW -----
const isRightArrow =
  (meshName.includes("right") && meshName.includes("button")) ||
  (meshName.includes("right") && meshName.includes("arrow")) ||
  matName.includes("right_button_remote");

if (isRightArrow) {
  rightArrowMeshRef = o;
  ensurePressState(o);

  // ✅ isolate emissive glow
  if (o.material) {
    o.material = o.material.clone();
    o.material.needsUpdate = true;
  }

  console.log("✅ Right arrow button:", o.name, "material:", o.material?.name);
}

  //PowerButton
  const isPowerButton =
    (meshName.includes("power") && meshName.includes("button")) ||
    (matName.includes("power") && matName.includes("button"));

  if (isPowerButton) {
  powerButtonMeshRef = o;
  ensurePressState(o);

  // ✅ IMPORTANT: isolate emissive glow to THIS button only
  if (o.material) {
    o.material = o.material.clone();
    o.material.needsUpdate = true;
  }

  console.log("✅ Power button mesh:", o.name, "material:", o.material?.name);
}


// ✅ SPEAKER (name OR material name)  <-- PUT THIS HERE
  const isSpeaker =
    meshName.includes("bluetoothspeaker") ||
    meshName.includes("speaker") ||
    matName.includes("bluetoothspeaker") ||
    matName.includes("speaker");

  if (isSpeaker) {
    speakerMeshRef = o;
    console.log("✅ Speaker mesh:", o.name, "material:", o.material?.name);
  }

  // TV SCREEN (name OR material name)
  const isTvScreen =
    meshName.includes("tv_screen") ||
    meshName.includes("tv screen") ||
    meshName === "screen" ||
    (meshName.includes("tv") && meshName.includes("screen")) ||
    matName.includes("tv_screen") ||
    matName.includes("tv screen") ||
    (matName.includes("tv") && matName.includes("screen"));

  if (isTvScreen) {
    tvScreenMeshRef = o;
    tvScreenScale0.copy(o.scale); // ✅ remember original scale

    // FORCE your authored TV screen material
    const base = materials.TV_Screen ?? fallbackMat;
    const baseMat = Array.isArray(base) ? base[0] : base;

    const m = baseMat.clone();

    // make sure screen is solid (no alpha weirdness)
    m.transparent = false;
    m.opacity = 1.0;
    m.alphaMap = null;
    m.alphaTest = 0.0;
    m.depthWrite = true;
    m.depthTest = true;
    m.side = THREE.DoubleSide;

    // OFF look
    m.color.setHex(0x111111);
    m.roughness = Math.max(m.roughness ?? 0.9, 0.9);
    m.metalness = 0.0;

    // emissive (we animate intensity only)
    m.emissive = new THREE.Color(0xcfe8ff);

    m.map = tvTex;          // <-- our UI canvas becomes the screen content
    m.emissiveMap = tvTex;  // <-- makes it glow like a real screen

    // ✅ FIX: widen the texture to correct TV screen UV aspect
    tvTex.wrapS = THREE.ClampToEdgeWrapping;
    tvTex.wrapT = THREE.ClampToEdgeWrapping;

    // Start values (tweak once if needed)
    tvTex.repeat.set(1.0, 1.00);
    tvTex.offset.set(0.0, 0.00);


    tvTex.needsUpdate = true;



    // IMPORTANT: start OFF
    m.emissiveIntensity = 0.0;

    m.needsUpdate = true;

    tvScreenMatRef = m;
    o.material = m;

    console.log("✅ TV screen mesh forced:", o.name, "material forced to TV_Screen");

    // ensure shadows + no cull
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = true;

    return; // ✅ STOP HERE so nothing else overwrites screen material
  }

  // ------------------------------------------------------------------
  // ✅ NORMAL MATCHING FOR EVERYTHING ELSE
  // ------------------------------------------------------------------
  const keysToTry = [
    o.material?.name,
    o.name,
    o.parent?.name,
    o.parent?.parent?.name,
  ].filter(Boolean);

  let mat = null;
  let matchedKey = null;

  for (const key of keysToTry) {
    if (materials[key]) {
      mat = materials[key];
      matchedKey = key;
      break;
    }
  }

  // optional (redundant with robust detection, but fine)
  if (matchedKey === "Power_Button_Remote") {
    powerButtonMeshRef = o;
    console.log("✅ Power button registered:", o.name);
  }

  // ---------- MATERIAL ASSIGNMENT ----------
  if (mat) {
    o.material = mat;

    if (o.material && "envMapIntensity" in o.material) {
      o.material.envMapIntensity = 0.02;
    }

    o.material.needsUpdate = true;
  } else {
    o.material = fallbackMat;
  }

  o.castShadow = true;
  o.receiveShadow = true;
  o.frustumCulled = true;
});


ui.updateMatrixWorld(true);
console.log("Interactives loaded");

// ✅ iOS only: fix remote buttons after they exist
applyIOSRemoteTweaks();

syncDesktopPulseWithTvState();

// Force TV to start OFF
tvOn = false;
tvAnim = null;
if (tvScreenMatRef) {
  tvScreenMatRef.emissiveIntensity = 0.0;
  tvScreenMatRef.color.setHex(0x111111);
  tvScreenMatRef.needsUpdate = true;
}

},
undefined,
(err) => {
  console.error("Interactive GLB failed to load ❌", err);
  __endUI();
}
);

// ============================================================
// ✅ NEW: LOAD "New Materials.glb" (added to scene so textures work)
// Paste directly AFTER the Interactive Materials load block ends.
// ============================================================
const __endNewMaterials = __beginAsset("New Materials GLB");

newMaterialsLoader.load(
  "./assets/models/New Materials5.glb",
  (gltf) => {
    __endNewMaterials();

    const extra = gltf.scene;

    // ✅ Add to scene (same parent as your other models)
    anchor.add(extra);

    console.log("======== NEW MATERIALS GLB MESH LIST ========");

extra.traverse((o) => {
  if (!o.isMesh) return;

  console.log(
    "[NEW GLB MESH]",
    "name:", o.name,
    "| material:", o.material?.name,
    "| parent:", o.parent?.name
  );
});

    // ✅ Make meshes behave like your other scene meshes
    extra.traverse((o) => {
      if (!o.isMesh) return;

      // ✅ CAPTURE Grim_reaper from New Materials GLB too
const nn = (o.name || "").toLowerCase();
const mm = (o.material?.name || "").toLowerCase();

// ✅ FOOD in New Materials GLB — stop blowout here too
if (
  (nn.includes("food") || nn.includes("popcorn") || nn.includes("bowl") ||
   mm.includes("food") || mm.includes("popcorn") || mm.includes("bowl")) &&
  o.material
) {
  o.material = o.material.clone();

  if (o.material.color) {
    o.material.color.setHex(0xffffff);
    o.material.color.multiplyScalar(0.2); // ✅ try 0.45–0.70
  }

  if ("envMapIntensity" in o.material) {
    o.material.envMapIntensity = 0.0;
  }

  if ("roughness" in o.material) o.material.roughness = 1.0;
  if ("metalness" in o.material) o.material.metalness = 0.0;

  o.material.needsUpdate = true;
}

// ======================================================
  // ✅ HIDE FOOT (New Materials GLB)
  const isFoot =
    (nn === "foot" || nn.includes("foot") || mm === "foot" || mm.includes("foot")) &&
    !nn.includes("toe") &&
    !mm.includes("toe");

  if (isFoot) {
    o.visible = false;
    o.castShadow = false;
    o.receiveShadow = false;
    o.raycast = () => null;


    console.log("🦶 Foot hidden (New Materials):", o.name);
    return; // 🚨 VERY IMPORTANT — stop here for this mesh
  }

  // ======================================================
// ✅ DARKEN FOOD_BOWL (reduce brightness)
const isFoodBowl =
  nn.includes("food_bowl") ||
  nn.includes("foodbowl") ||
  mm.includes("food_bowl") ||
  mm.includes("foodbowl");

if (isFoodBowl) {
  o.material = o.material.clone();

  // ✅ Keep bowl readable (don’t over-darken)
  if (o.material.color) {
    o.material.color.setHex(0xffffff);
    o.material.color.multiplyScalar(0.45); // try 0.65–0.85
  }

  // ✅ Kill lamp “hot highlights”
  if ("metalness" in o.material) o.material.metalness = 0.0;
  if ("roughness" in o.material) o.material.roughness = 1.0;

  // ✅ This is the big one: removes sharp reflective hits (IBL/specular)
  if ("envMapIntensity" in o.material) o.material.envMapIntensity = 0.0;

  // ✅ If it’s MeshPhysicalMaterial, also kill extra gloss features
  if ("clearcoat" in o.material) o.material.clearcoat = 0.0;
  if ("clearcoatRoughness" in o.material) o.material.clearcoatRoughness = 1.0;
  if ("sheen" in o.material) o.material.sheen = 0.0;

  o.material.needsUpdate = true;

  console.log("🥣 Food_Bowl highlight reduced:", o.name);
}

if (!grimReaperRef && nn === "grim_reaper") {
  grimReaperRef = o;

  grimReaperRef.visible = false;
  grimReaperRef.castShadow = false;
  grimReaperRef.receiveShadow = false;
  grimReaperRef.raycast = () => null;

  console.log("☠️ Grim_reaper permanently hidden (New Materials):", o.name, "| material:", o.material?.name);
}

      // raycast layer
      o.layers.enable(LAYER_WORLD);

      // ensure uv2 exists for AO maps
      if (o.geometry && o.geometry.attributes.uv && !o.geometry.attributes.uv2) {
        o.geometry.setAttribute("uv2", o.geometry.attributes.uv);
      }

      // ✅ MATERIAL ASSIGN (same matching style you use in Main GLB)
      const originalMatName = o.material?.name;
      const keysToTry = [
        o.name,
        o.parent?.name,
        originalMatName,
        o.parent?.parent?.name,
      ].filter(Boolean);

      let mat = null;
      for (const k of keysToTry) {
        if (materials[k]) { mat = materials[k]; break; }
      }

      // only override if you have a defined material for it
      if (mat) o.material = mat;

      // consistent shadow settings
      o.castShadow = true;
      o.receiveShadow = true;

      // global IBL control (matches your style)
      if (o.material && "envMapIntensity" in o.material) {
        o.material.envMapIntensity = 0.02;
      }

      o.material?.needsUpdate && (o.material.needsUpdate = true);
    });

    extra.updateMatrixWorld(true);
    
    extra.traverse((o) => {
      if (!o.isMesh) return;
    console.log("🧩 NEW GLB -> mesh:", o.name, "| material:", o.material?.name);
});

    console.log("✅ New Materials GLB loaded:", extra);
  },
  undefined,
  (err) => {
    console.error("New Materials GLB failed to load ❌", err);
    __endNewMaterials(); // ✅ don't hang loader
  }
);

const __endCigaretteGLB = __beginAsset("Cigarette Smoke GLB");

console.log("🚬 ABOUT TO START cigaretteLoader.load", "./assets/models/cigarette_smoke4.glb?v=4");

cigaretteLoader.load(
  "./assets/models/cigarette_smoke4.glb?v=4",
  (gltf) => {
    console.log("✅ cigarette GLB SUCCESS callback entered");
    __endCigaretteGLB();

    cigaretteRoot = gltf.scene;
    anchor.add(cigaretteRoot);

    cigaretteRoot.traverse((o) => {
      if (!o.isMesh) return;

      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.layers.enable(LAYER_WORLD);

      if (o.geometry && o.geometry.attributes.uv && !o.geometry.attributes.uv2) {
        o.geometry.setAttribute("uv2", o.geometry.attributes.uv);
      }

      const objName = (o.name || "").toLowerCase();
      const parentName = (o.parent?.name || "").toLowerCase();

      if (!cigaretteMeshRef) cigaretteMeshRef = o;

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const newMats = [];

      for (let i = 0; i < mats.length; i++) {
  const mat = mats[i];
  const matName = (mat?.name || "").toLowerCase();

  console.log("[CIG SLOT]", {
    object: o.name,
    parent: o.parent?.name,
    material: mat?.name || "(no material name)",
    slot: i
  });

  // EMBER
  if (
    matName.includes("ember") ||
    matName.includes("tip") ||
    objName.includes("ember") ||
    objName.includes("tip") ||
    parentName.includes("ember") ||
    parentName.includes("tip")
  ) {
    const m = cigaretteEmberMat.clone();
    m.name = "cigaretteEmberMat";
    newMats.push(m);

    emberTipRef = o;
    emberTipMatRef = m;
    emberTipMatIndex = i;

    console.log("🔥 EMBER material captured:", {
      object: o.name,
      slot: i,
      material: mat?.name
    });

    continue;
  }

// ASH
if (matName.includes("ash")) {
  const m = cigaretteAshMat.clone();
  m.name = "cigaretteAshMat";
  newMats.push(m);

  ashMatRef = m;
  ashMeshRef = o;

  console.log("🔥 ASH material captured:", {
    object: o.name,
    material: mat?.name
  });

  continue;
}

        // FILTER
        if (
          matName.includes("filter") ||
          objName.includes("filter") ||
          parentName.includes("filter")
        ) {
          const m = cigaretteFilterMat.clone();
          m.name = "cigaretteFilterMat";
          newMats.push(m);
          continue;
        }

        // TOBACCO
        if (
          matName.includes("tobacco") ||
          objName.includes("tobacco") ||
          parentName.includes("tobacco")
        ) {
          const m = cigaretteTobaccoMat.clone();
          m.name = "cigaretteTobaccoMat";
          newMats.push(m);
          continue;
        }

        newMats.push(mat);
      }

      o.material = Array.isArray(o.material) ? newMats : newMats[0];

      if (Array.isArray(o.material)) {
        o.material.forEach((m) => {
          if (m) m.needsUpdate = true;
        });
      } else if (o.material) {
        o.material.needsUpdate = true;
      }
    });

    console.log("======== CIGARETTE GLB DUMP ========");

    cigaretteRoot.traverse((o) => {
      if (!o.isMesh) return;

      const mats = Array.isArray(o.material) ? o.material : [o.material];

      mats.forEach((m, i) => {
        console.log("[CIG DUMP]", {
          object: o.name,
          slot: i,
          material: m?.name || "(no material name)"
        });
      });
    });

if (emberTipRef && !emberLightRef) {
  emberLightRef = new THREE.PointLight(0xff2a12, 2.1, 0.34, 1.8);
  emberLightRef.castShadow = false;
  emberTipRef.add(emberLightRef);

  // push slightly into the cigarette body
  emberLightRef.position.set(0.0, 0.0, 0.022);

  console.log("🔥 ember light created on:", emberTipRef.name);
}

if (emberTipRef && !emberHaloRef) {
emberHaloMatRef = new THREE.SpriteMaterial({
  map: emberHaloTex,
  color: 0xb11800,
  transparent: true,
  opacity: 0.13,
  depthWrite: false,
  depthTest: true,
  blending: THREE.AdditiveBlending,
  toneMapped: false,
});

  emberHaloRef = new THREE.Sprite(emberHaloMatRef);
  emberTipRef.add(emberHaloRef);

  emberHaloRef.position.set(0.0, 0.0, 0.010);
emberHaloRef.scale.set(0.032, 0.018, 1.0);

  console.log("🔥 ember halo sprite created on:", emberTipRef.name);
}

    cigaretteRoot.updateMatrixWorld(true);

if (gltf.animations && gltf.animations.length > 0) {
  cigaretteMixer = new THREE.AnimationMixer(cigaretteRoot);
  cigaretteActions = [];

  console.log("🚬 all cigarette clips:", gltf.animations.map(a => ({
    name: a.name,
    duration: a.duration
  })));

  for (const clip of gltf.animations) {
  const action = cigaretteMixer.clipAction(clip);

  action.enabled = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;

  action.reset();
  action.time = CIG_START_TIME;
  action.paused = true;

  cigaretteActions.push(action);
}

  cigaretteMixer.update(0);

  console.log("✅ cigarette animation actions ready:", cigaretteActions.map(a => a.getClip().name));

} else {
  console.warn("⚠️ No cigarette animations found in cigarette_smoke.glb");
}


//attachSmokeTipToCigarette();
    console.log("✅ cigarette_smoke.glb loaded");
  },
  undefined,
  (err) => {
    console.error("❌ cigarette_smoke.glb failed to load:", err);
    __endCigaretteGLB();
  }
);

const __endSmokeTipGLB = __beginAsset("Smoke Tip GLB");

console.log("💨 ABOUT TO START smokeTipLoader.load", "./assets/models/Smoke_tip2.glb");

smokeTipLoader.load(
  "./assets/models/Smoke_tip2.glb",
  (gltf) => {
    console.log("✅ Smoke_tip2.glb SUCCESS callback entered");
    __endSmokeTipGLB();

    smokeTipRoot = gltf.scene;
    smokeTipRoot.name = "SmokeTipRoot";

    // add it to the scene
    anchor.add(smokeTipRoot);

   // reset transform (we will position it relative to cigarette)
smokeTipRoot.position.set(0, 0, 0);
smokeTipRoot.rotation.set(0, 0, 0);
smokeTipRoot.scale.set(1, 1, 1);
    smokeTipRoot.updateMatrixWorld(true);

    console.log("======== SMOKE TIP GLB DUMP ========");

    smokeTipRoot.traverse((o) => {
      if (!o.isMesh) return;

      console.log("[SMOKE TIP MESH]", {
        object: o.name,
        material: o.material?.name || "(no material)",
        parent: o.parent?.name || "(no parent)"
      });

      const objName = (o.name || "").toLowerCase();
      const matName = (o.material?.name || "").toLowerCase();

      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;

      if (
        !smokeTipMeshRef &&
        (
          objName.includes("smoke_tip2") ||
          objName.includes("smoketip2") ||
          matName.includes("smoke_tip2") ||
          matName.includes("smoketip2")
        )
      ) {
        smokeTipMeshRef = o;
        console.log("💨 smokeTipMeshRef CAPTURED:", {
          object: o.name,
          material: o.material?.name
        });
      }

            // keep original Smoke_tip2 material
      if (o.material) {
        o.material.needsUpdate = true;
      }
    });

    console.log("✅ Smoke_tip2.glb added to scene:", smokeTipRoot);

if (!smokeTipMeshRef) {
  console.warn("❌ smokeTipMeshRef missing, cannot place smoke emitter");
} else {
  if (!smokeEmitterAnchor) {
    smokeEmitterAnchor = new THREE.Object3D();
    smokeEmitterAnchor.name = "SmokeEmitterAnchor";

    // ✅ parent to the Smoke_tip mesh
    smokeTipMeshRef.add(smokeEmitterAnchor);
  }

  // ✅ MANUAL emitter placement relative to Smoke_tip mesh
  // These numbers are now the ONLY thing you tweak
smokeEmitterAnchor.position.copy(SMOKE_EMITTER_LOCAL_OFFSET);

 smokeEmitterAnchor.updateMatrixWorld(true);

if (cigaretteSmokePoints) {
  smokeEmitterAnchor.getWorldPosition(smokeSourceWorld);
smokeSourceWorld.y += 0.15; // 🔥 same offset
cigaretteSmokePoints.position.copy(smokeSourceWorld);
  resetAllSmokeParticlesToEmitter();
}

  smokeEmitterRef = smokeEmitterAnchor;

  // debug sphere
  const oldDbg = smokeEmitterAnchor.getObjectByName("SmokeEmitterDebug");
  if (oldDbg) oldDbg.removeFromParent();

  const smokeEmitterDebug = new THREE.Mesh(
    new THREE.SphereGeometry(0.03, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      depthTest: false,
      depthWrite: false
    })
  );
  smokeEmitterDebug.name = "SmokeEmitterDebug";
  smokeEmitterAnchor.add(smokeEmitterDebug);
  
  smokeEmitterDebug.position.set(0, 0, 0);
  smokeEmitterDebug.renderOrder = 9999;

  smokeEmitterDebug.visible = false; // 🔥 hides the blue dot but keeps everything working

  smokeEmitterAnchor.updateMatrixWorld(true);

  const dbgWorld = new THREE.Vector3();
  smokeEmitterAnchor.getWorldPosition(dbgWorld);
  console.log("✅ smoke emitter placed manually on smokeTipMeshRef", dbgWorld);

 cigaretteSmokeBuilt = false;
cigaretteSmokeStarted = false;
cigaretteSmokeTimerArmed = false;
cigaretteSmokeStartTime = 0;
}

if (gltf.animations && gltf.animations.length > 0) {
  smokeTipMixer = new THREE.AnimationMixer(smokeTipRoot);
  smokeTipActions = [];

  console.log("💨 all smoke tip clips:", gltf.animations.map(a => ({
    name: a.name,
    duration: a.duration
  })));

  for (const clip of gltf.animations) {
    const action = smokeTipMixer.clipAction(clip);

    action.enabled = true;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;

    action.reset();
    action.time = SMOKE_TIP_START_TIME;
    action.paused = true;

    smokeTipActions.push(action);
  }

  smokeTipMixer.update(0);

  console.log(
    "✅ smoke tip animation actions ready:",
    smokeTipActions.map(a => a.getClip().name)
  );
} else {
  console.warn("⚠️ No animations found in Smoke_tip2.glb");
}

  },
  undefined,
  (err) => {
    console.error("❌ Smoke_tip2.glb failed to load:", err);
    __endSmokeTipGLB();
  }
);

// ============================================================
// ✅ GLOBAL LOOK CONTROL (mood / overall darkness)
// ============================================================
const LOOK = {
  exposure: 0.9, // try 0.88–0.98
};

function setupWorldSmokeDebug() {
  if (smokeDebugRoot) return;

  if (!camera) {
    console.warn("setupWorldSmokeDebug: camera missing");
    return;
  }

  smokeDebugRoot = new THREE.Group();
  smokeDebugRoot.name = "CameraSmokeDebugRoot";

  // attach directly to camera so it is ALWAYS visible
  camera.add(smokeDebugRoot);

  // place it directly in front of the camera
  smokeDebugRoot.position.set(0, 0, -2.0);

  // big green box
  smokeDebugBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.6, 0.6),
    new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      depthTest: false,
      depthWrite: false
    })
  );
  smokeDebugRoot.add(smokeDebugBox);

  // red sphere above it
  smokeDebugSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 24, 24),
    new THREE.MeshBasicMaterial({
      color: 0xff0000,
      depthTest: false,
      depthWrite: false
    })
  );
  smokeDebugSphere.position.set(0, 0.75, 0);
  smokeDebugRoot.add(smokeDebugSphere);

  buildCigaretteSmoke(smokeDebugRoot);

  if (cigaretteSmokePoints) {
    cigaretteSmokePoints.position.copy(smokeDebugSphere.position);
  }

  console.log("✅ CAMERA smoke debug rig created", {
    smokeDebugRoot,
    smokeDebugBox,
    smokeDebugSphere,
    cigaretteSmokePoints
  });
}

function updatePointerNdcFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();

  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function tryBeginWallDraw(e) {
  if (!drawMode || !wallDrawPlaneRef) return false;

  updatePointerNdcFromEvent(e);

  raycaster.setFromCamera(pointer, camera);
  wallDrawRaycastHits.length = 0;
  raycaster.intersectObject(wallDrawPlaneRef, false, wallDrawRaycastHits);

  if (!wallDrawRaycastHits.length) return false;

  const hit = wallDrawRaycastHits[0];
  if (!hit.uv) return false;

  wallDrawUv.copy(hit.uv);
  lastWallDrawUv.copy(hit.uv);
  hasLastWallDrawUv = true;
  isWallDrawing = true;

  drawOnWallAtUV(hit.uv);
  return true;
}

function continueWallDraw(e) {
  if (!drawMode || !isWallDrawing || !wallDrawPlaneRef) return false;

  updatePointerNdcFromEvent(e);

  raycaster.setFromCamera(pointer, camera);
  wallDrawRaycastHits.length = 0;
  raycaster.intersectObject(wallDrawPlaneRef, false, wallDrawRaycastHits);

  if (!wallDrawRaycastHits.length) return false;

  const hit = wallDrawRaycastHits[0];
  if (!hit.uv) return false;

  wallDrawUv.copy(hit.uv);

  if (hasLastWallDrawUv) {
    drawWallLineUV(lastWallDrawUv, wallDrawUv);
  } else {
    drawOnWallAtUV(wallDrawUv);
  }

  lastWallDrawUv.copy(wallDrawUv);
  hasLastWallDrawUv = true;

  return true;
}

function endWallDraw() {
  isWallDrawing = false;
  hasLastWallDrawUv = false;
}

//ANIMATE
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();

  const blocked = isIOSPortraitBlocked();

if (bugMixer) bugMixer.update(dt);

if (cigaretteMixer) cigaretteMixer.update(dt);
if (smokeTipMixer) smokeTipMixer.update(dt);

if (
  !blocked &&
  smokeEmitterRef &&
  !cigaretteSmokeTimerArmed
) {
  cigaretteSmokeStartTime = performance.now() * 0.001;
  cigaretteSmokeTimerArmed = true;

  console.log("🚬 smoke timer armed at scene entry");
}

if (!blocked) {
  updateTv();
  updateLampFlicker();
  updateDust(dt);
  updateGlow();
  updatePress();
  updateCigaretteEmber();
  updateCigaretteSmoke(dt);
}

 // ✅ Throttle TV redraw so it doesn't hammer performance
if (!window.__tvRedrawAcc) window.__tvRedrawAcc = 0;
window.__tvRedrawAcc += dt;

if (!blocked && tvOn && tvScreenMatRef && window.__tvRedrawAcc > (1 / 12)) {
  window.__tvRedrawAcc = 0;

  if (tvUiState === "MENU") {
    drawTvMenu();
  } 
  else if (tvUiState === "PHOTO") {
    if (!photoImage && !photoLoading) loadPhotoAt(photoIndex);
    if (photoImage) drawPhotoToTv(photoImage);
  }
 else if (tvUiState === "VIDEO") {
  // ✅ if user fullscreened the overlay video, freeze TV screen (no redraws)
  if (videoReady && !tvVideoSuppressed) drawVideoFrameToTv();
}
else if (tvUiState === "3D MODEL") {
  if (modelReady && !tvModelSuppressed) drawModelToTv();
}
}

renderer.setScissorTest(false);
renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);

const useNightVisionFX =
  nightVisionOn &&
  composer &&
  nightVisionPass &&
  (MOBILE_PROFILE.postFX || isIOSDevice());

// ============================================================
// ✅ FORCE TONEMAP + EXPOSURE RIGHT BEFORE RENDER
// (prevents "it does nothing" from overrides or composer passes)
// ============================================================
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // exposure works with this
renderer.toneMappingExposure = LOOK.exposure;

if (useNightVisionFX) {
  updateNightVisionAutoGain(dt);
  nightVisionPass.uniforms.uTime.value = performance.now() * 0.001;
  composer.render();
} else {
  renderer.render(scene, camera);
}

}
animate();

// ============================================================
// GRAIN ANIMATION STYLE ✅ PASTE HERE
// (Right after animate(); and before RESIZE listener)
// ============================================================
const grainStyle = document.createElement("style");

grainStyle.innerHTML = `
@keyframes grainBgMove {
  0%   { background-position: 0px 0px; }
  10%  { background-position: -40px -80px; }
  20%  { background-position: -120px 30px; }
  30%  { background-position: 50px -160px; }
  40%  { background-position: -30px 180px; }
  50%  { background-position: -140px 90px; }
  60%  { background-position: 160px 20px; }
  70%  { background-position: 0px 140px; }
  80%  { background-position: 40px 240px; }
  90%  { background-position: -110px 110px; }
  100% { background-position: 0px 0px; }
}
`;

document.head.appendChild(grainStyle);

// ✅ track the *actual* render size used by renderer.setSize()
let renderW = window.innerWidth;
let renderH = window.innerHeight;


function handleResize() {
  if (!renderer || !renderer.domElement) return;
  if (!camera) return;

  const vv = window.visualViewport;
  const w = Math.round(vv?.width  ?? window.innerWidth);
  const h = Math.round(vv?.height ?? window.innerHeight);

  renderW = w;
  renderH = h;

  const aspect = w / h;

  const dpr = window.devicePixelRatio || 1;
  const maxDpr = isIOS ? 2.0 : 2.0;
  renderer.setPixelRatio(Math.min(dpr, maxDpr));
  renderer.setSize(w, h, true);

  viewX = 0;
  viewY = 0;
  viewW = w;
  viewH = h;

  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  if (composer) composer.setSize(w, h);
  if (nightVisionPass?.uniforms?.uResolution?.value) {
    nightVisionPass.uniforms.uResolution.value.set(w, h);
  }
}

// ============================================================
// ✅ SMART RESIZE WRAPPER (prevents iOS framing shift)
// ============================================================
let __resizeRaf = 0;

function scheduleResize() {
  cancelAnimationFrame(__resizeRaf);

  __resizeRaf = requestAnimationFrame(() => {
    handleResize();

    // iOS Safari often needs a second pass after address bar settles
    if (isIOSDevice()) {
      setTimeout(handleResize, 120);
    }
  });
}

 renderer.domElement.addEventListener("pointerdown", (e) => {
  const usedWallDraw = tryBeginWallDraw(e);
  if (usedWallDraw) return;
});

renderer.domElement.addEventListener("pointermove", (e) => {
  const usedWallDraw = continueWallDraw(e);
  if (usedWallDraw) return;
});

window.addEventListener("pointerup", () => {
  endWallDraw();
});

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;

  if (e.key === "e" || e.key === "E") {
    toggleWallTool();
    return;
  }

  if (e.key === "c" || e.key === "C") {
    cycleWallMarkerColor();
    return;
  }
});

renderer.domElement.addEventListener("dblclick", () => {
  clearWallDrawing();
  endWallDraw();
});

window.addEventListener("resize", scheduleResize);
window.addEventListener("orientationchange", scheduleResize);

if (window.visualViewport) {
  const vv = window.visualViewport;
  vv.addEventListener("resize", scheduleResize);
  vv.addEventListener("scroll", scheduleResize);
}


// ✅ Run initial resize only when renderer + camera exist
(function initResizeWhenReady() {
  if (renderer && renderer.domElement && camera) {
    scheduleResize();
  } else {
    requestAnimationFrame(initResizeWhenReady);
  }
})();
