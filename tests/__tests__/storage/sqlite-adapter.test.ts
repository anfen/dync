import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '../../../src/storage/sqlite';
import { createSqlJsDriver } from '../../helpers/sqlJsDriver';
import type { ApiFunctions, SyncedRecord } from '../../../src/types';
import { createTestDync, runSyncCycle } from '../../helpers/dyncHarness';
import type { SQLiteTableDefinition } from '../../../src/storage/sqlite/schema';
import type { StorageSchemaDefinitionOptions } from '../../../src/storage/sqlite/types';
import { createLocalId } from '../../../src/helpers';

interface SQLiteSchema {
    items: { value: string } & Partial<SyncedRecord>;
}

const structuredSchema: Record<keyof SQLiteSchema, SQLiteTableDefinition> = {
    items: {
        columns: {
            value: { type: 'TEXT', length: 255 },
        },
    },
};

const locateSqlJsFile = (() => {
    try {
        const require = createRequire(import.meta.url);
        const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
        const dir = path.dirname(wasmPath);
        return (file: string) => path.join(dir, file);
    } catch {
        return (file: string) => file;
    }
})();

function createApis(server: SyncedRecord[] = []): { server: SyncedRecord[]; apis: Record<string, ApiFunctions> } {
    let idCounter = 1;
    const now = () => new Date().toISOString();

    const apis: Record<string, ApiFunctions> = {
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

describe('SQLiteAdapter', () => {
    const storageAdapterFactory = (dbName: string) => new SQLiteAdapter(createSqlJsDriver(dbName, { locateFile: locateSqlJsFile }));

    it('syncs local creations to the server', async () => {
        const { server, apis } = createApis();
        const db = await createTestDync<SQLiteSchema>(apis, structuredSchema, {
            storageAdapterFactory,
            syncOptions: { syncInterval: 10 },
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
        const { apis } = createApis([
            {
                _localId: 'remote-1',
                id: 101,
                value: 'bravo',
                updated_at: new Date().toISOString(),
            },
        ]);

        const db = await createTestDync<SQLiteSchema>(apis, structuredSchema, {
            storageAdapterFactory,
            syncOptions: { syncInterval: 10 },
        });

        await runSyncCycle(db, { keepEnabled: true });

        const local = await db.table('items').where('id').equals(101).first();
        expect(local?.value).toBe('bravo');
        expect(local?._localId).toBeDefined();

        await db.close();
    });

    it('accepts structured schema definitions for SQLite-specific metadata', async () => {
        const { apis } = createApis();
        const db = await createTestDync<SQLiteSchema>(apis, structuredSchema, {
            storageAdapterFactory,
            syncOptions: { syncInterval: 10 },
        });

        await db.table('items').add({ value: 'structured' });
        await runSyncCycle(db, { keepEnabled: true });

        const local = await db.table('items').where('value').equals('structured').first();
        expect(local?.value).toBe('structured');
        expect(local?._localId).toBeDefined();

        await db.close();
    });

    it('runs sqlite migrations on upgrades and downgrades', async () => {
        const driver = createSqlJsDriver('migration-db', { locateFile: locateSqlJsFile });
        const adapter = new SQLiteAdapter(driver);

        // Include _dync_state table as dync would when initializing
        const stateTableSchema: SQLiteTableDefinition = {
            columns: {
                _localId: { type: 'TEXT' },
                value: { type: 'TEXT' },
            },
        };

        const version1Schema: Record<string, SQLiteTableDefinition> = {
            _dync_state: stateTableSchema,
            widgets: {
                columns: {
                    _localId: { type: 'TEXT' },
                    id: { type: 'TEXT', unique: true },
                    name: { type: 'TEXT' },
                },
            },
        };

        adapter.defineSchema(1, version1Schema);
        await adapter.open();
        const localId = createLocalId();
        await adapter.table('widgets').add({ _localId: localId, id: 'one', name: 'alpha' });

        const upgradeSpy = vi.fn(async (ctx) => {
            await ctx.execute('ALTER TABLE "widgets" ADD COLUMN "description" TEXT');
        });
        const downgradeSpy = vi.fn(async (ctx) => {
            await ctx.run('UPDATE "widgets" SET "description" = NULL');
        });

        const version2Schema: Record<string, SQLiteTableDefinition> = {
            _dync_state: stateTableSchema,
            widgets: {
                columns: {
                    _localId: { type: 'TEXT' },
                    id: { type: 'TEXT', unique: true },
                    name: { type: 'TEXT' },
                    description: { type: 'TEXT' },
                },
            },
        };

        const version2Options: StorageSchemaDefinitionOptions = {};
        adapter.defineSchema(2, version2Schema, version2Options);
        const sqliteOptions = (version2Options.sqlite ??= {});
        const migrations = (sqliteOptions.migrations ??= {});
        migrations.upgrade = upgradeSpy;
        migrations.downgrade = downgradeSpy;

        await adapter.open();
        expect(upgradeSpy).toHaveBeenCalledTimes(1);
        expect(upgradeSpy).toHaveBeenCalledWith(expect.objectContaining({ direction: 'upgrade', fromVersion: 1, toVersion: 2 }));

        await adapter.table('widgets').put({ _localId: localId, id: 'one', name: 'alpha', description: 'beta' });
        const upgraded = await adapter.table('widgets').get(localId);
        expect(upgraded?.description).toBe('beta');

        (adapter as any).versionSchemas.delete(2);
        (adapter as any).refreshActiveSchema();

        await adapter.open();
        expect(downgradeSpy).toHaveBeenCalledTimes(1);
        expect(downgradeSpy).toHaveBeenCalledWith(expect.objectContaining({ direction: 'downgrade', fromVersion: 2, toVersion: 1 }));

        const downgradedTable = adapter.table('widgets');
        const downgraded = await downgradedTable.get(localId);
        expect(downgraded?.description).toBeUndefined();

        await adapter.close();
    });

    it('auto-injects updated_at index for sync tables', async () => {
        const { apis } = createApis();

        // User schema WITHOUT explicit updated_at index
        const schemaWithoutIndex: Record<keyof SQLiteSchema, SQLiteTableDefinition> = {
            items: {
                columns: {
                    value: { type: 'TEXT', length: 255 },
                },
                // No indexes defined - updated_at should be auto-injected
            },
        };

        const db = await createTestDync<SQLiteSchema>(apis, schemaWithoutIndex, {
            storageAdapterFactory,
            syncOptions: { syncInterval: 10 },
        });

        // Add items with various timestamps for orderBy testing
        // Use raw.bulkAdd to bypass sync logic which would overwrite updated_at
        const ts1 = '2024-01-01T00:00:00.000Z';
        const ts2 = '2024-01-02T00:00:00.000Z';
        const ts3 = '2024-01-03T00:00:00.000Z';

        await db.table('items').raw.bulkAdd([
            { _localId: 'c', value: 'charlie', updated_at: ts3 },
            { _localId: 'a', value: 'alpha', updated_at: ts1 },
            { _localId: 'b', value: 'bravo', updated_at: ts2 },
        ]);

        // Query using orderBy('updated_at') - this should work because the index was auto-injected
        const sorted = await db.table('items').orderBy('updated_at').toArray();
        expect(sorted.map((i) => i.value)).toEqual(['alpha', 'bravo', 'charlie']);

        // Verify reverse ordering also works
        const reverseSorted = await db.table('items').orderBy('updated_at').reverse().toArray();
        expect(reverseSorted.map((i) => i.value)).toEqual(['charlie', 'bravo', 'alpha']);

        await db.close();
    });

    it('preserves user-defined indexes when auto-injecting updated_at index', async () => {
        const { apis } = createApis();

        // User schema WITH their own indexes AND updated_at index
        const schemaWithUserIndexes: Record<keyof SQLiteSchema, SQLiteTableDefinition> = {
            items: {
                columns: {
                    value: { type: 'TEXT', length: 255 },
                },
                indexes: [
                    { columns: ['value'] }, // User's custom index
                    { columns: ['updated_at'] }, // User explicitly defined updated_at
                ],
            },
        };

        const db = await createTestDync<SQLiteSchema>(apis, schemaWithUserIndexes, {
            storageAdapterFactory,
            syncOptions: { syncInterval: 10 },
        });

        // Add items for testing both indexes
        // Use raw.bulkAdd to bypass sync logic which would overwrite updated_at
        const ts1 = '2024-01-01T00:00:00.000Z';
        const ts2 = '2024-01-02T00:00:00.000Z';

        await db.table('items').raw.bulkAdd([
            { _localId: 'b', value: 'bravo', updated_at: ts2 },
            { _localId: 'a', value: 'alpha', updated_at: ts1 },
        ]);

        // Verify value index works
        const byValue = await db.table('items').orderBy('value').toArray();
        expect(byValue.map((i) => i.value)).toEqual(['alpha', 'bravo']);

        // Verify updated_at index works (should not be duplicated)
        const byTime = await db.table('items').orderBy('updated_at').toArray();
        expect(byTime.map((i) => i.value)).toEqual(['alpha', 'bravo']);

        await db.close();
    });
});
