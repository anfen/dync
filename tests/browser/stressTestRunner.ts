/**
 * Shared Stress Test Logic
 *
 * This module contains the core stress test logic that can be run in both
 * Node.js (via Vitest) and browser (via Playwright) environments.
 */

import type { StorageAdapter } from '../../src/storage/types';
import type { TableSchemaDefinition } from '../../src/storage/sqlite/schema';
import { Dync, type ApiFunctions, type SyncOptions } from '../../src/index';
import { LOCAL_PK } from '../../src/types';

// =============================================================================
// Types
// =============================================================================

type Item = {
    id?: number;
    _localId: string;
    name: string;
    updated_at?: string;
    deleted: boolean;
};

interface StressTables {
    items: Omit<Item, 'deleted'>;
}

export interface StressTestResult {
    success: boolean;
    clientCount: number;
    serverCount: number;
    duration: number;
    error?: string;
}

export interface StressTestOptions {
    opCount?: number;
    errorRate?: number;
    maxDelayMs?: number;
    syncInterval?: number;
    timeoutMs?: number;
}

export type StorageAdapterFactory = (dbName: string) => StorageAdapter | Promise<StorageAdapter>;

// =============================================================================
// Deterministic UUID Generator
// =============================================================================

let uuidCounter = 0;

export function resetUuidCounter(): void {
    uuidCounter = 0;
}

export function createLocalId(): string {
    return `local-${++uuidCounter}-${Date.now().toString(36)}`;
}

// =============================================================================
// Faulty API Mock
// =============================================================================

function makeFaultyApis(opts: { errorRate?: number; maxDelayMs?: number } = {}) {
    const errorRate = opts.errorRate ?? 0.05;
    const maxDelay = opts.maxDelayMs ?? 30;

    // Small seeded PRNG for reproducibility
    let seed = 123456789;
    function rand() {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    }

    let idCounter = 0;
    const server: Item[] = [];

    function maybeDelay() {
        const d = Math.floor(rand() * maxDelay);
        return new Promise((r) => setTimeout(r, d));
    }

    function maybeThrow(endpoint: string) {
        if (rand() < errorRate) throw new Error(`random ${endpoint} failure`);
    }

    const apis = {
        items: {
            add: async (item: any) => {
                await maybeDelay();
                maybeThrow('add');
                const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                server.push(rec as Item);
                return { id: rec.id, updated_at: rec.updated_at };
            },
            update: async (id: number, changes: any) => {
                await maybeDelay();
                maybeThrow('update');
                const rec = server.find((r) => r.id === id);
                if (!rec) return false;
                Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                return true;
            },
            remove: async (id: number) => {
                await maybeDelay();
                maybeThrow('remove');
                const rec = server.find((r) => r.id === id);
                if (rec) rec.deleted = true;
            },
            list: async (lastUpdatedAt: Date) => {
                await maybeDelay();
                maybeThrow('list');
                return server.filter((r) => new Date(r.updated_at!) > lastUpdatedAt).map((r) => ({ ...r }));
            },
            firstLoad: async (_lastId: any) => {
                await maybeDelay();
                maybeThrow('firstLoad');
                return [] as any[];
            },
        },
    } as const;

    return { apis, server } as const;
}

// =============================================================================
// Schema Definitions
// =============================================================================

const dexieSchema: Record<keyof StressTables, TableSchemaDefinition> = {
    items: 'name',
};

// SQLite schema - only define user columns, sync columns are auto-injected
const sqliteSchema: Record<keyof StressTables, TableSchemaDefinition> = {
    items: {
        columns: {
            name: { type: 'TEXT', nullable: true },
        },
    },
};

// =============================================================================
// Stress Test Runner
// =============================================================================

export async function runStressTest(
    adapterFactory: StorageAdapterFactory,
    options: StressTestOptions = {},
    useSqliteSchema = false,
): Promise<StressTestResult> {
    const { opCount = 2000, errorRate = 0.06, maxDelayMs = 40, syncInterval = 15, timeoutMs = 180_000 } = options;

    const startTime = Date.now();
    resetUuidCounter();

    try {
        const { apis, server } = makeFaultyApis({ errorRate, maxDelayMs });
        const schema = useSqliteSchema ? sqliteSchema : dexieSchema;
        const dbName = `stress-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Create adapter (may be async for WaSqlite)
        const adapter = await adapterFactory(dbName);

        const syncOptions: SyncOptions = {
            syncInterval,
            minLogLevel: 'none',
            logger: console,
            missingRemoteRecordDuringUpdateStrategy: 'ignore',
            conflictResolutionStrategy: 'try-shallow-merge',
        };

        const db = new Dync<StressTables>(dbName, apis as Record<string, ApiFunctions>, adapter, syncOptions);
        db.version(1).stores(schema as Record<string, TableSchemaDefinition>);

        await db.sync.enable(true);

        const table = db.table('items');
        let id = 0;

        const addItem = async (name: string) => {
            try {
                const key = await table.add({ id: ++id, name });
                const record = key !== undefined ? await table.get(key as any) : null;
                return record?._localId;
            } catch {
                return undefined;
            }
        };

        const updateItem = async (localId: string, changes: Partial<Item>) => {
            try {
                await table.where(LOCAL_PK).equals(localId).modify(changes);
            } catch {
                // ignore
            }
        };

        const removeItem = async (localId: string) => {
            try {
                await table.where(LOCAL_PK).equals(localId).delete();
            } catch {
                // ignore
            }
        };

        const ops: Promise<void>[] = [];
        const localIds: string[] = [];

        // Small seeded PRNG for operation choices
        let seed = 987654321;
        function rand() {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        }

        // Enqueue all operations
        for (let i = 0; i < opCount; i++) {
            const delay = Math.floor(rand() * 20);
            const p = new Promise<void>((res) =>
                setTimeout(async () => {
                    try {
                        const r = rand();
                        if (r < 0.45 || localIds.length === 0) {
                            const localId = await addItem(`name-${i}`);
                            if (localId) localIds.push(localId);
                        } else if (r < 0.85) {
                            const idx = Math.floor(rand() * localIds.length);
                            const lid = localIds[idx];
                            if (lid) await updateItem(lid, { name: `u-${i}` });
                        } else {
                            const idx = Math.floor(rand() * localIds.length);
                            const lid = localIds.splice(idx, 1)[0];
                            if (lid) await removeItem(lid);
                        }
                    } catch {
                        // ignore runtime errors
                    } finally {
                        res();
                    }
                }, delay),
            );
            ops.push(p);
        }

        // Wait for all operations to complete
        await Promise.all(ops);

        // Wait for sync to settle
        const deadline = Date.now() + timeoutMs;
        while (true) {
            const syncState = db.sync.state;
            const items = await table.toArray();
            const pending = syncState.pendingChanges?.length ?? 0;
            const missingIds = items.some((it: any) => !it.id);

            if (pending === 0 && !missingIds) {
                break;
            }

            if (Date.now() > deadline) {
                throw new Error('Timed out waiting for sync to settle');
            }

            await new Promise((r) => setTimeout(r, 50));
        }

        await db.sync.enable(false);

        const items = await table.toArray();

        // Compare server and client
        const serverVisible = server.filter((s) => !s.deleted).map((s) => ({ id: s.id, name: s.name }));
        const clientVisible = items.map((i: any) => ({ id: i.id, name: i.name }));

        const sortFn = (a: any, b: any) => a.id - b.id;
        serverVisible.sort(sortFn);
        clientVisible.sort(sortFn);

        await db.close();

        // Verify convergence
        if (clientVisible.length !== serverVisible.length) {
            return {
                success: false,
                clientCount: clientVisible.length,
                serverCount: serverVisible.length,
                duration: Date.now() - startTime,
                error: `Count mismatch: client=${clientVisible.length}, server=${serverVisible.length}`,
            };
        }

        for (let i = 0; i < serverVisible.length; i++) {
            if (clientVisible[i]!.id !== serverVisible[i]!.id || clientVisible[i]!.name !== serverVisible[i]!.name) {
                return {
                    success: false,
                    clientCount: clientVisible.length,
                    serverCount: serverVisible.length,
                    duration: Date.now() - startTime,
                    error: `Data mismatch at index ${i}`,
                };
            }
        }

        return {
            success: true,
            clientCount: clientVisible.length,
            serverCount: serverVisible.length,
            duration: Date.now() - startTime,
        };
    } catch (err: any) {
        return {
            success: false,
            clientCount: 0,
            serverCount: 0,
            duration: Date.now() - startTime,
            error: err.message || String(err),
        };
    }
}
