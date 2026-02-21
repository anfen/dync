import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    addRecordAndGetLocalId,
    getRecordByLocalId,
    removeRecordByLocalId,
    updateRecordByLocalId,
    waitForSyncIdle,
    syncModeScenarios,
    type SyncModeScenario,
} from '../helpers/dyncHarness';
import { installDeterministicUUID, resetDeterministicUUID, waitUntil, waitUntilAsync } from '../helpers/testUtils';
import { getAdapterOverrides, storageAdapterMatrix } from '../helpers/storageAdapters';
import { buildSQLiteSyncTableDefinition } from '../helpers/sqliteStructuredSchemas';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';

installDeterministicUUID();

// ============================================================================
// Client-assigned ID scenarios
// ============================================================================

interface FishClientId {
    id?: string;
    _localId: string;
    name: string;
    updated_at: string;
}

type TablesClientId = {
    fish: FishClientId;
};

interface ServerRecordClientId {
    id: string;
    name: string;
    updated_at: string;
    deleted?: boolean;
}

function makeClientIdApis() {
    let counter = 0;
    const server: ServerRecordClientId[] = [];

    return {
        server,
        apis: {
            fish: {
                add: vi.fn(async (item: any) => {
                    const id = item.id ?? `server-${++counter}`;
                    const rec = {
                        ...item,
                        id,
                        updated_at: new Date().toISOString(),
                    } satisfies ServerRecordClientId;
                    server.push(rec);
                    return { id: rec.id, updated_at: rec.updated_at };
                }),
                update: vi.fn(async (id: string, changes: any) => {
                    const rec = server.find((r) => r.id === id);
                    if (!rec) return false;
                    Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                    return true;
                }),
                remove: vi.fn(async (id: string) => {
                    const rec = server.find((r) => r.id === id);
                    if (rec) rec.deleted = true;
                }),
                list: vi.fn(async (newestUpdatedAt: Date) => {
                    return server.filter((r) => new Date(r.updated_at) > newestUpdatedAt).map((r) => ({ ...r }));
                }),
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        },
    } as const;
}

const fishSchemaClientId = {
    fish: 'name',
} as const;

const sqliteFishSchemaClientId: Record<keyof TablesClientId, SQLiteTableDefinition> = {
    fish: buildSQLiteSyncTableDefinition(),
};

// ============================================================================
// Server-assigned ID scenarios
// ============================================================================

interface FishServerId {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
}

type TablesServerId = {
    fish: FishServerId;
};

interface ServerRecordServerId {
    id: number;
    name: string;
    updated_at: string;
    deleted: boolean;
}

function makeServerIdApis() {
    let counter = 0;
    const server: ServerRecordServerId[] = [];

    return {
        server,
        apis: {
            fish: {
                add: vi.fn(async (item: any) => {
                    const rec = {
                        ...item,
                        id: ++counter,
                        updated_at: new Date().toISOString(),
                        deleted: false,
                    } satisfies ServerRecordServerId;
                    server.push(rec);
                    return { id: rec.id, updated_at: rec.updated_at };
                }),
                update: vi.fn(async (id: number, changes: any) => {
                    const rec = server.find((r) => r.id === id);
                    if (!rec) return false;
                    Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                    return true;
                }),
                remove: vi.fn(async (id: number) => {
                    const rec = server.find((r) => r.id === id);
                    if (rec) rec.deleted = true;
                }),
                list: vi.fn(async (newestUpdatedAt: Date) => {
                    return server.filter((r) => new Date(r.updated_at) > newestUpdatedAt).map((r) => ({ ...r }));
                }),
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        },
    } as const;
}

const fishSchemaServerId = {
    fish: 'name',
} as const;

const sqliteFishSchemaServerId: Record<keyof TablesServerId, SQLiteTableDefinition> = {
    fish: buildSQLiteSyncTableDefinition(),
};

// ============================================================================
// Combined test matrix: storage adapter × sync mode
// ============================================================================

const combinedMatrix = storageAdapterMatrix.flatMap(([storageLabel, storageScenario]) =>
    syncModeScenarios.map((syncMode) => [`${storageLabel} + ${syncMode.label}`, storageScenario, syncMode] as const),
);

// ============================================================================
// Client-assigned ID tests
// ============================================================================

describe.each(combinedMatrix)('Sync CRUD - Client-assigned IDs (%s)', (_label, storageScenario, syncMode: SyncModeScenario) => {
    const adapterOverrides = getAdapterOverrides(storageScenario);
    const schema = (storageScenario.key === 'sqlite' ? sqliteFishSchemaClientId : fishSchemaClientId) as Record<keyof TablesClientId, TableSchemaDefinition>;

    const createDb = async (apis: any, syncIntervalMs = 40) => {
        const db = await syncMode.createDync<TablesClientId>(apis, schema, {
            dbName: `crud-client-${storageScenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: {
                syncIntervalMs,
            },
            ...adapterOverrides,
        });
        await db.sync.enable(true);
        return db;
    };

    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('adds local fish with client-assigned id and syncs to server', async () => {
        const { apis, server } = makeClientIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { id: 'uuid', name: 'nemo' });
            await waitUntil(() => apis.fish.add.mock.calls.length >= 1, 1500);
            await waitForSyncIdle(db, 4000);

            const record = await getRecordByLocalId(db, 'fish', localId);
            expect(record?.id).toBe('uuid');
            expect(server[0]?.id).toBe('uuid');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('updates an existing synced fish eventually reflected on server', async () => {
        const { apis, server } = makeClientIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { id: 'uuid', name: 'one' });
            await waitUntil(() => server.length > 0, 1500);

            await updateRecordByLocalId(db, 'fish', localId, { name: 'two' });
            await waitUntil(() => server[0]?.name === 'two', 1500);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('removes a synced fish and marks deleted on server', async () => {
        const { apis, server } = makeClientIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { id: 'uuid', name: 'gone' });
            await waitUntil(() => server.length > 0, 1500);

            await removeRecordByLocalId(db, 'fish', localId);
            await waitUntilAsync(async () => (await db.table('fish').count()) === 0, 1500);
            await waitForSyncIdle(db, 4000);

            if (server.length) expect(server[0]?.deleted).toBe(true);
            expect(await db.table('fish').count()).toBe(0);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it("update then remove a synced fish which doesn't resurrect it on pull", async () => {
        const { apis, server } = makeClientIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { id: 'uuid', name: 'one' });
            await waitUntil(() => server.length > 0, 1500);

            await updateRecordByLocalId(db, 'fish', localId, { name: 'two' });
            await removeRecordByLocalId(db, 'fish', localId);

            await waitForSyncIdle(db, 4000);
            const remaining = await db.table('fish').toArray();
            if (remaining.length > 0) {
                throw new Error('fish was resurrected');
            }

            expect(server[0]?.deleted).toBe(true);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('omits sync fields (_localId, updated_at) from add and update payloads', async () => {
        const { apis } = makeClientIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { id: 'uuid', name: 'payload' });
            await waitUntil(() => apis.fish.add.mock.calls.length >= 1, 1500);

            const addArg = apis.fish.add.mock.calls[0]?.[0];
            expect(addArg._localId).toBeUndefined();
            expect(addArg.updated_at).toBeUndefined();

            await updateRecordByLocalId(db, 'fish', localId, {
                name: 'payload2',
                updated_at: 'fake',
            });
            await waitUntil(() => apis.fish.update.mock.calls.length >= 1, 1500);

            const updateArg = apis.fish.update.mock.calls[0]?.[1];
            expect(updateArg._localId).toBeUndefined();
            expect(updateArg.updated_at).toBeUndefined();
            expect(updateArg.name).toBe('payload2');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });
});

// ============================================================================
// Server-assigned ID tests
// ============================================================================

describe.each(combinedMatrix)('Sync CRUD - Server-assigned IDs (%s)', (_label, storageScenario, syncMode: SyncModeScenario) => {
    const adapterOverrides = getAdapterOverrides(storageScenario);
    const schema = (storageScenario.key === 'sqlite' ? sqliteFishSchemaServerId : fishSchemaServerId) as Record<keyof TablesServerId, TableSchemaDefinition>;

    const createDb = async (apis: any, syncIntervalMs = 40) => {
        const db = await syncMode.createDync<TablesServerId>(apis, schema, {
            dbName: `crud-server-${storageScenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: {
                syncIntervalMs,
            },
            ...adapterOverrides,
        });
        await db.sync.enable(true);
        return db;
    };

    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('adds local fish and syncs to server assigning server id', async () => {
        const { apis, server } = makeServerIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'nemo' });
            await waitUntil(() => apis.fish.add.mock.calls.length >= 1, 1500);
            await waitForSyncIdle(db, 4000);

            const record = await getRecordByLocalId(db, 'fish', localId);
            expect(record?.id).toBeDefined();
            expect(server[0]?.id).toBeDefined();
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('updates an existing synced fish eventually reflected on server', async () => {
        const { apis, server } = makeServerIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'one' });
            await waitUntil(() => server.length > 0, 1500);

            await updateRecordByLocalId(db, 'fish', localId, { name: 'two' });
            await waitUntil(() => server[0]?.name === 'two', 1500);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('removes a synced fish and marks deleted on server', async () => {
        const { apis, server } = makeServerIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'gone' });
            await waitUntil(() => server.length > 0, 1500);

            await removeRecordByLocalId(db, 'fish', localId);
            await waitUntilAsync(async () => (await db.table('fish').count()) === 0, 1500);
            await waitForSyncIdle(db, 4000);

            if (server.length) expect(server[0]?.deleted).toBe(true);
            expect(await db.table('fish').count()).toBe(0);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it("update then remove a synced fish which doesn't resurrect it on pull", async () => {
        const { apis, server } = makeServerIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'one' });
            await waitUntil(() => server.length > 0, 1500);

            await updateRecordByLocalId(db, 'fish', localId, { name: 'two' });
            await removeRecordByLocalId(db, 'fish', localId);

            await waitForSyncIdle(db, 4000);
            const remaining = await db.table('fish').toArray();
            if (remaining.length > 0) {
                throw new Error('fish was resurrected');
            }

            expect(server[0]?.deleted).toBe(true);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('omits sync fields (id, _localId, updated_at) from add and update payloads', async () => {
        const { apis } = makeServerIdApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'payload' });
            await waitUntil(() => apis.fish.add.mock.calls.length >= 1, 1500);

            const addArg = apis.fish.add.mock.calls[0]?.[0];
            expect(addArg.id).toBeUndefined();
            expect(addArg._localId).toBeUndefined();
            expect(addArg.updated_at).toBeUndefined();

            await updateRecordByLocalId(db, 'fish', localId, {
                name: 'payload2',
                updated_at: 'fake',
            });
            await waitUntil(() => apis.fish.update.mock.calls.length >= 1, 1500);

            const updateArg = apis.fish.update.mock.calls[0]?.[1];
            expect(updateArg._localId).toBeUndefined();
            expect(updateArg.updated_at).toBeUndefined();
            expect(updateArg.name).toBe('payload2');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });
});
