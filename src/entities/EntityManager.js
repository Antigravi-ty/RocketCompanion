/**
 * Bridges Gameplay/Match orchestration with:
 * - ArenaWorld (Three.js Visual Entity Hierarchy)
 * - RocketSimPhysicsEngine (Deterministic 120Hz WASM Physics)
 *
 * Architecture & Responsibilities:
 * 1. Decouples Controller possession (Player, AI Bot, Network Client) from Vehicle Pawns.
 * 2. Unified Pawn Lifecycle: spawnVehicle, despawnVehicle, replaceVehicle, hotSwapVehicle.
 * 3. Shared across Single Player (direct zero-latency physics) and Multiplayer (authoritative session).
 * 4. Enables zero-reload in-place vehicle hot-swapping without resetting match state.
 */

export class EntityManager {
  /**
   * @param {object} [options={}]
   * @param {import('../physics/RocketSimPhysicsEngine.js').RocketSimPhysicsEngine} [options.physics]
   * @param {import('./ArenaWorld.js').ArenaWorld} [options.arena]
   */
  constructor(options = {}) {
    this.physics = options.physics || null;
    this.arena = options.arena || null;

    /**
     * Map of slot (carIndex) -> EntityDescriptor
     * @type {Map<number, { slot: number, team: number, visual: string, hitbox: string, isPlayer: boolean, isBot: boolean, controller: any }>}
     */
    this.entities = new Map();
  }

  setPhysics(physics) {
    this.physics = physics;
  }

  setArena(arena) {
    this.arena = arena;
  }

  /**
   * Spawn a new vehicle entity in both physics simulation and visual arena
   * @param {number} slot
   * @param {object} [options={}]
   * @param {number} [options.team=0]
   * @param {string} [options.visual='fennec']
   * @param {string} [options.hitbox='default']
   * @param {boolean} [options.isPlayer=false]
   * @param {boolean} [options.isBot=false]
   * @param {any} [options.controller=null]
   * @returns {object} EntityDescriptor
   */
  spawnVehicle(slot, options = {}) {
    const {
      team = 0,
      visual = 'fennec',
      hitbox = visual,
      isPlayer = false,
      isBot = false,
      controller = null
    } = options;

    // 1. Ensure physics entity exists
    if (this.physics) {
      if (this.physics.numCars <= slot) {
        while (this.physics.numCars <= slot) {
          const t = this.physics.numCars === slot ? team : (slot === 0 ? 0 : 1);
          this.physics.addCar(t, hitbox);
        }
      }
    }

    // 2. Ensure visual representation exists in ArenaWorld
    if (this.arena) {
      if (!this.arena.cars || !this.arena.cars[slot]) {
        this.arena.addCar(team, visual);
      }
    }

    const entity = {
      slot,
      team,
      visual,
      hitbox,
      isPlayer,
      isBot,
      controller
    };

    this.entities.set(slot, entity);
    return entity;
  }

  /**
   * Despawn a vehicle entity from both physics simulation and visual scene
   * @param {number} slot
   * @returns {boolean}
   */
  despawnVehicle(slot) {
    const entity = this.entities.get(slot);
    if (!entity) return false;

    // 1. Release controller
    entity.controller = null;

    // 2. Remove from visual scene
    if (this.arena && typeof this.arena.removeCar === 'function') {
      this.arena.removeCar(slot);
    }

    // 3. Remove from physics simulation
    if (this.physics && typeof this.physics.removeCar === 'function') {
      this.physics.removeCar(slot);
    }

    this.entities.delete(slot);
    return true;
  }

  /**
   * In-place Hot Swap: Update visual appearance and physical hitbox without restarting arena
   * @param {number} slot
   * @param {object} options
   * @param {string} [options.visual]
   * @param {string} [options.hitbox]
   * @returns {boolean}
   */
  hotSwapVehicle(slot, options = {}) {
    const entity = this.entities.get(slot);
    const newVisual = options.visual || entity?.visual || 'fennec';
    const newHitbox = options.hitbox || options.visual || entity?.hitbox || 'default';

    // 1. Visual hot-swap in ArenaWorld (in-place mesh and wheel updates)
    if (this.arena && typeof this.arena.swapCarVisual === 'function') {
      this.arena.swapCarVisual(slot, newVisual);
    }

    // 2. Physics hitbox hot-swap in RocketSim WASM
    if (this.physics && typeof this.physics.setCarHitbox === 'function') {
      this.physics.setCarHitbox(slot, newHitbox);
    }

    if (entity) {
      entity.visual = newVisual;
      entity.hitbox = newHitbox;
    } else {
      this.entities.set(slot, {
        slot,
        team: slot === 0 ? 0 : 1,
        visual: newVisual,
        hitbox: newHitbox,
        isPlayer: slot === 0,
        isBot: slot > 0,
        controller: null
      });
    }

    return true;
  }

  /**
   * Possess a vehicle with a controller
   * @param {any} controller
   * @param {number} slot
   */
  possess(controller, slot) {
    const entity = this.entities.get(slot);
    if (entity) {
      entity.controller = controller;
    }
  }

  /**
   * Unpossess a vehicle
   * @param {number} slot
   */
  unpossess(slot) {
    const entity = this.entities.get(slot);
    if (entity) {
      entity.controller = null;
    }
  }

  getVehicle(slot) {
    return this.entities.get(slot);
  }

  hasVehicle(slot) {
    return this.entities.has(slot);
  }

  get activeVehicleCount() {
    return this.entities.size;
  }

  dispose() {
    for (const slot of Array.from(this.entities.keys())) {
      this.despawnVehicle(slot);
    }
    this.entities.clear();
  }
}
