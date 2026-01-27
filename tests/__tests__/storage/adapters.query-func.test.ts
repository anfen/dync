import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DexieAdapter, DexieQueryContext } from '../../../src/storage/dexie';
import { SQLiteAdapter, SQLiteQueryContext } from '../../../src/storage/sqlite';
import { createSqlJsDriver } from '../../helpers/sqlJsDriver';
import { MemoryAdapter, MemoryQueryContext } from '../../../src/storage/memory';
import { createTestDync } from '../../helpers/dyncHarness';

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

interface TestSchema {
    items: { value: string };
}

const structuredSchema = {
    items: {
        columns: {
            value: { type: 'TEXT' },
        },
    },
};

const dexieSchema = {
    items: 'value',
};

const apis = {
    items: {
        add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
        update: async () => true,
        remove: async () => {},
        list: async () => [],
        firstLoad: async () => [],
    },
};

describe('StorageAdapter.query', () => {
    it('executes Dexie specific queries when using DexieAdapter', async () => {
        const dbName = `query-dexie-${Math.random().toString(36).slice(2)}`;
        const db = await createTestDync<TestSchema>(apis, dexieSchema, {
            storageAdapterFactory: (name) => new DexieAdapter(name),
            dbName,
        });

        await db.table('items').add({ value: 'dexie-test' });

        const result = await db.query(async (ctx) => {
            if (ctx instanceof DexieQueryContext) {
                // Access the underlying Dexie instance
                return await ctx.table('items').where('value').equals('dexie-test').first();
            }
            throw new Error('Expected DexieAdapter');
        });

        expect(result).toBeDefined();
        expect(result.value).toBe('dexie-test');

        await db.close();
    });

    it('executes SQLite specific queries when using SQLiteAdapter', async () => {
        const dbName = `query-sqlite-${Math.random().toString(36).slice(2)}`;
        const db = await createTestDync<TestSchema>(apis, structuredSchema, {
            storageAdapterFactory: (name) => new SQLiteAdapter(createSqlJsDriver(name, { locateFile: locateSqlJsFile })),
            dbName,
        });

        await db.table('items').add({ value: 'sqlite-test' });

        const result = await db.query(async (ctx) => {
            if (ctx instanceof SQLiteQueryContext) {
                // Execute raw SQL
                const rows = await ctx.queryRows('SELECT * FROM items WHERE value = ?', ['sqlite-test']);
                return rows[0];
            }
            throw new Error('Expected SQLiteAdapter');
        });

        expect(result).toBeDefined();
        expect(result?.value).toBe('sqlite-test');

        await db.close();
    });

    it('executes Memory specific logic when using MemoryAdapter', async () => {
        const dbName = `query-memory-${Math.random().toString(36).slice(2)}`;
        const db = await createTestDync<TestSchema>(apis, dexieSchema, {
            storageAdapterFactory: (name) => new MemoryAdapter(name),
            dbName,
        });

        await db.table('items').add({ value: 'memory-test' });

        const result = await db.query(async (ctx) => {
            if (ctx instanceof MemoryQueryContext) {
                // Access internal tables map
                const table = ctx.table('items');
                const all = await table.toArray();
                return all.find((record: any) => record.value === 'memory-test');
            }
            throw new Error('Expected MemoryAdapter');
        });

        expect(result).toBeDefined();
        expect(result.value).toBe('memory-test');

        await db.close();
    });

    it('allows switching on ctx type in a shared function', async () => {
        const runQuery = async (ctx: any) => {
            if (ctx instanceof DexieQueryContext) {
                return 'dexie';
            }
            if (ctx instanceof SQLiteQueryContext) {
                return 'sqlite';
            }
            if (ctx instanceof MemoryQueryContext) {
                return 'memory';
            }
            return 'unknown';
        };

        const dexieDb = await createTestDync<TestSchema>(apis, dexieSchema, {
            storageAdapterFactory: (name) => new DexieAdapter(name),
            dbName: `query-switch-dexie-${Math.random().toString(36).slice(2)}`,
        });
        expect(await dexieDb.query(runQuery)).toBe('dexie');
        await dexieDb.close();

        const sqliteDb = await createTestDync<TestSchema>(apis, structuredSchema, {
            storageAdapterFactory: (name) => new SQLiteAdapter(createSqlJsDriver(name, { locateFile: locateSqlJsFile })),
            dbName: `query-switch-sqlite-${Math.random().toString(36).slice(2)}`,
        });
        expect(await sqliteDb.query(runQuery)).toBe('sqlite');
        await sqliteDb.close();

        const memoryDb = await createTestDync<TestSchema>(apis, dexieSchema, {
            storageAdapterFactory: (name) => new MemoryAdapter(name),
            dbName: `query-switch-memory-${Math.random().toString(36).slice(2)}`,
        });
        expect(await memoryDb.query(runQuery)).toBe('memory');
        await memoryDb.close();
    });

    it('returns the same table instance and independent filtered collection for DexieAdapter', async () => {
        const dbName = `query-dexie-table-cache-${Math.random().toString(36).slice(2)}`;
        const db = await createTestDync<TestSchema>(apis, dexieSchema, {
            storageAdapterFactory: (name) => new DexieAdapter(name),
            dbName,
        });

        const tableA = db.table('items');
        const tableB = db.table('items');
        expect(tableA).toBe(tableB);

        await tableA.add({ value: 'match-me' });
        await tableA.add({ value: 'other' });

        // Use where().equals() for native filtering, or toArray() then filter in JS
        const filtered = db.table('items').where('value').equals('match-me');
        expect(await tableA.count()).toBe(2);
        expect(await filtered.count()).toBe(1);

        await db.close();
    });

    it('returns the same table instance and independent filtered collection for SQLiteAdapter', async () => {
        const dbName = `query-sqlite-table-cache-${Math.random().toString(36).slice(2)}`;
        const db = await createTestDync<TestSchema>(apis, structuredSchema, {
            storageAdapterFactory: (name) => new SQLiteAdapter(createSqlJsDriver(name, { locateFile: locateSqlJsFile })),
            dbName,
        });

        const tableA = db.table('items');
        const tableB = db.table('items');
        expect(tableA).toBe(tableB);

        await tableA.add({ value: 'match-me' });
        await tableA.add({ value: 'other' });

        // Use where().equals() for native filtering
        const filtered = db.table('items').where('value').equals('match-me');
        expect(await tableA.count()).toBe(2);
        expect(await filtered.count()).toBe(1);

        await db.close();
    });
});
