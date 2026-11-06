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

export interface EntityPhysicsPort {
  numCars: number;
  addCar(team: number, hitbox?: string): unknown;
  removeCar?(slot: number): void;
  setCarHitbox?(slot: number, hitbox: string): void;
}

export interface EntityArenaPort {
  cars?: unknown[];
  addCar(team: number, visual?: string): unknown;
  removeCar?(slot: number): void;
  swapCarVisual?(slot: number, visual: string): void;
}

export interface EntityManagerOptions {
  physics?: EntityPhysicsPort | null;
  arena?: EntityArenaPort | null;
}

export interface SpawnVehicleOptions {
  team?: number;
  visual?: string;
  hitbox?: string;
  isPlayer?: boolean;
  isBot?: boolean;
  controller?: unknown;
}

export interface HotSwapVehicleOptions {
  visual?: string;
  hitbox?: string;
}

export interface EntityDescriptor {
  slot: number;
  team: number;
  visual: string;
  hitbox: string;
  isPlayer: boolean;
  isBot: boolean;
  controller: unknown;
}

export class EntityManager {
  public arena: EntityArenaPort | null;
  public entities: Map<number, EntityDescriptor>;
  public physics: EntityPhysicsPort | null;

  constructor(options: EntityManagerOptions = {}) {
    this.physics = options.physics || null;
    this.arena = options.arena || null;
    this.entities = new Map();
  }

  setPhysics(physics: EntityPhysicsPort | null) {
    this.physics = physics;
  }

  setArena(arena: EntityArenaPort | null) {
    this.arena = arena;
  }

  /**
   * Spawn a new vehicle entity in both physics simulation and visual arena
   */
  spawnVehicle(slot: number, options: SpawnVehicleOptions = {}): EntityDescriptor {
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

    const entity: EntityDescriptor = {
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
   */
  despawnVehicle(slot: number): boolean {
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
   */
  hotSwapVehicle(slot: number, options: HotSwapVehicleOptions = {}): boolean {
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
