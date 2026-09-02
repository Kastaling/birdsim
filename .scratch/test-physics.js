// Test harness for birdsim flight & payload physics.
// Plain Node (ESM) — validates the pure math in src/physics.js:
//   1. pitch / dive acceleration dynamics
//   2. forward-vector orientation math
//   3. grab condition on low swoops
//   4. launch velocity + projectile integration under gravity
import {
  FLIGHT, GRAB, clamp, forwardVector, computeSpeedAccel, stepFlight, canGrab,
  launchVelocity, stepProjectile,
} from '../src/physics.js';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   - ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function approx(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
console.log('\n[1] pitch / dive acceleration dynamics');
{
  // Level flight at cruise speed is a fixed point of the speed dynamics.
  check('level cruise is stable (accel = 0)', approx(computeSpeedAccel(FLIGHT.baseCruise, 0), 0));

  // Diving (negative pitch) must add airspeed: accel = -diveAccel * sin(pitch).
  const diveAccel = computeSpeedAccel(24, -Math.PI / 6);
  check('dive adds speed', diveAccel > 0 && approx(diveAccel, FLIGHT.diveAccel * 0.5), `got ${diveAccel}`);

  // Climbing (positive pitch) must bleed airspeed — trading speed for altitude.
  const climbAccel = computeSpeedAccel(24, Math.PI / 6);
  check('climb trades speed for altitude', climbAccel < 0 && approx(climbAccel, -FLIGHT.diveAccel * 0.5), `got ${climbAccel}`);

  // One-step exactness: s' = clamp(s + a*dt) with pitch held (no input).
  const stepped = stepFlight(
    { x: 0, y: 0, z: 0, speed: 24, yaw: 0, pitch: -Math.PI / 6, roll: 0 },
    { pitch: 0, roll: 0 }, 1,
  );
  check('one-step dive math exact (s + a*dt)', approx(stepped.speed, 28.5), `got ${stepped.speed}`);

  // Sustained dive saturates at maxSpeed and loses altitude.
  let st = { x: 0, y: 100, z: 0, speed: 24, yaw: 0, pitch: -FLIGHT.maxPitch, roll: 0 };
  for (let i = 0; i < 600; i++) st = stepFlight(st, { pitch: -1, roll: 0 }, 0.05); // 30 s
  check('sustained dive clamps at maxSpeed', approx(st.speed, FLIGHT.maxSpeed), `got ${st.speed}`);
  check('dive loses altitude', st.y < 100 - 200, `y=${st.y}`);

  // Sustained climb saturates at minSpeed while gaining altitude.
  let sc = { x: 0, y: 50, z: 0, speed: 40, yaw: 0, pitch: FLIGHT.maxPitch, roll: 0 };
  for (let i = 0; i < 600; i++) sc = stepFlight(sc, { pitch: 1, roll: 0 }, 0.05); // 30 s
  check('sustained climb clamps at minSpeed', approx(sc.speed, FLIGHT.minSpeed), `got ${sc.speed}`);
  check('climb gains altitude while bleeding speed', sc.y > 50 + 100 && sc.speed < 40, `y=${sc.y} v=${sc.speed}`);

  // Auto-coordinated yaw: banking left (roll input +1) turns toward -X.
  let sb = { x: 0, y: 20, z: 0, speed: 24, yaw: 0, pitch: 0, roll: 0 };
  for (let i = 0; i < 50; i++) sb = stepFlight(sb, { pitch: 0, roll: 1 }, 0.05); // 2.5 s bank left
  check('banking left turns yaw positive', sb.yaw > 0.3, `yaw=${sb.yaw}`);
  check('banked turn curves toward -X (screen left)', sb.x < -5, `x=${sb.x}`);

  // Pitch authority is clamped — holding input cannot invert the bird.
  let sp = { x: 0, y: 20, z: 0, speed: 24, yaw: 0, pitch: FLIGHT.maxPitch - 0.1, roll: 0 };
  for (let i = 0; i < 100; i++) sp = stepFlight(sp, { pitch: 1, roll: 0 }, 0.05);
  check('pitch clamps at max authority', approx(sp.pitch, FLIGHT.maxPitch), `got ${sp.pitch}`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] forward-vector orientation math');
{
  const f0 = forwardVector(0, 0);
  check('identity faces -Z', approx(f0.x, 0) && approx(f0.y, 0) && approx(f0.z, -1));

  const fy = forwardVector(Math.PI / 2, 0);
  check('yaw +90° turns toward -X', approx(fy.x, -1) && approx(fy.y, 0) && approx(fy.z, 0));

  const fp = forwardVector(0, Math.PI / 2);
  check('pitch +90° points straight up (climb)', approx(fp.x, 0) && approx(fp.y, 1) && approx(fp.z, 0));

  // Nose direction must stay a unit vector across the full yaw/pitch sweep.
  let unit = true;
  for (let i = 0; i < 720; i++) {
    const f = forwardVector(i * 0.01, Math.sin(i) * 0.9);
    if (Math.abs(Math.hypot(f.x, f.y, f.z) - 1) > 1e-9) unit = false;
  }
  check('forward stays unit length across sweep', unit);

  // Vertical component is exactly sin(pitch), independent of heading.
  const fa = forwardVector(2.3, -0.7);
  check('vertical component = sin(pitch)', approx(fa.y, Math.sin(-0.7)));
}

// ---------------------------------------------------------------------------
console.log('\n[3] grab condition on low swoops');
{
  const prey = { x: 0, y: 0, z: 0 };
  check('low swoop within radius grabs', canGrab({ x: 0.5, y: 3, z: 0 }, prey));
  check('exactly at grab radius still grabs (dist=6)', canGrab({ x: 6, y: 1, z: 0 }, prey));
  check('beyond radius does not grab', !canGrab({ x: 6.1, y: 1, z: 0 }, prey));
  check('at max altitude above prey still grabs (dy=5)', canGrab({ x: 0, y: GRAB.altitudeMax, z: 0 }, prey));
  check('too high to grab', !canGrab({ x: 0, y: GRAB.altitudeMax + 0.5, z: 0 }, prey));
  check('below ground level does not grab', !canGrab({ x: 0, y: -1, z: 0 }, prey));
  // Altitude is relative to the prey's own ground level (hills included).
  check('altitude measured relative to prey ground', canGrab({ x: 0, y: 8, z: 0 }, { x: 0, y: 4, z: 0 }));
}

// ---------------------------------------------------------------------------
console.log('\n[4] launch velocity & projectile integration');
{
  // Level launch: payload inherits the bird's forward velocity vector exactly.
  const v = launchVelocity(forwardVector(0, 0), 30);
  check('level launch velocity = forward * speed', approx(v.x, 0) && approx(v.y, 0) && approx(v.z, -30));

  // Dive launch: full vector (including vertical component) is inherited.
  const f2 = forwardVector(Math.PI / 4, -Math.PI / 6);
  const v2 = launchVelocity(f2, 40);
  check('dive launch inherits full velocity vector',
    approx(v2.x, f2.x * 40) && approx(v2.y, f2.y * 40) && approx(v2.z, f2.z * 40));

  // Semi-implicit Euler integration vs the closed-form ballistic solution.
  const p = { x: 0, y: 50, z: 0, vx: 24, vy: 0, vz: 0 };
  for (let i = 0; i < 100; i++) stepProjectile(p, 0.01); // t = 1 s
  check('horizontal range exact (no horizontal gravity)', approx(p.x, 24, 1e-6), `x=${p.x}`);
  const yAnalytic = 50 - 0.5 * FLIGHT.gravity * 1; // 41 m
  check('vertical drop matches ½gt² (Euler tolerance)', Math.abs(p.y - yAnalytic) < 0.5, `y=${p.y} vs ${yAnalytic}`);
  check('vy after 1 s ≈ -g', approx(p.vy, -FLIGHT.gravity, 0.2), `vy=${p.vy}`);

  // A dive launch must drop lower than a level launch over the same time.
  const lv = launchVelocity(forwardVector(0, -Math.PI / 4), 30);
  const pd = { x: 0, y: 50, z: 0, vx: lv.x, vy: lv.y, vz: lv.z };
  for (let i = 0; i < 100; i++) stepProjectile(pd, 0.01);
  check('dive launch lands lower than level launch', pd.y < p.y - 5, `pd.y=${pd.y} vs ${p.y}`);

  // Sanity: clamp helper used by the flight model.
  check('clamp bounds values', approx(clamp(5, 0, 3), 3) && approx(clamp(-1, 0, 3), 0) && approx(clamp(2, 0, 3), 2));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('FAILED: ' + failures.join(', '));
  process.exit(1);
}
console.log('all physics checks passed');
