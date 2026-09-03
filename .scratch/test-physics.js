// Test harness for birdsim flight & payload physics.
// Plain Node (ESM) — validates the pure math in src/physics.js:
//   1. pitch / dive acceleration dynamics
//   2. forward-vector orientation math
//   3. grab condition on low swoops
//   4. launch velocity + projectile integration under gravity
//   7. wing-tuck lift loss, ballistic fall arcs, gravity dives & weathercocking
import {
  FLIGHT, GRAB, THERMAL, IMPACT, TUCK, WORLD, ARCH, clamp, forwardVector, computeSpeedAccel,
  stepFlight, canGrab, launchVelocity, stepProjectile, thermalStrength,
  impactEnergy, impactScore, terrainHeight, isInsideArena,
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
console.log('\n[5] impact scoring engine');
{
  // Kinetic energy model: E = ½mv² with normalized unit mass.
  check('zero-speed impact has zero energy', approx(impactEnergy(0), 0));
  check('energy = ½v² (v=20 → 200 J)', approx(impactEnergy(20), 200));
  check('energy grows with speed', impactEnergy(30) > impactEnergy(15));

  // A ~100 m drop from rest under arcade gravity hits at sqrt(2·g·h) = 60 m/s,
  // which is exactly the reference energy → maxScore.
  const vRef = Math.sqrt(2 * FLIGHT.gravity * 100);
  check('reference-energy impact scores max', approx(impactScore(vRef), IMPACT.maxScore));
  check('gentle landing floors at minScore', approx(impactScore(0), IMPACT.minScore));
  check('score clamps above reference energy', approx(impactScore(vRef * 2), IMPACT.maxScore));
  check('score is monotonic in speed', impactScore(10) < impactScore(30) && impactScore(30) < impactScore(60));

  // Drop altitude matters: a higher drop (more fall time → more velocity) scores more.
  const vLow = Math.sqrt(2 * FLIGHT.gravity * 20);   // 20 m drop from rest
  const vHigh = Math.sqrt(2 * FLIGHT.gravity * 120); // 120 m drop from rest
  check('higher drop altitude scores more', impactScore(vHigh) > impactScore(vLow));
}

// ---------------------------------------------------------------------------
console.log('\n[6] thermal updraft strength');
{
  const t = { x: 50, z: -40 };
  // Full-strength core at ground level.
  check('column center at ground is full strength', approx(thermalStrength(t.x, t.z, 0, t), 1));

  // Radial falloff: half-radius → sqrt(1 − (½)²) = √0.75 ≈ 0.866.
  const mid = thermalStrength(t.x + THERMAL.radius / 2, t.z, 0, t);
  check('radial falloff at half radius', approx(mid, Math.sqrt(0.75), 1e-9));

  // Outside the core radius and above the top altitude: no lift.
  check('outside core radius gives no lift', thermalStrength(t.x + THERMAL.radius + 1, t.z, 10, t) === 0);
  check('above top altitude gives no lift', thermalStrength(t.x, t.z, THERMAL.topAltitude + 5, t) === 0);

  // Vertical taper: weakens with altitude but never drops below the 35% floor.
  const high = thermalStrength(t.x, t.z, THERMAL.topAltitude * 0.8, t);
  check('updraft weakens with altitude (floor 0.35)', approx(high, 0.35));

  // Strength is always within [0, 1] across a sweep of points.
  let bounded = true;
  for (let i = 0; i < 400; i++) {
    const s = thermalStrength(t.x + Math.sin(i) * THERMAL.radius * 1.5, t.z + Math.cos(i) * THERMAL.radius * 1.5, (i % 200), t);
    if (!(s >= 0 && s <= 1)) bounded = false;
  }
  check('strength stays within [0, 1]', bounded);
}

// ---------------------------------------------------------------------------
console.log('\n[7] wing-tuck dive mechanic');
{
  // --- lift loss (90% reduction) while tucking ---
  // Level cruise is a fixed point with wings out but not while tucked: with no
  // lift to hold airspeed, the only level-flight term is bleed-off.
  check('level cruise stable with wings out', approx(computeSpeedAccel(FLIGHT.baseCruise, 0), 0));
  const aLevelTuck = computeSpeedAccel(FLIGHT.baseCruise, 0, true);
  check('tuck kills lift: level flight no longer holds airspeed',
    aLevelTuck < 0 && approx(aLevelTuck, -FLIGHT.baseCruise * TUCK.levelBleed), `got ${aLevelTuck}`);

  // A pitched-up tuck bleeds speed even harder (gravity + bleed, no lift).
  const aClimbTuck = computeSpeedAccel(40, Math.PI / 6, true);
  check('tucked climb trades speed for altitude with no lift',
    aClimbTuck < -FLIGHT.diveAccel * 0.5, `got ${aClimbTuck}`);

  // --- ballistic fall arc: level tuck converts forward momentum into a drop ---
  let lt = { x: 0, y: 200, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: 0, roll: 0 };
  for (let i = 0; i < 80; i++) lt = stepFlight(lt, { pitch: 0, roll: 0, isTucking: true }, 0.05); // 4 s passive level tuck
  check('level tuck falls in a ballistic arc under gravity', lt.y < 200 - 30 && lt.vy < 0, `y=${lt.y} vy=${lt.vy}`);

  // --- weathercocking: passive tucks align the nose with the velocity vector ---
  // With no pitch input held while tucking, the nose weathervanes down toward
  // the actual flight path — target = -atan2(-vy, speed), the fall angle below
  // horizontal — instead of bleeding airspeed in a level attitude.
  check('passive level tuck pitches the nose down', lt.pitch < -0.2, `pitch=${lt.pitch}`);
  const velAngle = Math.atan2(-lt.vy, lt.speed); // radians below horizontal
  check('tuck weathervanes toward the velocity angle (converged)',
    Math.abs(lt.pitch + velAngle) < 0.15, `pitch=${lt.pitch} target=${-velAngle}`);
  check('weathercocked tuck holds airspeed via the dive trade (no level bleed)',
    lt.speed > FLIGHT.baseCruise - 5, `got ${lt.speed}`);

  // One-step lerp exactness: pitch closes min(1, rate*dt) of the gap to target.
  const w0 = { x: 0, y: 100, z: 0, speed: 30, yaw: 0, pitch: 0.5, roll: 0, vy: -12 };
  const w1 = stepFlight(w0, { pitch: 0, roll: 0, isTucking: true }, 0.05);
  const wSpeed = 30 + computeSpeedAccel(30, 0.5, true) * 0.05; // pre-clamp speed this step
  const wVy = -12 - TUCK.fallGravity * Math.cos(0.5) * (1 - TUCK.liftFactor) * 0.05;
  const wTarget = -Math.atan2(-wVy, wSpeed);
  check('weathercock lerp closes rate*dt of the gap in one step',
    approx(w1.pitch, 0.5 + (wTarget - 0.5) * Math.min(1, TUCK.weathercockRate * 0.05), 1e-9), `got ${w1.pitch}`);

  // Active pitch input suppresses the alignment — steering is never overridden.
  const wi = stepFlight({ x: 0, y: 100, z: 0, speed: 30, yaw: 0, pitch: -0.8, roll: 0, vy: -20 }, { pitch: -1, roll: 0, isTucking: true }, 0.05);
  check('held pitch input suppresses weathercocking', approx(wi.pitch, -0.8 - FLIGHT.pitchRate * 0.05), `got ${wi.pitch}`);

  // Fall velocity saturates at the terminal fall speed.
  let lf = { x: 0, y: 500, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: 0, roll: 0 };
  for (let i = 0; i < 600; i++) lf = stepFlight(lf, { pitch: 0, roll: 0, isTucking: true }, 0.05); // 30 s
  check('tuck fall saturates at terminal fall speed', approx(lf.vy, -TUCK.maxFallSpeed), `got ${lf.vy}`);

  // --- speed gain strictly from altitude -> velocity in a steep dive ---
  // No artificial accelerator: the tuck-dive term is exactly gravity along the
  // flight path minus reduced drag.
  const pD = -Math.PI / 3;
  check('tuck dive accel = gravity trade - reduced drag (no extra thrust)',
    approx(computeSpeedAccel(40, pD, true), -FLIGHT.diveAccel * Math.sin(pD) - 40 * TUCK.diveDrag), `got ${computeSpeedAccel(40, pD, true)}`);

  // Level or pitched-up tucks never gain speed; a steep dive does.
  check('no speed gain while tucked level', computeSpeedAccel(24, 0, true) < 0);
  check('no speed gain while tucked and pitched up', computeSpeedAccel(24, Math.PI / 6, true) < 0);
  check('steep tuck dive gains speed from the altitude trade', computeSpeedAccel(24, -FLIGHT.maxPitch, true) > 0);

  // At high airspeed a tucked dive sheds less drag than a normal dive.
  const hi = -FLIGHT.maxPitch;
  check('tuck dive retains more of the gravity gain at speed',
    computeSpeedAccel(80, hi, true) > computeSpeedAccel(80, hi, false), `tuck ${computeSpeedAccel(80, hi, true)} vs free ${computeSpeedAccel(80, hi, false)}`);

  // Sustained tuck dive breaks the normal ceiling and saturates at the elevated one.
  let td = { x: 0, y: 300, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: -FLIGHT.maxPitch, roll: 0 };
  for (let i = 0; i < 600; i++) td = stepFlight(td, { pitch: -1, roll: 0, isTucking: true }, 0.05); // 30 s tuck dive
  check('tuck dive breaks the normal speed ceiling', td.speed > FLIGHT.maxSpeed + 10, `got ${td.speed}`);
  check('tuck dive saturates at the elevated ceiling', approx(td.speed, TUCK.maxSpeed), `got ${td.speed}`);

  // Dive energy budget: kinetic-energy gain over a tuck dive never exceeds the
  // gravitational potential lost — speed gain strictly from trading altitude.
  {
    let eb = { x: 0, y: 300, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: -FLIGHT.maxPitch, roll: 0 };
    const ke0 = 0.5 * (eb.speed ** 2 + (eb.vy || 0) ** 2);
    for (let i = 0; i < 120; i++) eb = stepFlight(eb, { pitch: -1, roll: 0, isTucking: true }, 0.05); // 6 s tuck dive
    const ke1 = 0.5 * (eb.speed ** 2 + eb.vy ** 2);
    const dh = 300 - eb.y; // altitude lost
    check('tuck dive speed gain comes from the altitude trade',
      ke1 > ke0 && ke1 - ke0 <= FLIGHT.diveAccel * dh * 1.05, `dKE=${ke1 - ke0} vs g*dh=${FLIGHT.diveAccel * dh}`);
  }

  // --- catch air on release: vertical fall momentum -> forward glide speed ---
  // Weathercocking tips a passive level tuck below the catch pitch, so catching
  // the air now requires holding the nose up while tucking (active input
  // suppresses the alignment), then releasing at or above TUCK.catchPitch.
  let ct = { x: 0, y: 200, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: 0, roll: 0 };
  for (let i = 0; i < 80; i++) ct = stepFlight(ct, { pitch: 1, roll: 0, isTucking: true }, 0.05); // 4 s tuck, nose held up
  const preCatch = ct.speed;
  const fallVy = ct.vy;
  check('nose-up tuck builds vertical fall momentum', fallVy < -5, `vy=${fallVy}`);

  // Release while pitched up: the catch converts fall velocity into forward glide speed.
  const caught = stepFlight(ct, { pitch: 0, roll: 0, isTucking: false }, 0.05);
  check('releasing pitched-up catches the air (fall -> forward glide)',
    Math.abs(caught.speed - (preCatch + (-fallVy) * TUCK.catchFactor)) < 1 && caught.speed > preCatch, `got ${caught.speed} vs ${preCatch}`);
  check('fall velocity cleared after wing re-engage', caught.vy === 0);

  // Full lift restored: pull the nose back to level, then speed relaxes to cruise.
  let settle = caught;
  for (let i = 0; i < 200 && settle.pitch > 0.02; i++) settle = stepFlight(settle, { pitch: -1, roll: 0 }, 0.05);
  check('nose returns to level after the catch', Math.abs(settle.pitch) <= 0.02 + FLIGHT.pitchRate * 0.05, `pitch=${settle.pitch}`);
  for (let i = 0; i < 300; i++) settle = stepFlight(settle, { pitch: 0, roll: 0 }, 0.05); // 15 s level
  check('full lift restored after catch (speed relaxes to cruise)', Math.abs(settle.speed - FLIGHT.baseCruise) < 2, `got ${settle.speed}`);

  // A passive level tuck weathervanes below the catch pitch, so releasing it
  // continues the dive instead of catching the air.
  let pw = { x: 0, y: 200, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: 0, roll: 0 };
  for (let i = 0; i < 80; i++) pw = stepFlight(pw, { pitch: 0, roll: 0, isTucking: true }, 0.05); // 4 s passive level tuck
  check('passive level tuck ends below the catch pitch', pw.pitch < TUCK.catchPitch, `pitch=${pw.pitch}`);
  const prePassive = pw.speed;
  const released = stepFlight(pw, { pitch: 0, roll: 0, isTucking: false }, 0.05);
  check('releasing a weathercocked tuck continues the dive (no catch)',
    Math.abs(released.speed - prePassive) < 1 && released.vy === 0, `got ${released.speed} vs ${prePassive}`);

  // Releasing mid-dive (still steeply down) does NOT convert fall momentum —
  // the dive keeps trading altitude for speed on its own.
  let md = { x: 0, y: 300, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: -FLIGHT.maxPitch, roll: 0 };
  for (let i = 0; i < 120; i++) md = stepFlight(md, { pitch: -1, roll: 0, isTucking: true }, 0.05); // 6 s tuck dive
  const preDiveRelease = md.speed;
  const diveRelease = stepFlight(md, { pitch: 0, roll: 0, isTucking: false }, 0.05);
  check('mid-dive release gets no catch boost', Math.abs(diveRelease.speed - preDiveRelease) < 1.5 && diveRelease.vy === 0, `got ${diveRelease.speed} vs ${preDiveRelease}`);

  // --- excess airspeed preserved on release (no instant clamp) ---
  let hd = { x: 0, y: 300, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: -FLIGHT.maxPitch, roll: 0 };
  for (let i = 0; i < 600; i++) hd = stepFlight(hd, { pitch: -1, roll: 0, isTucking: true }, 0.05); // 30 s -> ceiling
  const preHigh = hd.speed;
  const pulledUp = stepFlight(hd, { pitch: 1, roll: 0, isTucking: false }, 0.05);
  check('un-tuck preserves dive speed above the normal ceiling',
    pulledUp.speed > FLIGHT.maxSpeed && pulledUp.speed >= preHigh - 2, `got ${pulledUp.speed} vs pre ${preHigh}`);

  // Full drag bleeds the excess off: holding the nose down settles at the normal ceiling.
  let decay = pulledUp;
  for (let i = 0; i < 600; i++) decay = stepFlight(decay, { pitch: 0, roll: 0 }, 0.05); // 30 s, nose held
  check('elevated ceiling closes after release',
    approx(decay.speed, FLIGHT.maxSpeed) && decay.tuckMomentum === 0, `got ${decay.speed}, momentum=${decay.tuckMomentum}`);

  // --- locked wings: roll & yaw authority damped while tucking ---
  let rFree = { x: 0, y: 20, z: 0, speed: 45, yaw: 0, pitch: -0.6, roll: 0 };
  let rTuck = { ...rFree };
  for (let i = 0; i < 50; i++) rFree = stepFlight(rFree, { pitch: 0, roll: 1 }, 0.05); // 2.5 s full bank input
  for (let i = 0; i < 50; i++) rTuck = stepFlight(rTuck, { pitch: 0, roll: 1, isTucking: true }, 0.05);
  check('roll authority locked while tucking',
    rTuck.roll > 0 && rTuck.roll < FLIGHT.maxRoll && rTuck.roll < rFree.roll, `tuck ${rTuck.roll} vs free ${rFree.roll}`);
  check('coordinated yaw damped while tucking', rTuck.yaw < rFree.yaw * 0.5, `tuck ${rTuck.yaw} vs free ${rFree.yaw}`);

  // --- input state handling: isTucking follows the held key ---
  const s0 = { x: 0, y: 100, z: 0, speed: FLIGHT.baseCruise, yaw: 0, pitch: -0.5, roll: 0 };
  const s1 = stepFlight(s0, { pitch: -1, roll: 0, isTucking: true }, 0.05);
  check('tuck flag set while key held', s1.isTucking === true);
  const s2 = stepFlight(s1, { pitch: -1, roll: 0, isTucking: true }, 0.05);
  check('tuck flag persists across steps', s2.isTucking === true);
  const s3 = stepFlight(s2, { pitch: -1, roll: 0, isTucking: false }, 0.05);
  check('tuck flag cleared on release', s3.isTucking === false);
}

// ---------------------------------------------------------------------------
console.log('\n[8] 750 m arena bounds & terrain heightmap');
{
  // World constants scale to the expanded arena.
  check('arena is 750 x 750', WORLD.size === 750 && WORLD.half === 375);

  // Boundary checks: center and edges inside, just outside rejected.
  check('center of arena is inside', isInsideArena(0, 0));
  check('edge points are inside (±half)',
    isInsideArena(WORLD.half, 0) && isInsideArena(-WORLD.half, WORLD.half) &&
    isInsideArena(WORLD.half, -WORLD.half));
  check('points just outside the edge are rejected',
    !isInsideArena(WORLD.half + 1, 0) && !isInsideArena(0, -WORLD.half - 1) &&
    !isInsideArena(-WORLD.half - 0.5, WORLD.half + 0.5));

  // Thermal count scaled up for the larger world (15-20 columns).
  check('thermal count scaled to 15-20', THERMAL.count >= 15 && THERMAL.count <= 20);

  // Heightmap sanity across the full arena: finite, bounded, with real relief.
  let minH = Infinity, maxH = -Infinity;
  for (let x = -WORLD.half; x <= WORLD.half; x += 15) {
    for (let z = -WORLD.half; z <= WORLD.half; z += 15) {
      const h = terrainHeight(x, z);
      if (!Number.isFinite(h)) minH = NaN;
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  }
  check('terrain heights finite across arena', Number.isFinite(minH) && Number.isFinite(maxH));
  check('valley floors stay low (min < 15 m)', minH < 15, `min=${minH}`);
  check('mountain peaks rise high (max > 60 m)', maxH > 60, `max=${maxH}`);
  check('heights stay within sane bounds', minH > -20 && maxH < 140, `range [${minH}, ${maxH}]`);

  // Central ridge: a high wall on both sides of the arch zone...
  const ridgeWest = terrainHeight(-150, ARCH.ridgeZ);
  const ridgeEast = terrainHeight(150, ARCH.ridgeZ);
  check('central ridge is a high wall west of the arch', ridgeWest > 40, `h=${ridgeWest}`);
  check('central ridge is a high wall east of the arch', ridgeEast > 40, `h=${ridgeEast}`);

  // ...and carved into a low tunnel through the opening.
  const gap = terrainHeight(0, ARCH.ridgeZ);
  check('tunnel floor is low at the opening center', gap < 30, `h=${gap}`);
  let gapLow = true;
  for (let x = -ARCH.openingHalf; x <= ARCH.openingHalf; x += 4) {
    if (terrainHeight(x, ARCH.ridgeZ) > 35) gapLow = false;
  }
  check('whole opening line stays flyable (< 35 m)', gapLow);

  // Cliff step at the carve boundary: rock face rises sharply just outside.
  const cliffIn = terrainHeight(ARCH.carveHalf - 4, ARCH.ridgeZ);
  const cliffOut = terrainHeight(ARCH.carveHalf + 6, ARCH.ridgeZ);
  check('rock face rises sharply at the carve boundary', cliffOut > cliffIn + 25, `in=${cliffIn} out=${cliffOut}`);

  // Spawn point is clear of the structure and above local ground.
  const spawnH = terrainHeight(0, 80);
  check('spawn sits in open valley (low ground)', spawnH < 30, `h=${spawnH}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('FAILED: ' + failures.join(', '));
  process.exit(1);
}
console.log('all physics checks passed');
