// Pure flight & payload dynamics for the birdsim arcade model.
// No three.js / DOM dependencies — kept importable from plain Node so the
// test harness (.scratch/test-physics.js) can validate the math directly.

export const FLIGHT = Object.freeze({
  minSpeed: 8,         // m/s   — stall floor
  maxSpeed: 60,        // m/s   — dive ceiling
  baseCruise: 24,      // m/s   — relaxed level-flight speed
  dragCoeff: 0.15,     // 1/s   — relaxation of speed toward cruise
  diveAccel: 9,        // m/s²  — airspeed gained per unit sin(pitch) while diving
  pitchRate: 1.5,      // rad/s at full input
  maxPitch: 1.35,      // rad (~77°) nose authority limit
  rollRate: 2.6,       // rad/s at full input
  maxRoll: 1.35,       // rad   — bank limit
  rollDamping: 1.4,    // 1/s   — self-leveling when no lateral input
  yawCoordination: 1.6,// rad/s of turn per unit sin(bank) — auto-coordinated yaw
  gravity: 18,         // m/s²  — arcade gravity for dropped payload
});

// Wing-tuck dive mechanic: holding the tuck key (Shift / left trigger) folds
// the wings in — ~90% of aerodynamic lift is lost and drag is slashed. With no
// lift to hold airspeed or support weight, a level/pitched-up tuck bleeds off
// horizontal speed and drops in a ballistic arc under gravity; only pointing
// the nose down trades altitude for airspeed (gravity along the flight path —
// there is no artificial accelerator). Releasing while level or pitched up
// catches the air: vertical fall momentum converts back into forward glide
// speed as full aerodynamic lift re-engages.
export const TUCK = Object.freeze({
  liftFactor: 0.1,      // fraction of normal aerodynamic lift retained (90% reduction)
  diveDrag: 0.08,       // 1/s — reduced drag opposing the gravity gain in a locked-wing dive
  levelBleed: 0.35,     // 1/s — horizontal speed bleed when tucked level/pitched-up (no lift to hold airspeed)
  fallGravity: 9,       // m/s² — ballistic fall acceleration while tucking (matches FLIGHT.diveAccel dive gravity)
  maxFallSpeed: 32,     // m/s — terminal vertical fall speed while tucking
  catchPitch: -0.4,     // rad (~-23°) — releasing at or above this pitch catches the air; steeper stays in the dive
  catchFactor: 0.85,    // fraction of vertical fall momentum converted to forward glide on wing re-engage
  residualBank: 0.5,    // fraction of excess airspeed above cruise banked as residual momentum on release
  rollFactor: 0.15,     // roll input authority multiplier (locked wings)
  yawFactor: 0.25,      // auto-coordinated turn rate multiplier (locked wings)
  maxSpeed: 90,         // m/s — elevated speed ceiling while tucking / with residual momentum
  momentumDecay: 12,    // m/s per second that residual momentum bleeds off after release
});

export const GRAB = Object.freeze({
  radius: 6,           // m   — horizontal grab radius around prey
  altitudeMax: 5,      // m   — max bird height above the prey to trigger a grab
  scoreGrab: 25,       // points awarded on grab
  scoreLaunch: 75,     // legacy flat landing bonus (superseded by impactScore)
});

export const THERMAL = Object.freeze({
  count: 5,          // updraft columns scattered around the arena
  radius: 13,        // m   — horizontal core radius of a column
  liftAccel: 6,      // m/s² peak vertical updraft at column center
  speedRegen: 8,     // m/s airspeed recovered per second at full strength
  topAltitude: 150,  // m AGL — columns taper out above this
  particleCount: 36, // rising particles per column (visual plume)
});

export const IMPACT = Object.freeze({
  mass: 1,          // kg — normalized prey mass for the energy model
  refEnergy: 1800,  // J  — impact energy that maps to maxScore (~100 m drop from rest)
  minScore: 15,     // points for a gentle landing
  maxScore: 250,    // points at reference-energy impact
});

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// Unit forward vector for the bird's orientation (yaw around Y, pitch around X).
// Matches quaternion composition q = Ry(yaw) * Rx(pitch) * Rz(roll) applied to (0, 0, -1);
// note (0,0,-1) is invariant under roll, so only yaw and pitch affect the nose direction.
export function forwardVector(yaw, pitch) {
  return {
    x: -Math.cos(pitch) * Math.sin(yaw),
    y: Math.sin(pitch),
    z: -Math.cos(pitch) * Math.cos(yaw),
  };
}

// Longitudinal speed dynamics. Gravity along the flight path is the only source
// of speed gain in a dive (pitch < 0): altitude converts to airspeed at
// FLIGHT.diveAccel per unit sin(pitch); climbing trades it back for altitude.
// With wings out, drag relaxes toward cruise. While tucking (`isTucking`) lift
// is ~90% gone: nothing maintains airspeed — a dive keeps only the gravity gain
// minus reduced drag (raising terminal velocity above FLIGHT.maxSpeed), and
// level/pitched-up flight bleeds horizontal speed off instead of holding it.
export function computeSpeedAccel(speed, pitch, isTucking = false) {
  let accel = -FLIGHT.diveAccel * Math.sin(pitch); // altitude <-> airspeed trade
  if (isTucking) {
    if (pitch < 0) {
      // Locked-wing dive: no lift, no cruise maintenance — only reduced drag
      // opposes the gravitational gain.
      accel -= speed * TUCK.diveDrag;
    } else {
      // Level or pitched up with no lift to hold airspeed: bleed off.
      accel -= speed * TUCK.levelBleed;
    }
  } else {
    accel += (FLIGHT.baseCruise - speed) * FLIGHT.dragCoeff; // drag relaxes toward cruise
  }
  return accel;
}

// Advance the flight state one step. `input` = { pitch: -1..1, roll: -1..1,
// isTucking?: boolean } (pitch +1 climbs / nose up, roll +1 banks left). The
// tuck flag comes from held input each frame and is recorded on the returned
// state. While tucking, lift is ~90% gone: horizontal speed bleeds off unless
// the nose points down into a dive, and the bird drops in a ballistic arc under
// gravity tracked as `vy` (vertical fall velocity, negative = falling).
// Releasing while level or pitched up catches the air — vertical fall momentum
// converts to forward glide speed and full aerodynamic lift re-engages.
// Returns a new state object.
export function stepFlight(state, input = {}, dt) {
  const wasTucking = !!state.isTucking;
  const isTucking = !!input.isTucking;
  let vy = state.vy || 0; // vertical fall velocity (m/s, negative = falling); tuck only

  // Pitch authority is unchanged by the tuck — pulling out of a dive still works.
  const pitch = clamp(
    state.pitch + (input.pitch || 0) * FLIGHT.pitchRate * dt,
    -FLIGHT.maxPitch,
    FLIGHT.maxPitch,
  );

  // Roll: locked/damped while tucking (wings folded against the body).
  const rollAuthority = isTucking ? TUCK.rollFactor : 1;
  let roll = state.roll + (input.roll || 0) * FLIGHT.rollRate * rollAuthority * dt;
  if (!input.roll) roll -= roll * Math.min(1, FLIGHT.rollDamping * dt); // self-level
  roll = clamp(roll, -FLIGHT.maxRoll, FLIGHT.maxRoll);

  // Auto-coordinated yaw: the turn follows the bank (bank left -> turn left),
  // damped while tucking since the locked wings generate little turning force.
  const yawAuthority = isTucking ? TUCK.yawFactor : 1;
  const yaw = state.yaw + Math.sin(roll) * FLIGHT.yawCoordination * yawAuthority * dt;

  // Longitudinal speed: gravity trade in a dive; bleed when level/pitched-up tucked.
  let speed = state.speed + computeSpeedAccel(state.speed, pitch, isTucking) * dt;

  // Ballistic fall while tucking: with lift gone the bird drops under gravity.
  // The component of gravity perpendicular to the flight path feeds vertical fall
  // velocity — full when level (cos 0 = 1), none in a vertical dive where all of
  // gravity already converts along the nose into airspeed. Residual lift slows it slightly.
  if (isTucking) {
    vy -= TUCK.fallGravity * Math.cos(pitch) * (1 - TUCK.liftFactor) * dt;
    vy = clamp(vy, -TUCK.maxFallSpeed, 0);
  }

  // Residual dive momentum: banked on release from excess airspeed above cruise,
  // bleeds off as full drag re-engages.
  let tuckMomentum = state.tuckMomentum || 0;

  // Wing re-engage: releasing the tuck while level or pitched up catches the air —
  // vertical fall momentum converts to forward glide speed. Releasing mid-dive
  // (still steeply down) gets no catch; the dive keeps trading altitude for speed.
  if (wasTucking && !isTucking) {
    if (vy < 0 && pitch >= TUCK.catchPitch) {
      speed += -vy * TUCK.catchFactor;
    }
    // Bank excess airspeed above cruise so the elevated ceiling stays open while
    // full drag bleeds it off gradually instead of clamping it away instantly.
    tuckMomentum = Math.max(tuckMomentum, Math.max(0, speed - FLIGHT.baseCruise) * TUCK.residualBank);
  }

  // Speed ceiling: elevated while tucking or while residual dive momentum from a
  // recent un-tuck keeps the excess airspeed above the normal FLIGHT.maxSpeed.
  const hasMomentum = tuckMomentum > 0;
  const ceiling = (isTucking || hasMomentum) ? TUCK.maxSpeed : FLIGHT.maxSpeed;
  speed = clamp(speed, FLIGHT.minSpeed, ceiling);

  if (!isTucking) {
    tuckMomentum = Math.max(0, tuckMomentum - TUCK.momentumDecay * dt);
  }

  if (!isTucking) vy = 0; // lift restored — no residual fall velocity outside a tuck

  const f = forwardVector(yaw, pitch);
  return {
    x: state.x + f.x * speed * dt,
    y: state.y + (f.y * speed + vy) * dt,
    z: state.z + f.z * speed * dt,
    yaw,
    pitch,
    roll,
    speed,
    isTucking,
    tuckMomentum,
    vy,
  };
}

// Grab check: the bird must be low enough above the prey (relative altitude)
// and close enough horizontally. Positions are plain {x,y,z}.
export function canGrab(birdPos, preyPos) {
  const dx = birdPos.x - preyPos.x;
  const dz = birdPos.z - preyPos.z;
  const dy = birdPos.y - preyPos.y; // bird altitude above the prey's ground level
  return dx * dx + dz * dz <= GRAB.radius ** 2 && dy >= 0 && dy <= GRAB.altitudeMax;
}

// Launch velocity for a dropped payload: the bird's forward velocity vector.
export function launchVelocity(forward, speed) {
  return { x: forward.x * speed, y: forward.y * speed, z: forward.z * speed };
}

// Semi-implicit Euler integration of a launched payload under gravity.
// Mutates and returns p = {x,y,z,vx,vy,vz}.
export function stepProjectile(p, dt) {
  p.vy -= FLIGHT.gravity * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;
  return p;
}

// Updraft strength of a thermal column at a point. `agl` is altitude above the
// local ground (m); t = {x, z} is the column center. Returns 0..1 where 1 is
// full-strength core lift: radial falloff from 1 (center) to 0 (edge), and a
// vertical taper that weakens with altitude but never drops below 35%.
export function thermalStrength(x, z, agl, t) {
  if (agl < 0 || agl > THERMAL.topAltitude) return 0;
  const dx = x - t.x;
  const dz = z - t.z;
  const r2 = dx * dx + dz * dz;
  const rMax2 = THERMAL.radius ** 2;
  if (r2 >= rMax2) return 0;
  const radial = Math.sqrt(1 - r2 / rMax2);                    // 1 at center → 0 at edge
  const vertical = clamp(1 - agl / THERMAL.topAltitude, 0.35, 1); // weaker aloft
  return radial * vertical;
}

// Kinetic energy (J) of a ground impact at `speed` m/s: E = ½mv². The speed is
// the payload's total impact velocity, which already encodes both drop altitude
// (gravity acceleration during the fall) and launch velocity.
export function impactEnergy(speed) {
  return 0.5 * IMPACT.mass * speed * speed;
}

// Arcade score for a ground impact: scales with kinetic energy, clamped to
// [minScore, maxScore]. A ~100 m drop from rest under arcade gravity hits at
// sqrt(2·g·h) ≈ 60 m/s → exactly refEnergy → maxScore.
export function impactScore(speed) {
  const t = clamp(impactEnergy(speed) / IMPACT.refEnergy, 0, 1);
  return Math.round(IMPACT.minScore + t * (IMPACT.maxScore - IMPACT.minScore));
}
