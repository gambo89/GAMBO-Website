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

const DESIGN_W = 1920;
const DESIGN_H = 1080;
const DESIGN_ASPECT = DESIGN_W / DESIGN_H;

const BASE_ASPECT = DESIGN_ASPECT;
let baseFovDeg = 0;          // ✅ numeric default
let baseFovCaptured = false; // ✅ add this

// current viewport inside the full canvas
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

// renderer settings...
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = isIOS ? 0.75 : 0.8;
renderer.physicallyCorrectLights = true;

renderer.shadowMap.enabled = MOBILE_PROFILE.shadows;
renderer.shadowMap.type = isIOS
  ? THREE.PCFShadowMap
  : THREE.PCFSoftShadowMap;

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
// ✅ DEBUG: If anything crashes, show it on the loader instead of 0% forever
// ============================================================
window.addEventListener("error", (e) => {
  console.error("💥 Uncaught error:", e.error || e.message);
  if (loaderTextEl) loaderTextEl.textContent = "ERROR (check console)";
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("💥 Unhandled promise rejection:", e.reason);
  if (loaderTextEl) loaderTextEl.textContent = "ERROR (check console)";
});


let composer = null;
let nightVisionPass = null;
let screenBreathPass = null; // ✅ NEW (breathing without camera movement)
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

function setNightVision(on) {
  nightVisionOn = on;

  if (nightVisionPass) nightVisionPass.uniforms.uOn.value = on ? 1 : 0;

  if (on) {
  baseExposure = renderer.toneMappingExposure;

  aeGain = 1.45;
aeSampleAccum = 0;
if (nightVisionPass) nightVisionPass.uniforms.uGain.value = aeGain;

  // ✅ less “neon lift”, more contrast like your reference
  renderer.toneMappingExposure = 1.10;
  hemi.intensity = 0.06;
} else {
  renderer.toneMappingExposure = baseExposure ?? 0.8;
  hemi.intensity = 0.0;
}

  // ✅ VHS grain overlay: stronger during NV
  if (typeof grainOverlay !== "undefined") {
    grainOverlay.style.opacity = on ? "0.06" : "0.015";
    grainOverlay.style.filter = on
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


if (MOBILE_PROFILE.postFX) {
  initPostFX();
} else {
  composer = null;
  nightVisionPass = null;
}


// ============================================================
// SUBTLE "FIRST PERSON" BREATHING CAMERA MOTION ✅
// (translation only — no rotation = no nausea)
// ============================================================
let baseCamPos = null; // will be set after you position the camera

// ============================================================
// CALM BREATHING PRESET ✅ (slow + grounded)
// ============================================================
const BREATH = {
  speed: 0.07,   // ⬅️ very slow breathing (~8–9 sec per cycle)
  yAmp: 0.0014,  // ⬅️ softer vertical motion
  zAmp: 0.0006,  // ⬅️ barely perceptible sway
  xAmp: 0.00025, // ⬅️ subtle body drift
};

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

// ============================================================
// CAMERA BREATHING UPDATE ✅
// ============================================================
function updateBreathing() {
  // wait until we have a base position saved
  if (!baseCamPos) return;

  const t = performance.now() * 0.001;

  // main breath (sin wave)
  const b = Math.sin(t * Math.PI * 2 * BREATH.speed);

  // slower posture sway so it doesn't feel like a loop
  const s = Math.sin(t * 0.55);

  // ✅ scale by room size so it stays subtle in any scene
  const scale = Math.max(0.15, roomMaxDim);

  const y = b * BREATH.yAmp * scale;
  const z = b * BREATH.zAmp * scale;
  const x = s * BREATH.xAmp * scale;

  camera.position.set(
    baseCamPos.x + x,
    baseCamPos.y + y,
    baseCamPos.z + z
  );
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

const GLOW_LERP_IN  = 0.22; // normal fade in
const GLOW_LERP_OUT = 0.22; // normal fade out (non-power)
const POWER_GLOW_LERP_OUT = 0.45; // faster power fade out
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

  // smooth transition (power fades out faster)
const isPower = st.color.equals(POWER_GLOW_COLOR);

let lerpSpeed;

if (st.target > st.t) {
  // fading IN
  lerpSpeed = GLOW_LERP_IN;
} else {
  // fading OUT
  lerpSpeed = isPower ? POWER_GLOW_LERP_OUT : GLOW_LERP_OUT;
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

tvHint.innerText = "click to view fullscreen";

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
const HINT_AUTOHIDE_MS = 2000;

let currentHoverKey = null;     // "tv" | "speaker" | "power" | "ok" | "up" | "down" | "left" | "right" | null
let hintTimeoutId = null;

// If a hint timed-out while still hovering, we suppress it until user leaves that hover target
const hintSuppressed = {
  tv: false,
  speaker: false,
  power: false,
  ok: false,
  up: false,
  down: false,
  left: false,
  right: false,
};

function hideAllHintsImmediate() {
  showTvHint(false);
  showSpeakerHint(false);
  showPowerHint(false);
  hideRemoteHints();
}

function showHintForKey(key) {
  // Always show ONLY ONE hint at a time
  hideAllHintsImmediate();

  if (key === "speaker") {
    updateSpeakerHintText();
    showSpeakerHint(true);
    return;
  }

  if (key === "power") {
    updatePowerHintText();
    showPowerHint(true);
    return;
  }

  if (key === "tv") {
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
// SUBTLE ROOM GRAIN / NOISE OVERLAY (FIXED data-url) ✅
// ============================================================
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


function applyLampMood(mode) {
  if (!nightLights) return;

  // pick palettes
  const warm = {
    lamp: 0xffe2c6,
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


const photoOverlay = document.createElement("div");
photoOverlay.style.position = "fixed";
photoOverlay.style.left = "0";
photoOverlay.style.top = "0";
photoOverlay.style.width = "100vw";
photoOverlay.style.height = "100vh";
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
photoOverlayImg.style.maxHeight = "96vh";
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
videoOverlay.style.width = "100vw";
videoOverlay.style.height = "100vh";
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
videoOverlayEl.style.maxHeight = "96vh";
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
modelOverlay.style.width = "100vw";
modelOverlay.style.height = "100vh";
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

// ============================================================
// TV "MENU" BUTTON (top-right in PHOTO mode)
// ============================================================
const TV_MENU_BTN = {
  pad: 36,   // padding from edges (in TV canvas pixels)
  w: 220,    // button width
  h: 86,     // button height
};

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

  // ------------------------------------------------------------
  // ✅ MENU button (top-right) when in PHOTO mode
  // ------------------------------------------------------------
 if (tvOn && (tvUiState === "PHOTO" || tvUiState === "3D MODEL")) {
    const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
    const by = TV_MENU_BTN.pad;

    // background
tvCtx.save();

if (menuHover) {
  // ✅ hover glow
  tvCtx.globalAlpha = 0.9;
  tvCtx.fillStyle = "#222";

  tvCtx.shadowColor = "rgba(255,255,255,0.5)";
  tvCtx.shadowBlur = 25;
} else {
  tvCtx.globalAlpha = 0.65;
  tvCtx.fillStyle = "#000";
}

roundRect(tvCtx, bx, by, TV_MENU_BTN.w, TV_MENU_BTN.h, 18);
tvCtx.fill();

tvCtx.restore();


    // border
    tvCtx.save();
    tvCtx.globalAlpha = 0.35;
    tvCtx.strokeStyle = "#fff";
    tvCtx.lineWidth = 3;
    roundRect(tvCtx, bx, by, TV_MENU_BTN.w, TV_MENU_BTN.h, 18);
    tvCtx.stroke();
    tvCtx.restore();

    // text
    tvCtx.save();
    tvCtx.fillStyle = "#fff";
    tvCtx.globalAlpha = 0.92;
    tvCtx.font = "bold 46px Arial";
    tvCtx.textAlign = "center";
    tvCtx.textBaseline = "middle";
    tvCtx.fillText("MENU", bx + TV_MENU_BTN.w * 0.5, by + TV_MENU_BTN.h * 0.52);
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
  "./assets/Video/02-sweet93-chopped.mp4",
  "./assets/Video/03-sweet93-snow.mp4",
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

  // ------------------------------------------------------------
  // ✅ MENU button (top-right) when in VIDEO mode
  // ------------------------------------------------------------
  if (tvOn && tvUiState === "VIDEO") {
    const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
    const by = TV_MENU_BTN.pad;

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

    roundRect(tvCtx, bx, by, TV_MENU_BTN.w, TV_MENU_BTN.h, 18);
    tvCtx.fill();
    tvCtx.restore();

    // border
    tvCtx.save();
    tvCtx.globalAlpha = 0.35;
    tvCtx.strokeStyle = "#fff";
    tvCtx.lineWidth = 3;
    roundRect(tvCtx, bx, by, TV_MENU_BTN.w, TV_MENU_BTN.h, 18);
    tvCtx.stroke();
    tvCtx.restore();

    // text
    tvCtx.save();
    tvCtx.fillStyle = "#fff";
    tvCtx.globalAlpha = 0.92;
    tvCtx.font = "bold 46px Arial";
    tvCtx.textAlign = "center";
    tvCtx.textBaseline = "middle";
    tvCtx.fillText("MENU", bx + TV_MENU_BTN.w * 0.5, by + TV_MENU_BTN.h * 0.52);
    tvCtx.restore();
  }

  // ------------------------------------------------------------
  // ✅ Optional “paused” overlay
  // ------------------------------------------------------------
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
  "./assets/3D Model/05-website.jpg",
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
    const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
    const by = TV_MENU_BTN.pad;

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

    roundRect(tvCtx, bx, by, TV_MENU_BTN.w, TV_MENU_BTN.h, 18);
    tvCtx.fill();
    tvCtx.restore();

    tvCtx.save();
    tvCtx.globalAlpha = 0.35;
    tvCtx.strokeStyle = "#fff";
    tvCtx.lineWidth = 3;
    roundRect(tvCtx, bx, by, TV_MENU_BTN.w, TV_MENU_BTN.h, 18);
    tvCtx.stroke();
    tvCtx.restore();

    tvCtx.save();
    tvCtx.fillStyle = "#fff";
    tvCtx.globalAlpha = 0.92;
    tvCtx.font = "bold 46px Arial";
    tvCtx.textAlign = "center";
    tvCtx.textBaseline = "middle";
    tvCtx.fillText("MENU", bx + TV_MENU_BTN.w * 0.5, by + TV_MENU_BTN.h * 0.52);
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

    // ✅ DEBUG TAP DOT (shows where the click mapped onto the TV canvas)
  if (tvTapDebug.on) {
    const age = (performance.now() - tvTapDebug.t) / 1000;
    if (age < 1.0) {
      tvCtx.save();
      tvCtx.globalAlpha = 1.0 - age; // fade out
      tvCtx.beginPath();
      tvCtx.arc(tvTapDebug.x, tvTapDebug.y, 14, 0, Math.PI * 2);
      tvCtx.fillStyle = "#ff2a2a";
      tvCtx.fill();
      tvCtx.restore();
    } else {
      tvTapDebug.on = false;
    }
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
  "./assets/Audio/01-dunkelheit-02.mp3",
  "./assets/Audio/02-rip-fredo-notice-me-01.mp3",
  "./assets/Audio/03-floor-555-01.mp3",
  "./assets/Audio/04-12r-01.mp3",
  "./assets/Audio/05-leave-everything-01.mp3",
  "./assets/Audio/06-27-title-flight-01.mp3",
  "./assets/Audio/07-nwo-ministry-01.mp3",
  "./assets/Audio/08-bline-01.mp3",
  "./assets/Audio/09-centaurella-44-01.mp3",
  "./assets/Audio/10-under-the-same-name-01.mp3",
  "./assets/Audio/11-a-sad-cartoon-01.mp3", 
  "./assets/Audio/12-one-weak-01.mp3",
  "./assets/Audio/13-xo-01.mp3",
  "./assets/Audio/14-min-dag-01.mp3",
  "./assets/Audio/15-frosting-01.mp3",
  "./assets/Audio/16-relay-01.mp3",
  "./assets/Audio/17-pistol-01.mp3",
  "./assets/Audio/18-widowdusk-01.mp3",
  "./assets/Audio/19-letters-to-frances-01.mp3",
];

let trackIndex = 0;
let isPlaying = false;

// 🔓 ADD THIS BLOCK RIGHT HERE
let audioUnlocked = false;

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
    console.log("🔓 Audio unlocked");
  } catch (e) {
    console.warn("Audio unlock failed:", e);
    audioUnlocked = false;
  }
}

// Unlock on first real user gesture
window.addEventListener("pointerdown", unlockAudioOnce, { once: true });
window.addEventListener("touchstart", unlockAudioOnce, { once: true });

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

function pauseAll() {
  for (const a of audioEls) {
    a.pause();
    a.currentTime = 0;
  }
  isPlaying = false;
}

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

  // ✅ start boot animation
  tvBootT0 = performance.now();
  tvBooting = true;

  drawTvMenu();
}


  tvAnim = { from, to, t0: performance.now() / 1000 };

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

// ------------------------------------------------------------
// CLICK / DOUBLE-CLICK HANDLER (TV + SPEAKER)
// ------------------------------------------------------------
let lastClickTime = 0;
const DOUBLE_CLICK_MS = 280;

let pendingExternalUrl = null;

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

async function onPointerDown(e) {
  if (!setPointerFromEvent(e)) return; // ✅ ignore clicks in black bars
  raycaster.setFromCamera(pointer, camera);

let hits = [];
if (interactivesRootRef) {
  hits = raycaster.intersectObject(interactivesRootRef, true);
}
if (!hits.length) {
  hits = raycaster.intersectObject(anchor, true);
}
if (!hits.length) return;


if (overlayOpen || videoOverlayOpen || modelOverlayOpen) return;

  const hit = hits[0].object;
  const hitInfo = hits[0];

  // ✅ only toggle lamp + night vision when lamp is clicked
if (hitIsLamp(hit)) {
  lampMood = (lampMood + 1) % 2; // 0<->1
  applyLampMood(lampMood);
  setNightVision(lampMood === 1);
  return;
}

// ✅ DOG TAG click -> open playlist (Safari-safe: open on pointerup)
if (hitIsDogTag(hit)) {
  const url = "https://open.spotify.com/playlist/29St0Hbsl7aWEyq7LBV4O6";
  console.log("🏷️ Dog_Tag1 hit — queued for pointerup:", url);
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

// ✅ Board2 click -> open YouTube link (Safari-safe: open on pointerup)
if (hitIsBoard2(hit)) {
  const url = "https://www.youtube.com/watch?v=D8hMVPSTysU";
  console.log("📋 Board2 hit — queued for pointerup:", url);
  pendingExternalUrl = url;
  return;
}

  log("🖱️ HIT:", hit.name, "layer:", hit.layers.mask, "parent:", hit.parent?.name);
log("💡 lampMeshRef:", lampMeshRef?.name, "layer:", lampMeshRef?.layers?.mask);


   // ✅ Press animation target ON (only for the button you clicked)
if (powerButtonMeshRef && isInHierarchy(hit, powerButtonMeshRef)) {
  setPressAxisFromHit(powerButtonMeshRef, hitInfo);
  setPressTarget(powerButtonMeshRef, true);
}

if (okButtonMeshRef && isInHierarchy(hit, okButtonMeshRef)) {
  setPressAxisFromHit(okButtonMeshRef, hitInfo);
  setPressTarget(okButtonMeshRef, true);
}

if (upArrowMeshRef && isInHierarchy(hit, upArrowMeshRef)) {
  setPressAxisFromHit(upArrowMeshRef, hitInfo);
  setPressTarget(upArrowMeshRef, true);
}

if (downArrowMeshRef && isInHierarchy(hit, downArrowMeshRef)) {
  setPressAxisFromHit(downArrowMeshRef, hitInfo);
  setPressTarget(downArrowMeshRef, true);
}

if (leftArrowMeshRef && isInHierarchy(hit, leftArrowMeshRef)) {
  setPressAxisFromHit(leftArrowMeshRef, hitInfo);
  setPressTarget(leftArrowMeshRef, true);
}

if (rightArrowMeshRef && isInHierarchy(hit, rightArrowMeshRef)) {
  setPressAxisFromHit(rightArrowMeshRef, hitInfo);
  setPressTarget(rightArrowMeshRef, true);
}


// --------------------------------------------------
// TV SCREEN CLICK (PHOTO mode)
// 1) If they clicked the MENU button area -> go back to MENU
// 2) Otherwise -> fullscreen photo
// --------------------------------------------------
if (tvOn && tvUiState === "PHOTO" && tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) {

  const uv = hits[0].uv;
  if (!uv) {
    warn("❌ No UV on TV screen hit — MENU cannot be clicked until TV screen mesh has UVs.");
  }

  if (uv) {
    const w = tvCanvas.width;
    const h = tvCanvas.height;

    const u = uv.x * (tvTex.repeat?.x ?? 1) + (tvTex.offset?.x ?? 0);
    const v = uv.y * (tvTex.repeat?.y ?? 1) + (tvTex.offset?.y ?? 0);

    const px = u * w;
    const py = v * h;

    const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
    const by = TV_MENU_BTN.pad;

    const inMenuBtn =
      px >= bx && px <= bx + TV_MENU_BTN.w &&
      py >= by && py <= by + TV_MENU_BTN.h;

    if (inMenuBtn) {
      console.log("📺 MENU button clicked -> back to main menu");
      tvUiState = "MENU";
      blinkT0 = performance.now();
      drawTvMenu();
      return;
    }
  }

  console.log("🖥️📸 Fullscreen photo (single click)");
  openPhotoOverlay(currentPhotoUrl);
  return;
}

// --------------------------------------------------
// TV SCREEN CLICK (VIDEO mode)
// 1) If they clicked the MENU button area -> go back to MENU
// 2) Otherwise -> fullscreen video overlay
// --------------------------------------------------
if (tvOn && tvUiState === "VIDEO" && tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) {

  const uv = hits[0].uv;

  if (uv) {
    const w = tvCanvas.width;
    const h = tvCanvas.height;

    const u = uv.x * (tvTex.repeat?.x ?? 1) + (tvTex.offset?.x ?? 0);
    const v = uv.y * (tvTex.repeat?.y ?? 1) + (tvTex.offset?.y ?? 0);

    const px = u * w;
    const py = v * h;

    const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
    const by = TV_MENU_BTN.pad;

    const inMenuBtn =
      px >= bx && px <= bx + TV_MENU_BTN.w &&
      py >= by && py <= by + TV_MENU_BTN.h;

    if (inMenuBtn) {
      console.log("📺 MENU button clicked -> back to main menu");
      stopVideoCompletely();
      tvUiState = "MENU";
      blinkT0 = performance.now();
      drawTvMenu();
      return;
    }
  }

  console.log("🖥️🎬 Fullscreen video (single click)");
  openVideoOverlay();
  return;
}


  // --------------------------------------------------
  // TV POWER BUTTON
  // --------------------------------------------------
  if (powerButtonMeshRef && isInHierarchy(hit, powerButtonMeshRef)) {
    console.log("📺 TV Power pressed:", hit.name);
    setTvPower(!tvOn);
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
// TV SCREEN CLICK (3D MODEL mode)
// 1) MENU button -> back to MENU
// 2) Otherwise -> fullscreen model overlay
// --------------------------------------------------
if (tvOn && tvUiState === "3D MODEL" && tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) {

  const uv = hits[0].uv;

  if (uv) {
    const w = tvCanvas.width;
    const h = tvCanvas.height;

    const u = uv.x * (tvTex.repeat?.x ?? 1) + (tvTex.offset?.x ?? 0);
    const v = uv.y * (tvTex.repeat?.y ?? 1) + (tvTex.offset?.y ?? 0);

    const px = u * w;
    const py = v * h;

        // ✅ DEBUG: show where the tap landed on the TV canvas
    tvTapDebug.on = true;
    tvTapDebug.x = px;
    tvTapDebug.y = py;
    tvTapDebug.t = performance.now();

    const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
    const by = TV_MENU_BTN.pad;

    const inMenuBtn =
      px >= bx && px <= bx + TV_MENU_BTN.w &&
      py >= by && py <= by + TV_MENU_BTN.h;

    if (inMenuBtn) {
      console.log("📺 MENU button clicked -> back to main menu");
      stopModelCompletely();
      tvUiState = "MENU";
      blinkT0 = performance.now();
      drawTvMenu();
      return;
    }
  }

  console.log("🖥️🧩 Fullscreen 3D Model video (single click)");
  openModelOverlay();
  return;
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

renderer.domElement.addEventListener("pointerdown", onPointerDown);

window.addEventListener("pointerup", () => {
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
});

window.addEventListener("pointercancel", () => {
  clearAllButtonPresses();
});

// ============================================================
// HOVER DETECTION (TV fullscreen hint + Speaker play hint)
// ============================================================

renderer.domElement.addEventListener("pointermove", (e) => {
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


    if (!interactivesRootRef) {
  setHoverKey(null);
  clearAllButtonGlows(); // ✅ IMPORTANT
  return;
}

  const hits = raycaster.intersectObject(interactivesRootRef, true);

   if (!hits.length) {
  setHoverKey(null);
  clearAllButtonGlows(); // ✅ IMPORTANT
  return;
}


  const hit = hits[0].object;

  let hoveringTv = false;
  let hoveringSpeaker = false;
  let hoveringPower = false;
  let hoveringOk = false;
  let hoveringUp = false;
  let hoveringDown = false;
  let hoveringLeft = false;
  let hoveringRight = false;


if (tvOn && (tvUiState === "PHOTO" || tvUiState === "VIDEO" || tvUiState === "3D MODEL") && tvScreenMeshRef && isInHierarchy(hit, tvScreenMeshRef)) {
  hoveringTv = true;
}


  // ---------------------------------------------
// MENU hover detection (PHOTO mode)
// ---------------------------------------------
menuHover = false;

if (
  tvOn &&
  (tvUiState === "PHOTO" || tvUiState === "VIDEO" || tvUiState === "3D MODEL") &&
  tvScreenMeshRef &&
  isInHierarchy(hit, tvScreenMeshRef) &&
  hits[0].uv
) {

  const uv = hits[0].uv;

  const w = tvCanvas.width;
  const h = tvCanvas.height;

  const u = uv.x * (tvTex.repeat?.x ?? 1) + (tvTex.offset?.x ?? 0);
  const v = uv.y * (tvTex.repeat?.y ?? 1) + (tvTex.offset?.y ?? 0);

  const px = u * w;
  const py = v * h; // flipY=false fix

  const bx = w - TV_MENU_BTN.pad - TV_MENU_BTN.w;
  const by = TV_MENU_BTN.pad;

  if (
    px >= bx &&
    px <= bx + TV_MENU_BTN.w &&
    py >= by &&
    py <= by + TV_MENU_BTN.h
  ) {
    menuHover = true;
  }
}


  // Speaker hint (anytime speaker exists)
  if (speakerMeshRef && isInHierarchy(hit, speakerMeshRef)) {
    hoveringSpeaker = true;
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

  if (hoveringSpeaker) nextKey = "speaker";
  else if (hoveringPower) nextKey = "power";
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
    0xffe2c6,
    18,
    maxDim * 0.12,
    maxDim * 0.18
  );
  lampKey.position.set(maxDim * 0.30, maxDim * 0.02, maxDim * 0.18);
  lampKey.lookAt(maxDim * 0.05, maxDim * -0.10, 0);
  scene.add(lampKey);

  // --- shadow caster (warm spotlight) ---
  const lampShadow = new THREE.SpotLight(0xffe2c6, 220);
  lampShadow.position.copy(lampKey.position);
  lampShadow.target.position.set(maxDim * 0.05, maxDim * -0.12, 0);

  lampShadow.angle = Math.PI / 8;
  lampShadow.penumbra = 0.7;
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


  return { lampKey, lampShadow, rightPush, pinRight, tvFill, remoteBoost, skateAccent, underShelfUp, };
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
    aoMapIntensity: opts.aoIntensity ?? 2.5,

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
    normal: "./assets/Textures/TV Box/TV Box Normal.jpg"
    },
    { roughness: 0.5, metalness: 0.0}
),

TV_stand: makePBR({
    albedo: "./assets/Textures/TV Stand/TV Stand Albeto.jpg",
    normal: "./assets/Textures/TV Stand/TV Stand Normal.jpg",
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

  //CIGARETTES
  Cig1: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig1 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig2: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig2 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig3: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig3 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig4: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig4 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig5: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig5 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig6: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig6 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig7: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig7 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig8: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig8 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig9: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig9 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig10: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig10 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig11: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig11 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig12: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig12 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

 Cig13: makePBR({
    albedo: "./assets/Textures/Cigarettes/Cig13 Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

    //WALLS & Door
  front_wall1: makePBR(
    {
      albedo: "./assets/Textures/Walls/Front Wall/Front Wall10 Albedo.jpg",
      //normal: "./assets/Textures/Walls/Front Wall/Front Wall Normal.jpg",
      //ao: "./assets/Textures/Walls/Front Wall/Front Wall AO.jpg",
    },
    { metalness: 0.0, roughness: 2.0 }
  ),

  Left_wall1: makePBR(
    {
      albedo: "./assets/Textures/Walls/Left Wall/Left Wall Albeto.jpg",
      normal: "./assets/Textures/Walls/Left Wall/Left Wall Normal.jpg",
      ao: "./assets/Textures/Walls/Left Wall/Left Wall AO.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

  Floor1: makePBR(
    {
      albedo: "./assets/Textures/Floor/Floor Albedo2.jpg",
      normal: "./assets/Textures/Floor/Floor Normal1.jpg",
      ao: "./assets/Textures/Floor/Floor AO.jpg",
    },
    { metalness: 0.0, roughness: 0.0 }
  ),

Door4: (() => {
  const m = makePBR(
    {
      albedo: "./assets/Textures/new door/New Door Albedo.jpg",
      normal: "./assets/Textures/new door/New Door Normal.jpg",
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
      albedo: "./assets/Textures/Mask/Mask Albeto.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

  Book4: makePBR(
    {
      albedo: "./assets/Textures/Books/Book2 Albeto.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

  Book3: makePBR(
    {
      albedo: "./assets/Textures/Books/Book1 Albeto.jpg",
    },
    { metalness: 0.0, roughness: 1.0 }
  ),

 AXE3: makePBR({
    albedo: "./assets/Textures/AXE/AXE Albeto.jpg",
    normal: "./assets/Textures/AXE/AXE Normal.jpg",
    },
    { roughness: 0.05, metalness: 0.0}
),

 Digi_Cam2: makePBR({
    albedo: "./assets/Textures/Digi Cam/Digi Cam Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Dunkeheit_Album: makePBR({
    albedo: "./assets/Textures/Dunkeheit Cover/Dunkeheit Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Sony_Handicam1: makePBR({
    albedo: "./assets/Textures/Sony Handicam/Sony Handicam Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Thailand_Box1: makePBR({
    albedo: "./assets/Textures/Thailand Box/Thailand Box Albeto.jpg",
    },
    { roughness: 0.0, metalness: 0.0}
),

 Headphones1: makePBR({
    albedo: "./assets/Textures/Headphones Albeto.jpg",
    },
    { roughness: 0.5, metalness: 0.0}
),

 Tank1: makePBR({
    albedo: "./assets/Textures/Tank/Tank Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

 cloth: makePBR({
    albedo: "./assets/Textures/Cloth/Cloth Albeto.jpg",
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
    albedo: "./assets/Textures/Dog Tag Necklace/Dog Tag Albeto.jpg",
    },
    { roughness: 0.2, metalness: 0.0}
),

Washer: makePBR({
    albedo: "./assets/Textures/Dog Tag Necklace/Washer Albeto.jpg",
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
    normal: "./assets/Textures/Cartridges/Cartridges Normal.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Bed1: makePBR({
    albedo: "./assets/Textures/Bed/Bed Albedo.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Frame: makePBR({
    albedo: "./assets/Textures/Frame/Frame Albedo.jpg",
 
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
      albedo: "./assets/Textures/Hinge/Hinge Albeto.jpg",
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
      albedo: "./assets/Textures/Hinge/Hinge Albeto.jpg",
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
      albedo: "./assets/Textures/Hinge/Hinge Albeto.jpg",
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
    albedo: "./assets/Textures/VCR Cords/Black VCR Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Blade: makePBR({
    albedo: "./assets/Textures/Knife/Knife Albeto.jpg",
    },
    { roughness: 0.3, metalness: 0.1}
),

Handle: makePBR({
    albedo: "./assets/Textures/Knife/Knife Handle Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Board2: makePBR({
    albedo: "./assets/Textures/Skateboard/Board Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.2}
),

Grinding_Treck2: makePBR({
    albedo: "./assets/Textures/Skateboard/Treck Grinder Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Grinding_Teck1: makePBR({
    albedo: "./assets/Textures/Skateboard/Treck Grinder Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Right_Wheel2: makePBR({
    albedo: "./assets/Textures/Skateboard/Right Wheel Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Right_Wheel1: makePBR({
    albedo: "./assets/Textures/Skateboard/Right Wheel Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Left_Wheel: makePBR({
    albedo: "./assets/Textures/Skateboard/Left Wheel Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Left_Wheel1: makePBR({
    albedo: "./assets/Textures/Skateboard/Left Wheel Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.0}
),

Top_of_Treck: makePBR({
    albedo: "./assets/Textures/Skateboard/Top of Treck Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Top_of_Treck1: makePBR({
    albedo: "./assets/Textures/Skateboard/Top of Treck Albeto.jpg",
    },
    { roughness: 1.0, metalness: 0.5}
),

Picture1: makePBR({
    albedo: "./assets/Textures/Picture/Picture Albeto.jpg",
    },
    { roughness: 0.85, metalness: 0.0}
),

Picture_Frame: makePBR({
    albedo: "./assets/Textures/Picture/Picture Frame Albeto.jpg",
    },
    { roughness: 0.85, metalness: 0.0}
),

Lamp1: (() => {
  const m = makePBR(
    { albedo: "./assets/Textures/Lamp/Lamp Albeto.jpg" },
    { roughness: 1.0, metalness: 0.0 }
  );

  // emission glow BUT texture stays visible
  m.emissive = new THREE.Color(0xffb45a);      // warm glow color
  m.emissiveIntensity = 2;                  // keep low so texture still shows
  m.emissiveMap = m.map;                       // uses the lamp texture as the glow pattern
  m.toneMapped = true;
  return m;
})(),


Treck_Screw4: makePBR({
    albedo: "./assets/Textures/Skatebaord/Treck screw.jpg",
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
  
};

if (materials.Door2 && materials.Door2.color) {
  materials.Door2.color.multiplyScalar(1.2);
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

// Darken cabinet / shelves
if (materials.cabnet) {
  darkenMaterial(materials.cabnet, {
    env: 0.0,
    rough: 1.0,
    colorMul: 0.5,
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


      if (n.includes("remote")) {
  remoteMeshRef = o;

  // already used by your accent lights
  o.layers.enable(LAYER_ACCENT);

  // NEW: allow pin light to affect remote
  o.layers.enable(LAYER_PIN);
}

if (n.includes("board") || n.includes("skate")) {
  skateboardMeshRef = o;

  o.layers.enable(LAYER_ACCENT);

  // NEW: allow pin light to affect skateboard (remove if you don't want it)
  o.layers.enable(LAYER_PIN);
}


     // ------------------------------------------------------------
// ✅ MATERIAL ASSIGN (FIXED): do NOT overwrite o.material
// until AFTER we've tried to match using the ORIGINAL names.
// ------------------------------------------------------------
const originalMatName = o.material?.name;
const keysToTry = [
  o.name,
  o.parent?.name,
  originalMatName,          // ✅ keep the GLB-authored material name
  o.parent?.parent?.name,
].filter(Boolean);

let mat = null;
for (const k of keysToTry) {
  if (materials[k]) {
    mat = materials[k];
    break;
  }
}

// ✅ only fallback if nothing matched
o.material = mat ? mat : fallbackMat;


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

      // Global IBL control
      if (o.material && "envMapIntensity" in o.material) {
        o.material.envMapIntensity = 0.02;
      }

      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    });

   // Center the whole anchor based on the ROOM bounds
const box = new THREE.Box3().setFromObject(model);
const center = box.getCenter(new THREE.Vector3());
anchor.position.sub(center);
anchor.updateMatrixWorld(true);


  const box2 = new THREE.Box3().setFromObject(model);
const size2 = box2.getSize(new THREE.Vector3());
const maxDim = Math.max(size2.x, size2.y, size2.z);
roomMaxDim = maxDim;

    // Setup lights
    nightLights = setupNightLights(maxDim);

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


    // ============================================================
// ✅ LAMP MESH REF (for click detection)
// ============================================================
lampMeshRef = (() => {
  let found = null;
  model.traverse((o) => {
    if (found) return;
    const n = (o.name || "").toLowerCase();

    // ✅ matches your material key "Lamp1" naming style
    if (n.includes("lamp1") || n.includes("lamp")) found = o;
  });
  return found;
})();


    if (lampMeshRef && lampMeshRef.material) {
  const m = lampMeshRef.material;

  // subtle center boost
  m.emissiveIntensity = 1.6;

  // tiny variation
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
      #include <emissivemap_fragment>

      // fake bulb hotspot
      float d = distance(vUv, vec2(0.5));
      float hot = smoothstep(0.45, 0.0, d);
      totalEmissiveRadiance *= mix(1.0, 1.25, hot);
      `
    );
  };

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

    // ============================================================
    // CAMERA (keeps your same framing logic)
    // ============================================================
    const fov = camera.fov * (Math.PI / 180);
    const baseDist = maxDim / (2 * Math.tan(fov / 2));

    const camX = maxDim * 0.030; // (+) Right (-) Left
    const camY = maxDim * -0.146; // (+) Up (-) Down
    const camZ = baseDist * 0.282; // (+) Farther (-) Closer

    const targetX = 1.18; // (+) Right (-) Left
    const targetY = maxDim * -0.186; // (+) Up (-) Down
    const targetZ = 0; // (+) Farther (-) Closer

    camera.position.set(camX, camY, camZ);
    camera.lookAt(targetX, targetY, targetZ);

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
    handleResize();

    captureBreathBaseline();
  },
  

  undefined,
  (err) => {
    console.error("GLB failed to load ❌", err);
    __endMainGLB(); // ✅ count errors as "done" so loader doesn't hang forever
  }
);

const interactiveLoader = new GLTFLoader();

const __endUI = __beginAsset("Interactives GLB");

interactiveLoader.load(
  "./assets/models/Interactive Materials.glb",
  (gltf) => {
    __endUI();

    const ui = gltf.scene;
    anchor.add(ui);

interactivesRootRef = ui;

  ui.traverse((o) => {
  if (!o.isMesh) return;

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
    o.frustumCulled = false;

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
  o.frustumCulled = false;
});


ui.updateMatrixWorld(true);
console.log("✅ Interactives loaded");
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
// ✅ BREATHING (subtle always + deeper breath every ~10s)
// - consistent across normal + night vision (camera motion only)
// ============================================================

// baseline capture (you already call captureBreathBaseline() after camera setup)
const baseCamQuat = new THREE.Quaternion();
let baseCamFov = camera.fov;
let breathBaselineCaptured = false;

function captureBreathBaseline() {
  baseCamQuat.copy(camera.quaternion);
  baseCamFov = camera.fov;
  breathBaselineCaptured = true;
}

const BREATH3 = {
  // subtle continuous breath
  baseCycle: 12.0,      // slower (seconds per cycle)
  baseJitter: 0.4,      // less variation
  baseAmount: 0.55,     // master multiplier (overall strength)

  // ✅ disable deep breaths entirely
  deepEvery: 99999.0,
  deepJitter: 0.0,
  deepStrength: 1.0,
  deepInhale: 1.3,
  deepExhale: 2.6,
  deepHold: 0.25,

  // motion amplitudes (multiplied by roomMaxDim scale)
  posY: 0.00045,
  posX: 0.00008,
  posZ: 0.00018,

  // ✅ kill rotation (this is what makes it feel like “fighting”)
  yaw:   0.0,
  pitch: 0.0,
  roll:  0.0,
};


let _tBreath = 0;

// deep-breath scheduler/state
let _nextDeepAt = 0;
let _deepState = "idle"; // "idle" | "inhale" | "hold" | "exhale"
let _deepT = 0;
let _deepAmp = 0;

function _randRange(a, b) {
  return a + Math.random() * (b - a);
}

function _smoothstep(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

// inhale -> tiny hold -> exhale envelope
function updateDeepBreath(dt, now) {
  if (_nextDeepAt === 0) {
    _nextDeepAt = now + BREATH3.deepEvery + _randRange(-BREATH3.deepJitter, BREATH3.deepJitter);
  }

  if (_deepState === "idle" && now >= _nextDeepAt) {
    _deepState = "inhale";
    _deepT = 0;
  }

  if (_deepState === "idle") {
    _deepAmp += (0 - _deepAmp) * 0.08;
    return _deepAmp;
  }

  _deepT += dt;

  if (_deepState === "inhale") {
    const u = _deepT / Math.max(1e-5, BREATH3.deepInhale);
    _deepAmp = _smoothstep(u);
    if (u >= 1) {
      _deepState = "hold";
      _deepT = 0;
    }
  } else if (_deepState === "hold") {
    _deepAmp = 1.0;
    if (_deepT >= BREATH3.deepHold) {
      _deepState = "exhale";
      _deepT = 0;
    }
  } else if (_deepState === "exhale") {
    const u = _deepT / Math.max(1e-5, BREATH3.deepExhale);
    _deepAmp = 1.0 - _smoothstep(u);
    if (u >= 1) {
      _deepState = "idle";
      _deepT = 0;
      _nextDeepAt =
        now + BREATH3.deepEvery + _randRange(-BREATH3.deepJitter, BREATH3.deepJitter);
    }
  }

  return _deepAmp;
}

// ============================================================
// ✅ BREATHING DOESN'T FIGHT THE USER
// Fade breathing OUT while the user interacts, fade back IN after.
// ============================================================
let lastUserInputMs = performance.now();
let breathMix = 1.0; // 1 = full breathing, 0 = no breathing

const BREATH_INPUT = {
  fadeOutSpeed: 0.18,   // faster fade out (during interaction)
  fadeInSpeed: 0.06,    // slower fade in (after idle)
  idleDelayMs: 650,     // how long after input before breathing returns
  minWhileActive: 0.0,  // breathing amount while active (0 = fully off)
};

function markUserInput() {
  lastUserInputMs = performance.now();
}

// treat these as “user controlling the camera / attention”
window.addEventListener("pointerdown", markUserInput, { passive: true });
window.addEventListener("pointermove", markUserInput, { passive: true });
window.addEventListener("wheel", markUserInput, { passive: true });
window.addEventListener("keydown", markUserInput, { passive: true });
window.addEventListener("touchstart", markUserInput, { passive: true });
window.addEventListener("touchmove", markUserInput, { passive: true });

function updateBreath2(dt) {
  if (!breathBaselineCaptured || !baseCamPos) return;

  const now = performance.now() * 0.001;

    // ✅ fade breathing based on recent user input
  const msSinceInput = performance.now() - lastUserInputMs;
  const targetMix = (msSinceInput < BREATH_INPUT.idleDelayMs)
    ? BREATH_INPUT.minWhileActive
    : 1.0;

  const mixSpeed = (targetMix < breathMix)
    ? BREATH_INPUT.fadeOutSpeed
    : BREATH_INPUT.fadeInSpeed;

  breathMix += (targetMix - breathMix) * mixSpeed;


  // scale by room size so it stays subtle across differently-sized scenes
  const scale = Math.max(0.15, roomMaxDim);

  // continuous baseline breathing
  const cycle = BREATH3.baseCycle + Math.sin(now * 0.13) * BREATH3.baseJitter * 0.35;
  _tBreath += dt * (Math.PI * 2) / Math.max(0.001, cycle);

  const baseEase = 0.5 - 0.5 * Math.cos(_tBreath); // 0..1
  const sway = Math.sin(_tBreath * 0.63 + 1.1);

  // deeper breath pulse every ~10s
  const deepEnv = updateDeepBreath(dt, now);

  // baseline always + boosted inhale/exhale during deep event
  const breath01 = baseEase * (1.0 + deepEnv * (BREATH3.deepStrength - 1.0));

  const breathSigned = (breath01 - 0.5) * 2.0;

  // POSITION
  const yBob = breathSigned * BREATH3.posY * scale;
  const zBob = (breathSigned * 0.70 + sway * 0.30) * BREATH3.posZ * scale;
  const xBob = sway * BREATH3.posX * scale;

  camera.position.set(
    baseCamPos.x + xBob,
    baseCamPos.y + yBob,
    baseCamPos.z + zBob
  );

  // ROTATION (very subtle)
  const yaw   = (sway * 0.65 + breathSigned * 0.35) * BREATH3.yaw;
  const pitch = breathSigned * BREATH3.pitch * 0.85;
  const roll  = sway * BREATH3.roll;

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
  camera.quaternion.copy(baseCamQuat).multiply(q);

  // keep FOV stable
  camera.fov = baseCamFov;
}


//ANIMATE
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
// ✅ breathing is now screen-space (post FX), so camera stays perfectly still


  // ✅ advance bug animations
if (bugMixer) bugMixer.update(dt);

 updateTv(); // ✅ animate TV turning on/off
 updateLampFlicker();
 updateDust(dt);
 updateGlow();
 updatePress(); // ✅ ADD HERE
 
 // ✅ Throttle TV redraw so it doesn't hammer performance
if (!window.__tvRedrawAcc) window.__tvRedrawAcc = 0;
window.__tvRedrawAcc += dt;

if (tvOn && tvScreenMatRef && window.__tvRedrawAcc > (1 / 12)) {
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
if (MOBILE_PROFILE.postFX && nightVisionOn && composer && nightVisionPass) {
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

// ============================================================
// CLEAN RESIZE HANDLER (GitHub + VSC consistent)
// ============================================================

function handleResize() {
  if (!renderer || !renderer.domElement) return;
  if (!camera) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h;

  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(isIOS ? Math.min(dpr, 1.5) : Math.min(dpr, 2.0));
  renderer.setSize(w, h, true);

  // Always fullscreen
  viewX = 0;
  viewY = 0;
  viewW = w;
  viewH = h;

  // Apply cover math only after baseline captured
  if (baseFovCaptured) {
    if (aspect > BASE_ASPECT) {
      const baseV = THREE.MathUtils.degToRad(baseFovDeg);
      const baseH = 2 * Math.atan(Math.tan(baseV * 0.5) * BASE_ASPECT);
      const newV  = 2 * Math.atan(Math.tan(baseH * 0.5) / aspect);
      camera.fov = THREE.MathUtils.radToDeg(newV);
    } else {
      camera.fov = baseFovDeg;
    }
  }

  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  if (composer) composer.setSize(w, h);
  if (nightVisionPass?.uniforms?.uResolution?.value) {
    nightVisionPass.uniforms.uResolution.value.set(w, h);
  }
}

window.addEventListener("resize", handleResize);
window.addEventListener("orientationchange", () => {
  setTimeout(handleResize, 250);
});

// ============================================================
// ✅ MOBILE FIX: react to browser UI (address bar) resizing
// ============================================================
if (window.visualViewport) {
  const vv = window.visualViewport;

  const onVV = () => {
    // fire your existing resize logic
    window.dispatchEvent(new Event("resize"));
  };

  vv.addEventListener("resize", onVV);
  vv.addEventListener("scroll", onVV); // Safari sometimes changes viewport on scroll
}

// ✅ Run initial resize only when renderer + camera exist
(function initResizeWhenReady() {
  if (renderer && renderer.domElement && camera) {
    window.dispatchEvent(new Event("resize"));
  } else {
    requestAnimationFrame(initResizeWhenReady);
  }
})();
