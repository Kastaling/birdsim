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
// the wings in, slashing drag so a steep dive trades altitude for extreme
// airspeed. Releasing while pitching up converts the accumulated dive momentum
// into a forward speed burst as full aerodynamics re-engage.
export const TUCK = Object.freeze({
  dragFactor: 0.25,     // keep 25% of normal drag while tucking (75% reduction)
  diveAccel: 18,        // m/s² — extra longitudinal accel at full vertical dive
  maxSpeed: 90,         // m/s   — elevated speed ceiling while tucking / with residual momentum
  rollFactor: 0.15,     // roll input authority multiplier (locked wings)
  yawFactor: 0.25,      // auto-coordinated turn rate multiplier (locked wings)
  momentumGain: 1.0,    // excess airspeed accumulated into dive momentum per second
  momentumCap: 40,      // m/s — cap on accumulated dive momentum
  burstFactor: 0.6,     // fraction of momentum converted to a forward burst on un-tuck while pitching up
  burstResidual: 0.5,   // residual momentum kept after the burst (keeps the elevated ceiling open)
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

// Longitudinal speed dynamics: diving (pitch < 0) trades altitude for airspeed,
// climbing (pitch > 0) trades airspeed for altitude; drag relaxes toward cruise.
// While tucking (`isTucking`), drag is cut to TUCK.dragFactor of normal and an
// extra dive acceleration applies while pointing downward — together they raise
// the terminal velocity well above the normal FLIGHT.maxSpeed ceiling.
export function computeSpeedAccel(speed, pitch, isTucking = false) {
  const dragCoeff = isTucking ? FLIGHT.dragCoeff * TUCK.dragFactor : FLIGHT.dragCoeff;
  let accel = -FLIGHT.diveAccel * Math.sin(pitch);
  if (isTucking && pitch < 0) {
    // Locked-wing dive: extra acceleration while pointing downward.
    accel += TUCK.diveAccel * (-Math.sin(pitch));
  }
  const drag = (FLIGHT.baseCruise - speed) * dragCoeff;
  return accel + drag;
}

// Advance the flight state one step. `input` = { pitch: -1..1, roll: -1..1,
// isTucking?: boolean } (pitch +1 climbs / nose up, roll +1 banks left). The
// tuck flag comes from held input each frame and is recorded on the returned
// state; releasing it while pitching up converts accumulated dive momentum into
// a forward speed burst. Returns a new state object.
export function stepFlight(state, input = {}, dt) {
  const wasTucking = !!state.isTucking;
  const isTucking = !!input.isTucking;

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

  // Longitudinal speed: reduced drag + extra dive accel while tucking.
  let speed = state.speed + computeSpeedAccel(state.speed, pitch, isTucking) * dt;

  // Speed ceiling: elevated while tucking or while residual dive momentum from a
  // recent un-tuck keeps the excess airspeed above the normal FLIGHT.maxSpeed.
  const hasMomentum = (state.tuckMomentum || 0) > 0;
  const ceiling = (isTucking || hasMomentum) ? TUCK.maxSpeed : FLIGHT.maxSpeed;
  speed = clamp(speed, FLIGHT.minSpeed, ceiling);

  // Dive momentum bookkeeping: accumulates from excess airspeed above cruise
  // while tucking in a dive, bleeds off after release as full drag re-engages.
  let tuckMomentum = state.tuckMomentum || 0;
  if (isTucking && pitch < 0) {
    const excess = Math.max(0, speed - FLIGHT.baseCruise);
    tuckMomentum = Math.min(TUCK.momentumCap, tuckMomentum + excess * TUCK.momentumGain * dt);
  } else if (!isTucking) {
    tuckMomentum = Math.max(0, tuckMomentum - TUCK.momentumDecay * dt);
  }

  // Un-tuck burst: releasing the tuck while pitching up to catch the air
  // converts accumulated dive momentum into a forward speed boost. A residual
  // keeps the elevated ceiling open so full drag bleeds the excess off gradually
  // instead of clamping it away instantly.
  if (wasTucking && !isTucking && (input.pitch || 0) > 0 && tuckMomentum > 0) {
    speed += tuckMomentum * TUCK.burstFactor;
    speed = clamp(speed, FLIGHT.minSpeed, TUCK.maxSpeed);
    tuckMomentum = Math.max(0, speed - FLIGHT.baseCruise) * TUCK.burstResidual;
  }

  const f = forwardVector(yaw, pitch);
  return {
    x: state.x + f.x * speed * dt,
    y: state.y + f.y * speed * dt,
    z: state.z + f.z * speed * dt,
    yaw,
    pitch,
    roll,
    speed,
    isTucking,
    tuckMomentum,
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
