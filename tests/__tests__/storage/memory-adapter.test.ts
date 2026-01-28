import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../../src/storage/memory';
import type { CrudSyncApi, SyncedRecord } from '../../../src/types';
import { createTestDync, runSyncCycle } from '../../helpers/dyncHarness';

type MemorySchema = {
    items: { value: string } & Partial<SyncedRecord>;
};

const schema = {
    items: 'value',
} as const;

function createMemoryApis(server: SyncedRecord[] = []): { server: SyncedRecord[]; apis: Record<string, CrudSyncApi> } {
    let idCounter = 1;

    const now = () => new Date().toISOString();

    const apis: Record<string, CrudSyncApi> = {
        items: {
            add: async (item) => {
                const id = item.id ?? idCounter++;
                const serverItem: SyncedRecord = {
                    ...item,
                    id,
                    updated_at: now(),
                };
                server.push(serverItem);
                return { id, updated_at: serverItem.updated_at };
            },
            update: async (id, changes) => {
                const existing = server.find((record) => record.id === id);
                if (!existing) return false;
                Object.assign(existing, changes, { updated_at: now() });
                return true;
            },
            remove: async (id) => {
                const existing = server.find((record) => record.id === id);
                if (existing) {
                    existing.deleted = true;
                    existing.updated_at = now();
                }
            },
            list: async (lastUpdatedAt: Date) => {
                return server.filter((record) => new Date(record.updated_at ?? 0) > lastUpdatedAt).map((record) => ({ ...record }));
            },
            firstLoad: async () => server.map((record) => ({ ...record })),
        },
    };

    return { server, apis };
}

describe('MemoryAdapter', () => {
    it('syncs local creations to the server', async () => {
        const { server, apis } = createMemoryApis();
        const db = await createTestDync<MemorySchema>(apis, schema, {
            storageAdapterFactory: (dbName) => new MemoryAdapter(dbName),
            syncOptions: {
                syncIntervalMs: 10,
            },
        });

        await db.table('items').add({ value: 'alpha' });

        await runSyncCycle(db, { keepEnabled: true });

        expect(server).toHaveLength(1);
        expect(server[0]?.value).toBe('alpha');
        expect(server[0]?.id).toBeDefined();

        const local = await db.table('items').where('value').equals('alpha').first();
        expect(local?.id).toEqual(server[0]?.id);

        await db.close();
    });

    it('pulls remote records into the local store', async () => {
        const { apis } = createMemoryApis([
            {
                _localId: 'remote-1',
                id: 101,
                value: 'bravo',
                updated_at: new Date().toISOString(),
            },
        ]);

        const db = await createTestDync<MemorySchema>(apis, schema, {
            storageAdapterFactory: (dbName) => new MemoryAdapter(dbName),
            syncOptions: {
                syncIntervalMs: 10,
            },
        });

        await runSyncCycle(db, { keepEnabled: true });

        const local = await db.table('items').where('id').equals(101).first();
        expect(local?.value).toBe('bravo');
        expect(local?._localId).toBeDefined();

        await db.close();
    });
});
