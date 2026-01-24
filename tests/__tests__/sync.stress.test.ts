import { describe, it, expect, vi } from 'vitest';

import { syncModeScenarios } from '../helpers/dyncHarness';
import { getAdapterOverrides, storageAdapterMatrix, type StorageAdapterScenario } from '../helpers/storageAdapters';
import { installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';
import { buildSQLiteSyncTableDefinition } from '../helpers/sqliteStructuredSchemas';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';
import { LOCAL_PK } from '../../src/types';

installDeterministicUUID();

// Server-side Item includes all fields; client doesn't need to provide updated_at for add
type Item = { id?: number; _localId: string; name: string; updated_at?: string; deleted: boolean };

interface StressTables {
    items: Omit<Item, 'deleted'>;
}

const itemsSchema = {
    items: 'name',
} as const;

const sqliteItemsSchema: Record<keyof StressTables, SQLiteTableDefinition> = {
    items: buildSQLiteSyncTableDefinition(),
};

function makeFaultyApis(opts: { errorRate?: number; maxDelayMs?: number } = {}) {
    const errorRate = opts.errorRate ?? 0.05;
    const maxDelay = opts.maxDelayMs ?? 30;

    // small seeded PRNG for reproducibility
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
            add: vi.fn(async (item: any) => {
                await maybeDelay();
                maybeThrow('add');
                const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                server.push(rec as Item);
                return { id: rec.id, updated_at: rec.updated_at };
            }),
            update: vi.fn(async (id: number, changes: any) => {
                await maybeDelay();
                maybeThrow('update');
                const rec = server.find((r) => r.id === id);
                if (!rec) return false;
                Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                return true;
            }),
            remove: vi.fn(async (id: number) => {
                await maybeDelay();
                maybeThrow('remove');
                const rec = server.find((r) => r.id === id);
                if (rec) rec.deleted = true;
            }),
            list: vi.fn(async (lastUpdatedAt: Date) => {
                await maybeDelay();
                maybeThrow('list');
                return server.filter((r) => new Date(r.updated_at!) > lastUpdatedAt).map((r) => ({ ...r }));
            }),
            firstLoad: vi.fn(async (_lastId: any) => {
                await maybeDelay();
                maybeThrow('firstLoad');
                return [] as any[];
            }),
        },
    } as const;

    return { apis, server } as const;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildStressDb(
    apis: any,
    scenario: StorageAdapterScenario,
    schema: Record<keyof StressTables, TableSchemaDefinition> = itemsSchema,
    syncInterval = 20,
    syncMode = syncModeScenarios[0]!,
) {
    const adapterOverrides = getAdapterOverrides(scenario);
    const createFn = syncMode.createDync;
    const db = await createFn<StressTables>(apis, schema, {
        dbName: `stress-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
        syncOptions: {
            syncInterval,
            minLogLevel: 'none',
            logger: console,
        },
        ...adapterOverrides,
    });

    await db.sync.enable(true);

    return db;
}

// Build combined matrix: each storage adapter × each sync mode
const combinedMatrix = storageAdapterMatrix.flatMap(([label, scenario]) =>
    syncModeScenarios.map((syncMode) => [`${label} / ${syncMode.label}`, scenario, syncMode] as const),
);

describe.each(combinedMatrix)('stress test (%s)', (_label, scenario, syncMode) => {
    // WARNING: Long running test!!!
    it('runs thousands of interleaved operations and server/client converge', async () => {
        resetDeterministicUUID();

        const { apis, server } = makeFaultyApis({ errorRate: 0.06, maxDelayMs: 40 });
        const schema = (scenario.key === 'sqlite' ? sqliteItemsSchema : itemsSchema) as Record<keyof StressTables, TableSchemaDefinition>;
        const db = await buildStressDb(apis, scenario, schema, 15, syncMode);
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

        const OP_COUNT = 2000; // thousands of ops
        const ops: Promise<void>[] = [];

        // Maintain a local list of current localIds for update/remove picks
        const localIds: string[] = [];

        // small seeded PRNG for operation choices
        let seed = 987654321;
        function rand() {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        }

        for (let i = 0; i < OP_COUNT; i++) {
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
                        // ignore runtime errors in client ops
                    } finally {
                        res();
                    }
                }, delay),
            );
            ops.push(p);
        }

        // Wait for all operations to be enqueued
        await Promise.all(ops);

        const deadline = Date.now() + 60_000 * 3;
        while (true) {
            const syncState = db.sync.getState();
            const items = await table.toArray();
            const pending = syncState.pendingChanges?.length ?? 0;
            const missingIds = items.some((it: any) => !it.id);

            if (pending === 0 && !missingIds) {
                break;
            }

            if (Date.now() > deadline) {
                throw new Error('Timed out waiting for sync to settle');
            }

            await sleep(50);
        }

        // disable sync to stop background activity
        await db.sync.enable(false);

        const items = await table.toArray();

        // Normalize server and client visible items (non-deleted)
        const serverVisible = server.filter((s) => !s.deleted).map((s) => ({ id: s.id, name: s.name }));
        const clientVisible = items.map((i: any) => ({ id: i.id, name: i.name }));

        // Sort and compare
        const sortFn = (a: any, b: any) => a.id - b.id;
        serverVisible.sort(sortFn);
        clientVisible.sort(sortFn);

        expect(clientVisible.length).toBe(serverVisible.length);
        for (let i = 0; i < serverVisible.length; i++) {
            expect(clientVisible[i]!.id).toBe(serverVisible[i]!.id);
            expect(clientVisible[i]!.name).toBe(serverVisible[i]!.name);
        }

        await db.close();
    }, 120_000);
});
