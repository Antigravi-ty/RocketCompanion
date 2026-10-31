export class LocalClientInputBuffer {
  constructor(capacity = 128) {
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.slots = new Array(capacity);
    this.neutralControls = {
      throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false
    };
    this.lastControlsByCar = new Map();
  }

  has(tick) {
    const entry = this.slots[tick & this.mask];
    return Boolean(entry && entry.tick === tick);
  }

  record(tick, carIndex, controls, allowOverwrite = false) {
    const slot = tick & this.mask;
    const existing = this.slots[slot];
    if (!allowOverwrite && existing && existing.tick === tick && existing.carIndex === carIndex) {
      this.lastControlsByCar.set(carIndex, { ...existing.controls });
      return existing.controls;
    }
    const cloned = { ...controls };
    this.slots[slot] = {
      tick,
      carIndex,
      controls: cloned
    };
    this.lastControlsByCar.set(carIndex, { ...cloned });
    return cloned;
  }

  get(tick) {
    const entry = this.slots[tick & this.mask];
    return (entry && entry.tick === tick) ? entry.controls : null;
  }

  getPreviousControls(tick, carIndex = 0) {
    for (let t = tick - 1; t >= Math.max(0, tick - this.capacity + 1); t--) {
      const prev = this.get(t);
      if (prev) return { ...prev };
    }
    return { ...(this.lastControlsByCar.get(carIndex) || this.neutralControls) };
  }

  getRedundantWindow(targetTick, count = 10, carIndex = 0) {
    const window = [];
    const startTick = Math.max(0, targetTick - count + 1);
    let fallback = this.getPreviousControls(startTick, carIndex);
    for (let t = startTick; t <= targetTick; t++) {
      const actual = this.get(t);
      if (!actual && t >= 0) {
        this.underflowCount = (this.underflowCount || 0) + 1;
        if (this.underflowCount <= 3 || this.underflowCount % 60 === 0) {
          console.warn(`[LocalClientInputBuffer] Missing predicted input at tick #${t} for car #${carIndex}, filling with previous action (total underflows: ${this.underflowCount})`);
        }
        this.record(t, carIndex, fallback);
      }
      const controls = actual || fallback;
      window.push({ tick: t, carIndex, controls: { ...controls } });
      fallback = controls;
    }
    return window;
  }

  clear() {
    this.slots.fill(undefined);
    this.lastControlsByCar.clear();
    this.underflowCount = 0;
  }
}
