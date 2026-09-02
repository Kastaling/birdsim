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

export const GRAB = Object.freeze({
  radius: 6,           // m   — horizontal grab radius around prey
  altitudeMax: 5,      // m   — max bird height above the prey to trigger a grab
  scoreGrab: 25,       // points awarded on grab
  scoreLaunch: 75,     // points awarded when the payload lands after launch
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
export function computeSpeedAccel(speed, pitch) {
  const gravityComponent = -FLIGHT.diveAccel * Math.sin(pitch);
  const drag = (FLIGHT.baseCruise - speed) * FLIGHT.dragCoeff;
  return gravityComponent + drag;
}

// Advance the flight state one step. `input` = { pitch: -1..1, roll: -1..1 }
// (pitch +1 climbs / nose up, roll +1 banks left). Returns a new state object.
export function stepFlight(state, input, dt) {
  const pitch = clamp(
    state.pitch + (input.pitch || 0) * FLIGHT.pitchRate * dt,
    -FLIGHT.maxPitch,
    FLIGHT.maxPitch,
  );

  let roll = state.roll + (input.roll || 0) * FLIGHT.rollRate * dt;
  if (!input.roll) roll -= roll * Math.min(1, FLIGHT.rollDamping * dt); // self-level
  roll = clamp(roll, -FLIGHT.maxRoll, FLIGHT.maxRoll);

  // Auto-coordinated yaw: the turn follows the bank (bank left -> turn left).
  const yaw = state.yaw + Math.sin(roll) * FLIGHT.yawCoordination * dt;

  const speed = clamp(
    state.speed + computeSpeedAccel(state.speed, pitch) * dt,
    FLIGHT.minSpeed,
    FLIGHT.maxSpeed,
  );

  const f = forwardVector(yaw, pitch);
  return {
    x: state.x + f.x * speed * dt,
    y: state.y + f.y * speed * dt,
    z: state.z + f.z * speed * dt,
    yaw,
    pitch,
    roll,
    speed,
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
