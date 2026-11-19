export type RuntimeResourceScope = 'session' | 'replay' | 'ai';

export interface RuntimeDisposableResource {
  readonly id: string;
  readonly scope: RuntimeResourceScope;
  dispose: () => void | Promise<void>;
}

/**
 * Centralized lifecycle registry for heavyweight runtime buffers, caches, and GPU/WASM slots.
 * Supports scoped disposal (`'replay'`, `'ai'`, `'session'`) on mode transitions and clean resets.
 */
export class RuntimeResourceRegistry {
  private readonly resources = new Map<string, RuntimeDisposableResource>();

  public register(resource: RuntimeDisposableResource): () => void {
    this.resources.set(resource.id, resource);
    return () => {
      const current = this.resources.get(resource.id);
      if (current === resource) {
        this.resources.delete(resource.id);
      }
    };
  }

  public unregister(id: string): boolean {
    return this.resources.delete(id);
  }

  public has(id: string): boolean {
    return this.resources.has(id);
  }

  public getRegisteredIds(scope?: RuntimeResourceScope): string[] {
    const ids: string[] = [];
    for (const [id, resource] of this.resources) {
      if (!scope || resource.scope === scope) {
        ids.push(id);
      }
    }
    return ids;
  }

  public async disposeScope(scope: RuntimeResourceScope): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const resource of this.resources.values()) {
      if (resource.scope !== scope) continue;
      try {
        const result = resource.dispose();
        if (result && typeof (result as Promise<void>).then === 'function') {
          pending.push(
            Promise.resolve(result).catch((err: unknown) => {
              console.warn(`[RuntimeResourceRegistry] Failed to dispose "${resource.id}":`, err);
            })
          );
        }
      } catch (err: unknown) {
        console.warn(`[RuntimeResourceRegistry] Failed to dispose "${resource.id}":`, err);
      }
    }
    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }

  public async disposeScopes(scopes: readonly RuntimeResourceScope[]): Promise<void> {
    for (const scope of scopes) {
      await this.disposeScope(scope);
    }
  }

  public async disposeAll(): Promise<void> {
    await this.disposeScopes(['replay', 'ai', 'session']);
  }
}

export const runtimeResourceRegistry = new RuntimeResourceRegistry();
