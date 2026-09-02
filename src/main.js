import * as THREE from 'three';
import {
  FLIGHT, GRAB, clamp, forwardVector, stepFlight, canGrab, launchVelocity, stepProjectile,
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
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
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
scene.background = new THREE.Color(0x0a1018);
scene.fog = new THREE.Fog(0x0a1018, 120, 460);

const camera = new THREE.PerspectiveCamera(
  62, window.innerWidth / window.innerHeight, 0.1, 900,
);

// Lighting: ambient + cool sky fill (positive intensities so flat-shaded meshes
// are never pitch black) plus a warm directional sun that follows the action.
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
scene.add(new THREE.HemisphereLight(0x8fb3d9, 0x2e4a2f, 0.75));
const sun = new THREE.DirectionalLight(0xffe6b0, 1.6);
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

function updatePrey(dt) {
  for (const p of preyList) {
    if (p.state !== 'wandering') continue;
    p.turnTimer -= dt;
    if (p.turnTimer <= 0) {
      p.heading += (Math.random() - 0.5) * 2.4;
      p.turnTimer = 1 + Math.random() * 3;
    }
    const dx = Math.sin(p.heading) * p.speed * dt;
    const dz = Math.cos(p.heading) * p.speed * dt;
    let x = p.group.position.x + dx;
    let z = p.group.position.z + dz;
    if (Math.abs(x) > PREY_BOUND || Math.abs(z) > PREY_BOUND) {
      p.heading += Math.PI; // bounce off the arena edge
      x = clamp(p.group.position.x, -PREY_BOUND, PREY_BOUND);
      z = clamp(p.group.position.z, -PREY_BOUND, PREY_BOUND);
    }
    p.group.position.set(x, terrainHeight(x, z), z);
    p.group.rotation.y = Math.atan2(dx, dz);
  }
}

// ---------------------------------------------------------------------------
// Game state: bird flight, payload, score, projectiles
// ---------------------------------------------------------------------------
const birdState = { x: 0, y: 45, z: 80, yaw: 0, pitch: 0, roll: 0, speed: FLIGHT.baseCruise };
let carrying = null;   // prey object currently in the talons
let score = 0;
const projectiles = []; // { group, x,y,z,vx,vy,vz }

// ---------------------------------------------------------------------------
// Input — pitch & roll via WASD / Arrow Keys (yaw auto-coordinates)
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

function readInput() {
  const up = keys.has('KeyW') || keys.has('ArrowUp');
  const down = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  return { pitch: (up ? 1 : 0) + (down ? -1 : 0), roll: (left ? 1 : 0) + (right ? -1 : 0) };
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
      score += GRAB.scoreLaunch;
      updateHud();
      respawnPrey(pr.prey);
      projectiles.splice(i, 1);
    }
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
};
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
}

// ---------------------------------------------------------------------------
// Chase camera
// ---------------------------------------------------------------------------
const camTarget = new THREE.Vector3();
function updateCamera(dt) {
  const f = forwardVector(birdState.yaw, birdState.pitch);
  camTarget.set(
    birdState.x - f.x * 14,
    birdState.y - f.y * 14 + 5.5,
    birdState.z - f.z * 14,
  );
  camera.position.lerp(camTarget, 1 - Math.exp(-6 * dt));
  camera.lookAt(
    birdState.x + f.x * 8,
    birdState.y + f.y * 8,
    birdState.z + f.z * 8,
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let flapPhase = 0;
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

    // Arena bounds: soft walls + ground/ceiling clamps.
    birdState.x = clamp(birdState.x, -BOUND, BOUND);
    birdState.z = clamp(birdState.z, -BOUND, BOUND);
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

    // Wing flap — faster with airspeed.
    flapPhase += dt * (3 + birdState.speed * 0.4);
    const flap = Math.sin(flapPhase) * 0.5;
    birdGroup.userData.wings.left.rotation.z = flap;
    birdGroup.userData.wings.right.rotation.z = -flap;

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

    // --- sun follows the bird so shadows stay crisp near the action ---
    sun.position.set(birdState.x - 120, birdState.y + 160, birdState.z - 80);
    sun.target.position.set(birdState.x, birdState.y, birdState.z);

    updateCamera(dt);
    updateHud();
  } catch (err) {
    // Never let a tick exception halt the loop or skip renderer.render —
    // log it and fall through so this frame still paints.
    console.error('[birdsim] animation tick failed:', err);
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Frame-1 camera placement: put the chase cam directly behind/above the bird so
// it and the arena ground are inside the frustum immediately, instead of the
// camera lerping in from the origin on the first frames.
{
  const f = forwardVector(birdState.yaw, birdState.pitch);
  camera.position.set(
    birdState.x - f.x * 14,
    birdState.y - f.y * 14 + 5.5,
    birdState.z - f.z * 14,
  );
  camera.lookAt(birdState.x + f.x * 8, birdState.y + f.y * 8, birdState.z + f.z * 8);
}

updateHud();
animate();
