const canvas = document.querySelector('canvas');
const BARREL = 0.03;
const BLOOM = 3.5;
const GLARE = 0.45;
const PHI = (1 + Math.sqrt(5)) / 2; // golden ratio ≈ 1.618 → 1/PHI ≈ 0.618 → 1 - 1/PHI ≈ 0.382
const CHAR_W = 8, CHAR_H = 16;
const CHARS_PER_SEC = 480; // characters revealed per second during load
const NOISE_MS = 32;  // ms each cell shows noise before resolving
const NOISE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()[]|\\/<>:;{}+=';

// Audio & Glitch Constants
const AUDIO_FILE = 'thrill.mp3';
const GLITCH_TRIGGER_TIME = 38;
const FFT_SIZE = 1024;
const SMOOTHING = 0.7;
const MAX_BLOOM_HIT = 8.0;

// Marquee Constants
const MARQUEE_TEXT = '  THE · EUPHIO · QUESTION · 2.0  ';
const MARQUEE_COLS = 28; // width in characters
const MARQUEE_LEFT = 26; // characters from left edge of image
const MARQUEE_SPEED = 133; // ms per character step
const MARQUEE_BOTTOM = 16 * 9; // pixels from bottom of image
const MARQUEE_W = MARQUEE_COLS * CHAR_W;
const MARQUEE_H = CHAR_H;

// Bloom Sensitivity Constants
const BLOOM_SUB_RANGE = [2, 6];   // 40-120Hz @ 1024 FFT
const BLOOM_NOISE_RANGE = [20, 200]; // ~400Hz - 4kHz
const THRESHOLD_MAX = 0.92;
const THRESHOLD_MIN = 0.65;

// Global State
let vizStarted = false;
let fxEnabled = true;
let glitchStartTime = -Infinity;
let analyser, freqData, marqueeX, marqueeLastStep = 0, bloomValue = BLOOM;

const audio = new Audio(AUDIO_FILE);
audio.loop = false;
audio.preload = 'auto';
audio.load();

// Offscreen buffer — all content rendered here; WebGL reads it as a texture
const buf = document.createElement('canvas');
const bufCtx = buf.getContext('2d');

// WebGL canvas — position: fixed, covers the viewport, renders buf with effects
const glCanvas = document.createElement('canvas');
glCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50;';
document.body.appendChild(glCanvas);
const gl = glCanvas.getContext('webgl');

const vs = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  }
`;

// Barrel distortion + chromatic aberration, scoped to the visible viewport slice
const fs = `
  precision mediump float;
  uniform sampler2D u_tex;
  uniform float u_visY;
  uniform float u_visH;
  uniform float u_caX;
  uniform float u_caY;
  uniform float u_barrel;
  uniform float u_glare;
  uniform float u_glareX;
  uniform float u_fx;
  uniform float u_bloom;
  uniform float u_time;
  uniform float u_glitch;
  uniform float u_glitchSeed;
  varying vec2 v_uv;

  vec3 brightPass(vec3 c) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float knee = 0.1;
    float threshold = 0.65;
    float excess = clamp((lum - threshold + knee) / (2.0 * knee), 0.0, 1.0);
    excess = mix(0.0, lum - threshold, excess);
    return c * (max(0.0, excess) / max(lum, 0.001));
  }

  void main() {
    if (u_fx < 0.5) {
      vec2 rawUV = vec2(v_uv.x, u_visY + v_uv.y * u_visH);
      gl_FragColor = texture2D(u_tex, rawUV);
      return;
    }

    vec2 c = v_uv * 2.0 - 1.0;
    float r2 = dot(c, c);
    vec2 warpedUV = (c * (1.0 + u_barrel * r2)) * 0.5 + 0.5;

    if (warpedUV.x < 0.0 || warpedUV.x > 1.0 || warpedUV.y < 0.0 || warpedUV.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec2 texUV = vec2(warpedUV.x, u_visY + warpedUV.y * u_visH);

    // Scanline wobble during glitch / degauss
    texUV.x += (sin(v_uv.y * 43.0 + u_time * 25.0) * 0.018
               + sin(v_uv.y * 13.0 - u_time * 9.0)  * 0.009) * u_glitch;
    texUV.x = clamp(texUV.x, 0.0, 1.0);

    // Chromatic aberration — direction rotated per-scanline during glitch for degauss swirl
    float caAngle = u_glitch * (fract(v_uv.y * 2.0 + u_glitchSeed * 0.03) * 2.0 - 1.0) * 3.14159;
    vec2 caDir = vec2(cos(caAngle), sin(caAngle));
    float caScale = 1.0 + u_glitch * 18.0;
    vec2 caOff = caDir * vec2(u_caX, u_caY) * caScale;
    float r = texture2D(u_tex, texUV - caOff).r;
    float g = texture2D(u_tex, texUV).g;
    float b = texture2D(u_tex, texUV + caOff).b;
    vec3 rgb = vec3(r, g, b);

    // Scanlines — darken every other 2px band with a 10fps flicker
    float scanline = step(2.0, mod(gl_FragCoord.y, 4.0));
    float flicker  = mod(floor(u_time * 10.0), 2.0) < 1.0 ? 0.12 : 0.15;
    rgb *= 1.0 - scanline * flicker * 1.0;

    // CRT phosphor glow / bloom — wide multi-ring kernel, bright-pass per sample
    vec2 px = vec2(u_caX, u_caY);
    vec3 bloom = vec3(0.0);
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 2.0,  0.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2(-2.0,  0.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 0.0,  2.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 0.0, -2.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 1.0,  1.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2(-1.0,  1.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 1.0, -1.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2(-1.0, -1.0) * px).rgb) * 1.0;
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 3.0,  3.0) * px).rgb) * 0.3;
    bloom += brightPass(texture2D(u_tex, texUV + vec2(-3.0,  3.0) * px).rgb) * 0.3;
    bloom += brightPass(texture2D(u_tex, texUV + vec2( 3.0, -3.0) * px).rgb) * 0.3;
    bloom += brightPass(texture2D(u_tex, texUV + vec2(-3.0, -3.0) * px).rgb) * 0.3;
    bloom /= 22.8;
    rgb = min(vec3(1.0), rgb + bloom * u_bloom);

    // Phosphor excitation flash during glitch
    rgb = min(vec3(1.0), rgb * (1.0 + u_glitch * 0.5));

    // CRT glass reflection — rendered in warped UV space so it follows the curve
    float cx = (warpedUV.x - u_glareX) * 2.0;
    float reflH = 1.0 - smoothstep(0.0, 0.22, warpedUV.y);
    float reflW = max(0.0, 1.0 - cx * cx);
    float specH = 1.0 - smoothstep(0.0, 0.07, warpedUV.y);
    float specW = 1.0 - smoothstep(0.0, 0.28, abs(cx));
    float refl  = reflH * reflW * reflW * u_glare + specH * specW * u_glare * 0.75;
    rgb = min(vec3(1.0), rgb + vec3(0.7, 0.86, 1.0) * refl);

    gl_FragColor = vec4(rgb, 1.0);
  }
`;

function compileShader(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

const prog = gl.createProgram();
gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vs));
gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fs));
gl.linkProgram(prog);
gl.useProgram(prog);

gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'a_pos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);

const uVisY = gl.getUniformLocation(prog, 'u_visY');
const uVisH = gl.getUniformLocation(prog, 'u_visH');
const uCaX = gl.getUniformLocation(prog, 'u_caX');
const uCaY = gl.getUniformLocation(prog, 'u_caY');
const uBarrel = gl.getUniformLocation(prog, 'u_barrel');
const uGlare = gl.getUniformLocation(prog, 'u_glare');
const uGlareX = gl.getUniformLocation(prog, 'u_glareX');
const uFx = gl.getUniformLocation(prog, 'u_fx');
const uBloom = gl.getUniformLocation(prog, 'u_bloom');
const uTime = gl.getUniformLocation(prog, 'u_time');
const uGlitch = gl.getUniformLocation(prog, 'u_glitch');
const uGlitchSeed = gl.getUniformLocation(prog, 'u_glitchSeed');
gl.uniform1f(uGlare, GLARE);
gl.uniform1f(uBloom, BLOOM);
gl.uniform1f(uGlareX, 1.0 - 1.0 / PHI); // 1 - 1/φ ≈ 0.382 — left of center

window.addEventListener('keydown', (e) => {
  if (e.key === '2') fxEnabled = !fxEnabled;
  if (e.key === '3') glitchStartTime = performance.now() / 1000;
});

function renderGL() {
  if (!buf.width || !buf.height) return;
  const scale = canvas.offsetWidth / canvas.width;
  const visY = Math.max(0, window.scrollY) / scale;
  const visH = Math.min(canvas.height - visY, window.innerHeight / scale);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  gl.uniform1f(uVisY, visY / canvas.height);
  gl.uniform1f(uVisH, Math.max(0, visH) / canvas.height);
  gl.uniform1f(uCaX, 1.0 / canvas.width);
  gl.uniform1f(uCaY, 1.0 / canvas.height);
  gl.uniform1f(uBarrel, BARREL);
  gl.uniform1f(uBloom, bloomValue);
  gl.uniform1f(uTime, performance.now() / 1000.0);
  gl.uniform1f(uFx, fxEnabled ? 1.0 : 0.0);

  // Glitch age: min of manual trigger (system time) and auto-trigger (song time)
  const manualAge = performance.now() / 1000 - glitchStartTime;
  const autoAge = audio.currentTime >= GLITCH_TRIGGER_TIME ? audio.currentTime - GLITCH_TRIGGER_TIME : Infinity;
  const glitchAge = Math.min(manualAge, autoAge);

  gl.uniform1f(uGlitch, Math.max(0, Math.exp(-glitchAge * 2.5)));
  gl.uniform1f(uGlitchSeed, Math.random() * 100);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function drawNoise(x, y) {
  const ch = NOISE_CHARS[Math.random() * NOISE_CHARS.length | 0];
  bufCtx.fillStyle = '#000';
  bufCtx.fillRect(x, y, CHAR_W, CHAR_H);
  bufCtx.fillStyle = `hsl(${Math.random() * 360 | 0}, 60%, 70%)`;
  bufCtx.fillText(ch, x + 1, y + 1);
}

const img = new Image();
img.onload = () => {
  buf.width = canvas.width = img.width;
  buf.height = canvas.height = img.height;
  canvas.style.visibility = 'hidden'; // layout placeholder only; WebGL canvas displays content

  bufCtx.drawImage(img, 0, 0);
  const imageData = bufCtx.getImageData(0, 0, img.width, img.height);

  bufCtx.fillStyle = '#000';
  bufCtx.fillRect(0, 0, img.width, img.height);
  bufCtx.font = '16px "IBM VGA 8x16"';
  bufCtx.textBaseline = 'top';

  const cols = Math.ceil(img.width / CHAR_W);
  const rows = Math.ceil(img.height / CHAR_H);
  let cell = 0;
  const total = cols * rows;
  const pending = [];

  document.body.style.overflow = 'hidden';

  function scrollToCursor() {
    const scale = canvas.offsetWidth / canvas.width;
    const row = Math.floor(cell / cols);
    const cssY = canvas.offsetTop + row * CHAR_H * scale;
    window.scrollTo({ top: cssY - window.innerHeight + CHAR_H * scale, behavior: 'instant' });
  }

  let lastRow = -1, lastTs = null;

  function frame(ts) {
    if (lastTs === null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;

    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      p.ms -= dt;
      if (p.ms <= 0) {
        bufCtx.putImageData(imageData, 0, 0, p.x, p.y, CHAR_W, CHAR_H);
        pending.splice(i, 1);
      } else {
        drawNoise(p.x, p.y);
      }
    }
    const charsThisFrame = Math.round(CHARS_PER_SEC * dt / 1000);
    for (let i = 0; i < charsThisFrame && cell < total; i++, cell++) {
      const x = (cell % cols) * CHAR_W;
      const y = Math.floor(cell / cols) * CHAR_H;
      pending.push({ x, y, ms: NOISE_MS });
      drawNoise(x, y);
    }

    const row = Math.floor(cell / cols);
    if (row !== lastRow) {
      scrollToCursor();
      lastRow = row;
    }
    if (cell >= total && pending.length === 0 && !vizStarted) {
      document.body.style.overflow = '';
      startViz();
    }

    drawViz(ts);
    renderGL();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
};

function startViz() {
  vizStarted = true;
  marqueeX = null; // initialized on first drawViz call

  const startAudio = () => {
    if (!analyser) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      if (ctx.state === 'suspended') ctx.resume();
    }
    audio.play();
    window.removeEventListener('keydown', startAudio);
    window.removeEventListener('mousedown', startAudio);
    window.removeEventListener('touchstart', startAudio);
  };
  window.addEventListener('keydown', startAudio);
  window.addEventListener('mousedown', startAudio);
  window.addEventListener('touchstart', startAudio);
}

function drawViz(ts) {
  if (!vizStarted) return;

  const marqX = MARQUEE_LEFT * CHAR_W;
  const marqY = buf.height - MARQUEE_H - MARQUEE_BOTTOM;

  // Marquee — steps one character width per MARQUEE_SPEED ms for consistent timing
  if (marqueeX === null) {
    marqueeX = marqX + MARQUEE_W;
    marqueeLastStep = ts;
  }
  while (ts - marqueeLastStep >= MARQUEE_SPEED) {
    marqueeX -= CHAR_W;
    marqueeLastStep += MARQUEE_SPEED;
  }
  if (marqueeX < marqX - MARQUEE_TEXT.length * CHAR_W) marqueeX = marqX + MARQUEE_W;
  bufCtx.fillStyle = '#000';
  bufCtx.fillRect(marqX, marqY, MARQUEE_W, MARQUEE_H);
  bufCtx.fillStyle = '#ffff57';
  bufCtx.font = '16px "IBM VGA 8x16"';
  bufCtx.textBaseline = 'top';
  bufCtx.save();
  bufCtx.beginPath();
  bufCtx.rect(marqX, marqY, MARQUEE_W, MARQUEE_H);
  bufCtx.clip();
  bufCtx.fillText(MARQUEE_TEXT, marqueeX, marqY);
  bufCtx.restore();

  // Dynamic sub-bass trigger: sensitivity increases with "noise" (mid-high energy)
  if (analyser) {
    analyser.getByteFrequencyData(freqData);

    // Sub-bass punch
    let subSum = 0;
    for (let i = BLOOM_SUB_RANGE[0]; i <= BLOOM_SUB_RANGE[1]; i++) {
      subSum += freqData[i];
    }
    const subBass = subSum / ((BLOOM_SUB_RANGE[1] - BLOOM_SUB_RANGE[0] + 1) * 255);

    // "Noise" level
    let midSum = 0;
    for (let i = BLOOM_NOISE_RANGE[0]; i <= BLOOM_NOISE_RANGE[1]; i++) {
      midSum += freqData[i];
    }
    const noise = midSum / ((BLOOM_NOISE_RANGE[1] - BLOOM_NOISE_RANGE[0] + 1) * 255);

    // Dynamic Threshold: Drops during noisy parts to increase sensitivity
    const threshold = Math.max(THRESHOLD_MIN, THRESHOLD_MAX - noise * 1.0);

    // Hit calculation
    const hit = Math.pow(Math.max(0, (subBass - threshold) / (1.0 - threshold)), 5.0);
    bloomValue = BLOOM + hit * MAX_BLOOM_HIT;
  }
}

// Initial Load order
document.fonts.load('16px "IBM VGA 8x16"').then(() => {
  img.src = 'teq.png';
});

// Resize handling
function resizeGL() {
  glCanvas.width = window.innerWidth * devicePixelRatio;
  glCanvas.height = window.innerHeight * devicePixelRatio;
  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
}

window.addEventListener('resize', resizeGL);
resizeGL();

// Block pinch-to-zoom gestures
document.addEventListener('gesturestart', function(e) {
  e.preventDefault();
}, { passive: false });
