import * as THREE from 'three';
import {
  FLIGHT, GRAB, THERMAL, TUCK, clamp, forwardVector, stepFlight, canGrab,
  launchVelocity, stepProjectile, thermalStrength, impactScore,
} from './physics.js';

// ---------------------------------------------------------------------------
// Arena constants
// ---------------------------------------------------------------------------
const ARENA = 300;            // world units (meters) — bounded low-poly arena
const HALF = ARENA / 2;       // 150
const BOUND = HALF - 8;       // soft flight boundary for the bird
const PREY_BOUND = HALF - 14; // wander boundary for ground prey
const CEILING = 250;          // soft altitude ceiling

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
let renderer;
try {
  // Throws "Error creating a WebGL context." when neither WebGL2 nor the
  // legacy WebGL fallback is available (no GPU, drivers disabled, etc.).
  renderer = new THREE.WebGLRenderer({ antialias: true });
} catch (err) {
  // Surface a clear on-screen fallback notice via the trap in index.html, then
  // rethrow so the global error log also records the underlying failure.
  if (typeof window.birdsimFatal === 'function') {
    window.birdsimFatal(
      'WebGL is not available',
      'Birdsim could not create a WebGL context on this device/browser, so it cannot render. ' +
        'Try enabling hardware acceleration, updating your GPU drivers, or using a recent ' +
        'version of Chrome, Firefox, Edge, or Safari.',
    );
  }
  throw err;
}
// The drawing buffer is sized from the canvas element's *rendered* box (see
// syncViewport below), never from raw window metrics — browser sidebars,
// vertical tab strips, and page zoom can all desync innerWidth/innerHeight
// from what is actually on screen. A provisional size keeps the renderer valid
// until the first measured sync after the canvas is attached and laid out.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth || 1, window.innerHeight || 1, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// Attach the canvas to document.body and force full-viewport styling so it can
// never collapse to zero size (the classic blank-WebGL-viewport failure mode).
const canvas = renderer.domElement;
canvas.style.position = 'absolute';
canvas.style.top = '0';
canvas.style.left = '0';
canvas.style.width = '100vw';
canvas.style.height = '100vh';
canvas.style.zIndex = '0';
canvas.style.display = 'block';
document.body.appendChild(canvas);

const scene = new THREE.Scene();
// Bright daytime sky; the exponential fog matches it so distant terrain fades
// into the horizon instead of a dark void.
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);

// Fixed vertical FOV for the chase cam. A constant fov keeps framing stable
// across resizes — only the aspect changes with viewport shape (see
// syncViewport), which is what makes the projection unambiguous on Vivaldi.
const CAMERA_FOV = 60; // deg

// The canvas element's client box is the source of truth for viewport size.
// Vivaldi on Linux has been observed to report a distorted box from
// getBoundingClientRect() when browser UI panels shift the layout — that desyncs
// the drawing buffer from the CSS box and stretches the render.
// clientWidth/clientHeight track the element's actual CSS box, so they are used
// instead; if the read is zero or otherwise invalid (pre-append, hidden tab),
// fall back to the parent's layout box, then raw window metrics.
function viewportSize() {
  let w = canvas.clientWidth;
  let h = canvas.clientHeight;

  const sane = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  if (!sane) {
    const parent = canvas.parentElement;
    if (parent && parent.offsetWidth > 0 && parent.offsetHeight > 0) {
      w = parent.offsetWidth;
      h = parent.offsetHeight;
    } else {
      w = window.innerWidth || 1;
      h = window.innerHeight || 1;
    }
  }
  return { w, h };
}

const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 900);

// Keep the projection matrix and drawing buffer matched to the canvas element's
// actual client box. Aspect guard: camera.aspect is always forced to width /
// height from measured dimensions — a mismatch between the projection aspect and
// the real buffer aspect is exactly what stretches the scene on Vivaldi Linux.
// The fov stays fixed at CAMERA_FOV, the pixel ratio is re-read (it changes when
// moving between monitors or zooming), and setSize uses the real element size so
// the WebGL buffer can never mismatch the CSS display size. `false` keeps our
// 100vw/100vh canvas styling authoritative.
function syncViewport() {
  const { w, h } = viewportSize();
  if (!w || !h) return; // ignore zero-size edge cases (e.g. minimized windows)
  camera.aspect = w / h; // explicit aspect guard: projection and buffer always agree
  camera.fov = CAMERA_FOV; // fixed vertical FOV — no adaptive widening
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
}

// Lighting: bright daytime ambient + sky fill so flat-shaded low-poly meshes
// read crisply in the open, plus a strong warm directional sun that follows
// the action and casts soft shadows.
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
scene.add(new THREE.HemisphereLight(0xbfd9f2, 0x557a44, 1.0));
const sun = new THREE.DirectionalLight(0xffe6b0, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -90;
sun.shadow.camera.right = 90;
sun.shadow.camera.top = 90;
sun.shadow.camera.bottom = -90;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 500;
scene.add(sun);
scene.add(sun.target);

// ---------------------------------------------------------------------------
// Terrain — bounded low-poly arena (300 x 300)
// ---------------------------------------------------------------------------
function terrainHeight(x, z) {
  return (
    Math.sin(x * 0.04) * Math.cos(z * 0.033) * 7 +
    Math.sin(x * 0.1 + 2) * Math.sin(z * 0.08) * 2
  );
}

const terrainGeo = new THREE.PlaneGeometry(ARENA, ARENA, 72, 72);
terrainGeo.rotateX(-Math.PI / 2);
{
  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  terrainGeo.computeVertexNormals();
}
const terrain = new THREE.Mesh(
  terrainGeo,
  new THREE.MeshStandardMaterial({ color: 0x3f7d4e, flatShading: true }),
);
terrain.receiveShadow = true;
scene.add(terrain);

// Perimeter walls marking the arena bounds.
{
  const wallMat = new THREE.MeshBasicMaterial({
    color: 0x1c2a3a, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
  });
  const longWall = new THREE.BoxGeometry(ARENA + 4, 16, 1);
  const north = new THREE.Mesh(longWall, wallMat);
  north.position.set(0, 8, -HALF);
  const south = new THREE.Mesh(longWall, wallMat);
  south.position.set(0, 8, HALF);
  const shortWall = new THREE.BoxGeometry(1, 16, ARENA + 4);
  const east = new THREE.Mesh(shortWall, wallMat);
  east.position.set(HALF, 8, 0);
  const west = new THREE.Mesh(shortWall, wallMat);
  west.position.set(-HALF, 8, 0);
  scene.add(north, south, east, west);
}

// Deterministic scenery (pines + rocks) for depth cues.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
{
  const rand = mulberry32(1337);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, flatShading: true });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2c5e3a, flatShading: true });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d8288, flatShading: true });

  for (let i = 0; i < 36; i++) {
    const x = (rand() * 2 - 1) * (HALF - 15);
    const z = (rand() * 2 - 1) * (HALF - 15);
    if (Math.abs(x) < 28 && Math.abs(z) < 28) continue; // keep spawn area clear
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 1.6, 5), trunkMat);
    trunk.position.y = 0.8;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(1.9 + rand(), 4.5 + rand() * 3, 6), leafMat);
    crown.position.y = 1.6 + crown.geometry.parameters.height / 2 - 0.75;
    tree.add(trunk, crown);
    tree.position.set(x, terrainHeight(x, z), z);
    tree.traverse((o) => { o.castShadow = true; });
    scene.add(tree);
  }
  for (let i = 0; i < 20; i++) {
    const x = (rand() * 2 - 1) * (HALF - 15);
    const z = (rand() * 2 - 1) * (HALF - 15);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8 + rand() * 1.4), rockMat);
    rock.scale.y = 0.6;
    rock.position.set(x, terrainHeight(x, z) + 0.3, z);
    rock.rotation.set(rand() * Math.PI, rand() * Math.PI, 0);
    rock.castShadow = true;
    scene.add(rock);
  }
}

// ---------------------------------------------------------------------------
// Soaring thermals — rising updraft columns around the arena. Each column is a
// faint cylinder shell plus a plume of rising particles; flying through one
// applies vertical lift and regenerates airspeed (see the main loop).
// ---------------------------------------------------------------------------
const thermals = []; // { x, z } — deterministic column centers
{
  const trand = mulberry32(9001);
  let placed = 0;
  while (placed < THERMAL.count && placed < 64) {
    const x = (trand() * 2 - 1) * (HALF - 45);
    const z = (trand() * 2 - 1) * (HALF - 45);
    if (Math.abs(x) < 35 && Math.abs(z) < 35) continue; // keep spawn area clear
    let tooClose = false;
    for (const t of thermals) {
      const dx = t.x - x, dz = t.z - z;
      if (dx * dx + dz * dz < 70 * 70) { tooClose = true; break; }
    }
    if (tooClose) continue;
    thermals.push({ x, z });
    placed++;
  }
}

const thermalColumns = []; // visual state: { x, z, base, mesh, points, parts }
{
  const shellMat = new THREE.MeshBasicMaterial({
    color: 0xfff2d9, transparent: true, opacity: 0.07,
    side: THREE.DoubleSide, depthWrite: false,
  });
  for (const t of thermals) {
    const base = terrainHeight(t.x, t.z);

    // Faint updraft column shell from the ground to the top of the lift zone.
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(THERMAL.radius, THERMAL.radius * 1.25, THERMAL.topAltitude, 24, 1, true),
      shellMat,
    );
    mesh.position.set(t.x, base + THERMAL.topAltitude / 2, t.z);
    scene.add(mesh);

    // Rising particle plume — the visible cue for where to soar.
    const parts = [];
    const pos = new Float32Array(THERMAL.particleCount * 3);
    for (let i = 0; i < THERMAL.particleCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * THERMAL.radius * 0.85;
      parts.push({
        x: t.x + Math.cos(a) * r,
        y: base + 2 + Math.random() * (THERMAL.topAltitude - 4),
        z: t.z + Math.sin(a) * r,
        speed: 6 + Math.random() * 8, // m/s upward drift
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfff7e0, size: 1.5, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);
    thermalColumns.push({ x: t.x, z: t.z, base, mesh, points, parts });
  }
}

function updateThermals(dt) {
  for (const col of thermalColumns) {
    const top = col.base + THERMAL.topAltitude;
    const attr = col.points.geometry.attributes.position;
    for (let i = 0; i < col.parts.length; i++) {
      const pt = col.parts[i];
      pt.y += pt.speed * dt;
      if (pt.y > top) { // recycle to the base of the column
        pt.y = col.base + 2;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * THERMAL.radius * 0.85;
        pt.x = col.x + Math.cos(a) * r;
        pt.z = col.z + Math.sin(a) * r;
      }
      attr.setXYZ(i, pt.x, pt.y, pt.z);
    }
    attr.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Player bird entity (low-poly, flapping wings)
// ---------------------------------------------------------------------------
const birdGroup = new THREE.Group();
{
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8622d, flatShading: true });
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xb34a1f, flatShading: true });

  const body = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3.2, 5), bodyMat);
  body.rotation.x = -Math.PI / 2; // nose points along -Z (forward)
  body.position.z = 0.3;
  birdGroup.add(body);

  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(0.25, 0.7, 4),
    new THREE.MeshStandardMaterial({ color: 0xf2c14e, flatShading: true }),
  );
  beak.rotation.x = -Math.PI / 2;
  beak.position.z = -1.9;
  birdGroup.add(beak);

  const wingGeo = new THREE.BoxGeometry(2.6, 0.14, 1.3);
  const leftPivot = new THREE.Group();
  leftPivot.position.set(-0.5, 0.25, 0.2);
  const leftWing = new THREE.Mesh(wingGeo, wingMat);
  leftWing.position.x = -1.3;
  leftPivot.add(leftWing);

  const rightPivot = new THREE.Group();
  rightPivot.position.set(0.5, 0.25, 0.2);
  const rightWing = new THREE.Mesh(wingGeo, wingMat);
  rightWing.position.x = 1.3;
  rightPivot.add(rightWing);

  birdGroup.add(leftPivot, rightPivot);
  birdGroup.userData.wings = { left: leftPivot, right: rightPivot };

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.7), wingMat);
  tail.position.set(0, 0.35, 1.6);
  birdGroup.add(tail);

  birdGroup.traverse((o) => { o.castShadow = true; });
}
scene.add(birdGroup);

// ---------------------------------------------------------------------------
// Game state: bird flight, payload, score, projectiles
// NOTE: declared before the ground-prey section below because randomPreySpot()
// reads birdState during module evaluation (the initial spawn loop). Declaring
// it later caused a TDZ ReferenceError that aborted the whole module at startup.
// ---------------------------------------------------------------------------
const birdState = {
  x: 0, y: 45, z: 80, yaw: 0, pitch: 0, roll: 0, speed: FLIGHT.baseCruise,
  isTucking: false, tuckMomentum: 0, // wing-tuck dive state (see physics.js TUCK)
};
let carrying = null;   // prey object currently in the talons
let score = 0;
const projectiles = []; // { group, x,y,z,vx,vy,vz }

// ---------------------------------------------------------------------------
// Ground prey (rabbits / squirrels) — wander, get grabbed on a low swoop
// ---------------------------------------------------------------------------
function makeRabbit() {
  const g = new THREE.Group();
  const furMat = new THREE.MeshStandardMaterial({ color: 0xcfc8bd, flatShading: true });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 6, 5), furMat);
  body.scale.set(1, 0.9, 1.4);
  body.position.y = 0.55;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 6, 5), furMat);
  head.position.set(0, 0.85, 0.7);
  const earGeo = new THREE.BoxGeometry(0.12, 0.55, 0.1);
  const earL = new THREE.Mesh(earGeo, furMat);
  earL.position.set(-0.14, 1.3, 0.7);
  earL.rotation.z = 0.15;
  const earR = new THREE.Mesh(earGeo, furMat);
  earR.position.set(0.14, 1.3, 0.7);
  earR.rotation.z = -0.15;
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.14, 5, 4), furMat);
  tail.position.set(0, 0.6, -0.8);
  g.add(body, head, earL, earR, tail);
  return g;
}

function makeSquirrel() {
  const g = new THREE.Group();
  const furMat = new THREE.MeshStandardMaterial({ color: 0xc9722e, flatShading: true });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 5), furMat);
  body.scale.set(1, 0.9, 1.3);
  body.position.y = 0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 5), furMat);
  head.position.set(0, 0.78, 0.6);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.4, 6), furMat);
  tail.position.set(0, 1.0, -0.5);
  tail.rotation.x = -Math.PI / 4; // bushy tail up and back
  g.add(body, head, tail);
  return g;
}

const preyList = [];
function spawnPrey(kind, x, z) {
  const group = kind === 'rabbit' ? makeRabbit() : makeSquirrel();
  group.traverse((o) => { o.castShadow = true; });
  scene.add(group);
  const p = {
    group,
    kind,
    heading: Math.random() * Math.PI * 2,
    speed: 1.5 + Math.random() * 1.5,
    turnTimer: 1 + Math.random() * 3,
    fleeTimer: 0, // s of active fleeing remaining (0 = calm wandering)
    state: 'wandering', // wandering | carried | launched
  };
  group.position.set(x, terrainHeight(x, z), z);
  preyList.push(p);
  return p;
}

function randomPreySpot() {
  for (let i = 0; i < 24; i++) {
    const x = (Math.random() * 2 - 1) * PREY_BOUND;
    const z = (Math.random() * 2 - 1) * PREY_BOUND;
    if (Math.hypot(x - birdState.x, z - birdState.z) > 40) return { x, z };
  }
  return { x: 0, z: 0 };
}

for (let i = 0; i < 8; i++) {
  const spot = randomPreySpot();
  spawnPrey(i % 2 === 0 ? 'rabbit' : 'squirrel', spot.x, spot.z);
}

// Flee behavior: a low pass (the bird's shadow sweeping the ground) or close
// proximity spooks prey into bolting directly away from the shadow point.
const FLEE = {
  shadowAlt: 15,     // m AGL — below this altitude the shadow is threatening
  shadowRadius: 42,  // m   — horizontal range at which a low shadow is noticed
  nearRadius: 26,    // m   — close proximity always triggers a flee
  speedMult: 2.8,    // flee speed vs wander speed
  durationMin: 1.2,  // s of fleeing after the trigger
  durationMax: 2.4,
};

function updatePrey(dt) {
  const birdAgl = Math.max(0, birdState.y - terrainHeight(birdState.x, birdState.z));
  for (const p of preyList) {
    if (p.state !== 'wandering') continue;
    const pp = p.group.position;
    const dx = pp.x - birdState.x; // vector from the bird's shadow to the prey
    const dz = pp.z - birdState.z;
    const distSq = dx * dx + dz * dz;

    // Flee trigger: a dive below 15 m AGL within shadow range, or close proximity.
    if (p.fleeTimer <= 0 &&
        ((birdAgl < FLEE.shadowAlt && distSq < FLEE.shadowRadius ** 2) ||
         distSq < FLEE.nearRadius ** 2)) {
      p.fleeTimer = FLEE.durationMin + Math.random() * (FLEE.durationMax - FLEE.durationMin);
    }

    let speed = p.speed;
    if (p.fleeTimer > 0) {
      // Bolt directly away from the bird's shadow point on the ground.
      const d = Math.sqrt(distSq) || 1e-4;
      p.heading = Math.atan2(dx / d, dz / d);
      speed *= FLEE.speedMult;
      p.fleeTimer -= dt;
    } else {
      // Calm wandering: occasional random heading changes.
      p.turnTimer -= dt;
      if (p.turnTimer <= 0) {
        p.heading += (Math.random() - 0.5) * 2.4;
        p.turnTimer = 1 + Math.random() * 3;
      }
    }

    const mx = Math.sin(p.heading) * speed * dt;
    const mz = Math.cos(p.heading) * speed * dt;
    let x = pp.x + mx;
    let z = pp.z + mz;
    if (Math.abs(x) > PREY_BOUND || Math.abs(z) > PREY_BOUND) {
      p.heading += Math.PI; // bounce off the arena edge
      x = clamp(pp.x, -PREY_BOUND, PREY_BOUND);
      z = clamp(pp.z, -PREY_BOUND, PREY_BOUND);
    }
    pp.set(x, terrainHeight(x, z), z);
    p.group.rotation.y = Math.atan2(mx, mz);
  }
}

// ---------------------------------------------------------------------------
// Input — pitch & roll via WASD / Arrow Keys (yaw auto-coordinates); tuck via
// holding Shift or the left trigger on a connected gamepad.
// ---------------------------------------------------------------------------
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    dropPayload();
    return;
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// Tuck trigger: Shift held on the keyboard, or button 7 (left trigger in the
// standard gamepad mapping) pressed. Gamepad polling is best-effort — if the
// API is unavailable the keyboard path still works.
function tuckHeld() {
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) return true;
  try {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    for (const pad of pads) {
      if (pad && pad.buttons[7] && pad.buttons[7].pressed) return true;
    }
  } catch (_) { /* no gamepad API — keyboard only */ }
  return false;
}

function readInput() {
  const up = keys.has('KeyW') || keys.has('ArrowUp');
  const down = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  return {
    pitch: (up ? 1 : 0) + (down ? -1 : 0),
    roll: (left ? 1 : 0) + (right ? -1 : 0),
    isTucking: tuckHeld(),
  };
}

// ---------------------------------------------------------------------------
// Grab & drop mechanics
// ---------------------------------------------------------------------------
function grabPrey(p) {
  carrying = p;
  p.state = 'carried';
  score += GRAB.scoreGrab;
  updateHud();
}

const bellyAnchor = new THREE.Vector3(0, -1.4, 0.6); // under the bird's belly (local)
function dropPayload() {
  if (!carrying) return;
  const p = carrying;
  carrying = null;
  p.state = 'launched';

  // Launch with the bird's forward velocity vector; gravity takes over from there.
  const f = forwardVector(birdState.yaw, birdState.pitch);
  const v = launchVelocity(f, birdState.speed);
  const worldAnchor = bellyAnchor.clone().applyMatrix4(birdGroup.matrixWorld);

  p.group.position.copy(worldAnchor);
  projectiles.push({ group: p.group, prey: p, x: worldAnchor.x, y: worldAnchor.y, z: worldAnchor.z, vx: v.x, vy: v.y, vz: v.z });
  updateHud();
}

function respawnPrey(p) {
  const spot = randomPreySpot();
  p.state = 'wandering';
  p.heading = Math.random() * Math.PI * 2;
  p.group.position.set(spot.x, terrainHeight(spot.x, spot.z), spot.z);
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    stepProjectile(pr, dt);
    pr.group.position.set(pr.x, pr.y, pr.z);
    pr.group.rotation.x += dt * 6; // tumble through the air
    if (pr.y <= terrainHeight(pr.x, pr.z)) {
      // Impact scoring: kinetic energy of the landing encodes both drop
      // altitude and launch velocity — harder drops score more.
      const impactSpeed = Math.hypot(pr.vx, pr.vy, pr.vz);
      score += impactScore(impactSpeed);
      spawnImpactBurst(pr.x, terrainHeight(pr.x, pr.z), pr.z, impactSpeed);
      updateHud();
      respawnPrey(pr.prey);
      projectiles.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Impact particle bursts — short-lived dust spray on ground collision. The
// burst size and spread scale with the impact speed.
// ---------------------------------------------------------------------------
const bursts = []; // { points, vels: number[], age, life }
function spawnImpactBurst(x, y, z, speed) {
  const N = 26;
  const pos = new Float32Array(N * 3);
  const vels = [];
  const power = 4 + Math.min(speed, 55) * 0.35; // spray velocity scale (clamped)
  for (let i = 0; i < N; i++) {
    pos[i * 3] = x;
    pos[i * 3 + 1] = y + 0.3;
    pos[i * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2; // azimuth around the impact point
    const up = 0.45 + Math.random() * 0.6; // upward bias of the spray cone
    const s = power * (0.5 + Math.random() * 0.7);
    vels.push(Math.cos(a) * s * 0.6, up * s, Math.sin(a) * s * 0.6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xd8b27c, size: 1.4, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  bursts.push({ points, vels, age: 0, life: 0.9 + Math.random() * 0.4 });
}

function updateBursts(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.age += dt;
    if (b.age >= b.life) {
      scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      bursts.splice(i, 1);
      continue;
    }
    const attr = b.points.geometry.attributes.position;
    for (let j = 0; j < attr.count; j++) {
      // Integrate the spray under a softened gravity so it arcs and settles.
      b.vels[j * 3 + 1] -= FLIGHT.gravity * 0.5 * dt;
      attr.setXYZ(
        j,
        attr.getX(j) + b.vels[j * 3] * dt,
        Math.max(attr.getY(j) + b.vels[j * 3 + 1] * dt, 0.2),
        attr.getZ(j) + b.vels[j * 3 + 2] * dt,
      );
    }
    attr.needsUpdate = true;
    b.points.material.opacity = 0.95 * (1 - b.age / b.life); // fade out
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = {
  alt: document.getElementById('alt-value'),
  speed: document.getElementById('speed-value'),
  payload: document.getElementById('payload-value'),
  score: document.getElementById('score-value'),
  thermal: document.getElementById('thermal-value'),
  tuck: document.getElementById('tuck-value'),
};
const speedlinesEl = document.getElementById('speedlines');
let currentThermalLift = 0; // m/s² of updraft applied this frame (for the HUD)
function updateHud() {
  const agl = Math.max(0, birdState.y - terrainHeight(birdState.x, birdState.z));
  hud.alt.textContent = `${agl.toFixed(1)} m`;
  hud.speed.textContent = `${birdState.speed.toFixed(1)} m/s`;
  if (carrying) {
    hud.payload.textContent = carrying.kind.toUpperCase();
    hud.payload.classList.add('carrying');
  } else {
    hud.payload.textContent = '—';
    hud.payload.classList.remove('carrying');
  }
  hud.score.textContent = String(score);
  if (currentThermalLift > 0.05) {
    hud.thermal.textContent = `SOARING +${currentThermalLift.toFixed(1)} m/s²`;
    hud.thermal.classList.add('active');
  } else {
    hud.thermal.textContent = '—';
    hud.thermal.classList.remove('active');
  }

  // Wing-tuck status: lit while the tuck key is actively held.
  if (birdState.isTucking) {
    hud.tuck.textContent = '[ TUCK ]';
    hud.tuck.classList.add('active');
  } else {
    hud.tuck.textContent = '—';
    hud.tuck.classList.remove('active');
  }

  // Speed-line overlay: streams past while tucked above the stretch threshold,
  // fading in with airspeed for a sense of velocity.
  if (birdState.isTucking && birdState.speed > TUCK_FOV_THRESHOLD) {
    const over = clamp(
      (birdState.speed - TUCK_FOV_THRESHOLD) / (TUCK.maxSpeed - TUCK_FOV_THRESHOLD), 0, 1,
    );
    speedlinesEl.classList.add('on');
    speedlinesEl.style.opacity = String(0.35 + 0.65 * over);
  } else {
    speedlinesEl.classList.remove('on');
    speedlinesEl.style.opacity = '0';
  }
}

// ---------------------------------------------------------------------------
// Chase camera
// ---------------------------------------------------------------------------
// Slightly further back than the old 14 m offset so the bird stays fully in
// frame even when the adaptive FOV sits at its minimum on wide viewports.
const CHASE_DISTANCE = 16; // m behind/along the nose vector (Z-axis offset)
const CHASE_HEIGHT = 5.5;  // m above the bird

const camTarget = new THREE.Vector3();
function updateCamera(dt) {
  const f = forwardVector(birdState.yaw, birdState.pitch);
  camTarget.set(
    birdState.x - f.x * CHASE_DISTANCE,
    birdState.y - f.y * CHASE_DISTANCE + CHASE_HEIGHT,
    birdState.z - f.z * CHASE_DISTANCE,
  );
  camera.position.lerp(camTarget, 1 - Math.exp(-6 * dt));
  camera.lookAt(
    birdState.x + f.x * 8,
    birdState.y + f.y * 8,
    birdState.z + f.z * 8,
  );
}

// Speed-stretch FOV: while tucking above the threshold speed, widen the field
// of view proportionally to airspeed for a sense of velocity; ease back to the
// base CAMERA_FOV on release. (syncViewport resets fov to the base value on
// resize events — this runs every frame and re-applies the stretch.)
const TUCK_FOV_THRESHOLD = 35; // m/s — speed-stretch kicks in above this while tucking
const TUCK_FOV_EXTRA = 12;     // deg — max extra widening at TUCK.maxSpeed

function updateCameraFov(dt) {
  let targetFov = CAMERA_FOV;
  if (birdState.isTucking && birdState.speed > TUCK_FOV_THRESHOLD) {
    const over = clamp(
      (birdState.speed - TUCK_FOV_THRESHOLD) / (TUCK.maxSpeed - TUCK_FOV_THRESHOLD), 0, 1,
    );
    targetFov = CAMERA_FOV + TUCK_FOV_EXTRA * over;
  }
  camera.fov += (targetFov - camera.fov) * Math.min(1, 5 * dt); // smooth ease in/out
  if (Math.abs(camera.fov - targetFov) < 0.01) camera.fov = targetFov; // settle exactly
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let flapPhase = 0;
let tuckAmount = 0; // eased 0..1 — how far the wings are folded into a tuck
const TUCK_WING_FOLD = 0.8; // rad of inward fold at full tuck (~46°)
const qYaw = new THREE.Quaternion();
const qPitch = new THREE.Quaternion();
const qRoll = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  try {
    // --- flight dynamics (pure math from physics.js) ---
    Object.assign(birdState, stepFlight(birdState, readInput(), dt));

    // Arena bounds: soft walls.
    birdState.x = clamp(birdState.x, -BOUND, BOUND);
    birdState.z = clamp(birdState.z, -BOUND, BOUND);

    // --- soaring thermals: vertical lift + airspeed regeneration inside a column ---
    const aglNow = Math.max(0, birdState.y - terrainHeight(birdState.x, birdState.z));
    let thermalSum = 0;
    for (const t of thermals) {
      thermalSum += thermalStrength(birdState.x, birdState.z, aglNow, t);
    }
    const lift = Math.min(thermalSum, 1); // cap stacked columns at full strength
    if (lift > 0) {
      birdState.y += THERMAL.liftAccel * lift * dt; // updraft pushes the bird up
      birdState.speed = clamp(
        birdState.speed + THERMAL.speedRegen * lift * dt,
        FLIGHT.minSpeed, FLIGHT.maxSpeed,
      ); // soaring regenerates airspeed (drag relaxes it back to cruise outside)
    }
    currentThermalLift = THERMAL.liftAccel * lift;

    // Ground/ceiling clamps.
    const floorY = terrainHeight(birdState.x, birdState.z) + 1;
    if (birdState.y < floorY) birdState.y = floorY;
    if (birdState.y > CEILING) birdState.y = CEILING;

    // --- apply orientation to the bird mesh: q = Ry * Rx * Rz ---
    qYaw.setFromAxisAngle(AXIS_Y, birdState.yaw);
    qPitch.setFromAxisAngle(AXIS_X, birdState.pitch);
    qRoll.setFromAxisAngle(AXIS_Z, birdState.roll);
    birdGroup.quaternion.copy(qYaw).multiply(qPitch).multiply(qRoll);
    birdGroup.position.set(birdState.x, birdState.y, birdState.z);
    birdGroup.updateMatrixWorld();

    // Wing tuck: ease the fold amount toward 1 while holding the tuck key and
    // back to 0 on release. Tucked wings lock (flap damped) and fold inward
    // against the body — left pivot +Z, right pivot −Z sweeps both tips toward
    // the centerline and down along the flanks.
    const targetTuck = birdState.isTucking ? 1 : 0;
    tuckAmount += (targetTuck - tuckAmount) * Math.min(1, 8 * dt);

    // Wing flap — faster with airspeed, but locked while tucking.
    flapPhase += dt * (3 + birdState.speed * 0.4);
    const flap = Math.sin(flapPhase) * 0.5 * (1 - tuckAmount * 0.85);
    birdGroup.userData.wings.left.rotation.z = flap + TUCK_WING_FOLD * tuckAmount;
    birdGroup.userData.wings.right.rotation.z = -flap - TUCK_WING_FOLD * tuckAmount;

    // --- prey: wander, grab check on low swoop ---
    updatePrey(dt);
    if (!carrying) {
      for (const p of preyList) {
        if (p.state !== 'wandering') continue;
        const pp = p.group.position;
        if (canGrab(birdState, { x: pp.x, y: pp.y, z: pp.z })) {
          grabPrey(p);
          break;
        }
      }
    } else {
      // Dangle the payload under the belly.
      carrying.group.position.copy(bellyAnchor.clone().applyMatrix4(birdGroup.matrixWorld));
      carrying.group.quaternion.copy(birdGroup.quaternion);
    }

    updateProjectiles(dt);
    updateBursts(dt);
    updateThermals(dt);

    // --- sun follows the bird so shadows stay crisp near the action ---
    sun.position.set(birdState.x - 120, birdState.y + 160, birdState.z - 80);
    sun.target.position.set(birdState.x, birdState.y, birdState.z);

    updateCamera(dt);
    updateCameraFov(dt);
    updateHud();
  } catch (err) {
    // Never let a tick exception halt the loop or skip renderer.render —
    // log it and fall through so this frame still paints.
    console.error('[birdsim] animation tick failed:', err);
  }
  renderer.render(scene, camera);
}

// Robust viewport sync: on every resize (and orientation change) re-measure the
// canvas element's client box and keep the projection + drawing buffer matched
// to it. This is what keeps the bird framed regardless of browser sidebars,
// vertical tabs, or window scaling — the measured client dimensions are always
// authoritative over raw window metrics.
function handleResize() {
  syncViewport();
}
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);

// Vivaldi on Linux can shift its UI panels (sidebar, vertical tab strip) without
// firing a window 'resize' event — watching the parent box directly catches those
// layout shifts immediately and re-syncs before a distorted frame paints.
if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
  new ResizeObserver(handleResize).observe(canvas.parentElement);
}

syncViewport(); // initial measured lock-in after first layout

// Frame-1 camera placement: put the chase cam directly behind/above the bird so
// it and the arena ground are inside the frustum immediately, instead of the
// camera lerping in from the origin on the first frames.
{
  const f = forwardVector(birdState.yaw, birdState.pitch);
  camera.position.set(
    birdState.x - f.x * CHASE_DISTANCE,
    birdState.y - f.y * CHASE_DISTANCE + CHASE_HEIGHT,
    birdState.z - f.z * CHASE_DISTANCE,
  );
  camera.lookAt(birdState.x + f.x * 8, birdState.y + f.y * 8, birdState.z + f.z * 8);
}

updateHud();
animate();
