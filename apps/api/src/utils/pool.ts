/**
 * Connection Pool & Resource Management Utility
 * Demonstrates Bug #6 (connection leak on error path) vs safe finally cleanup.
 */

export interface PooledConnection {
  id: number;
  inUse: boolean;
  acquiredAt: number;
  release: () => void;
}

export class ConnectionPool {
  private poolSize: number;
  private connections: PooledConnection[] = [];
  private totalAcquired: number = 0;
  private totalLeaked: number = 0;

  constructor(size: number = 10) {
    this.poolSize = size;
    for (let i = 1; i <= size; i++) {
      this.connections.push({
        id: i,
        inUse: false,
        acquiredAt: 0,
        release: () => {
          const conn = this.connections.find((c) => c.id === i);
          if (conn) {
            conn.inUse = false;
          }
        },
      });
    }
  }

  acquire(): PooledConnection {
    const available = this.connections.find((c) => !c.inUse);
    if (!available) {
      throw new Error(`[POOL EXHAUSTION] Connection pool exhausted (${this.poolSize}/${this.poolSize} connections in use)`);
    }
    available.inUse = true;
    available.acquiredAt = Date.now();
    this.totalAcquired++;
    return available;
  }

  /**
   * Buggy pattern (Bug #6):
   * Acquires connection, executes query, calls release() inside try block.
   * If an exception occurs, release() is bypassed and connection leaks permanently.
   */
  async executeBuggy<T>(operation: (conn: PooledConnection) => Promise<T>): Promise<T> {
    const conn = this.acquire();
    try {
      const result = await operation(conn);
      conn.release(); // Leaks if operation() throws!
      return result;
    } catch (error) {
      this.totalLeaked++;
      throw error;
    }
  }

  /**
   * Fixed safe pattern:
   * Guarantees release in `finally` block regardless of whether query succeeds or throws.
   */
  async executeSafe<T>(operation: (conn: PooledConnection) => Promise<T>): Promise<T> {
    let conn: PooledConnection | null = null;
    try {
      conn = this.acquire();
      return await operation(conn);
    } finally {
      if (conn) {
        conn.release(); // Always runs!
      }
    }
  }

  getStats() {
    const inUseCount = this.connections.filter((c) => c.inUse).length;
    return {
      totalSize: this.poolSize,
      inUse: inUseCount,
      available: this.poolSize - inUseCount,
      totalAcquired: this.totalAcquired,
      totalLeaked: this.totalLeaked,
    };
  }

  reset() {
    for (const conn of this.connections) {
      conn.inUse = false;
    }
    this.totalAcquired = 0;
    this.totalLeaked = 0;
  }
}

export const dbPool = new ConnectionPool(10);

/**
 * Bulkhead Isolation Architecture (Bug #10 Fix):
 * Separate connection pools ensure worker failure/retries cannot exhaust API connection pool.
 */
export const apiPool = new ConnectionPool(17);
export const workerPool = new ConnectionPool(3);
export const sharedUnisolatedPool = new ConnectionPool(20);

