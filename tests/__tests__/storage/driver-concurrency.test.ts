import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { SQLiteAdapter } from '../../../src/storage/sqlite';
import { createSqlJsDriver } from '../../helpers/sqlJsDriver';

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

describe('Driver Concurrency - DexieAdapter', () => {
    it('DexieAdapter auto-opens on first operation without explicit open', async () => {
        const { DexieAdapter } = await import('../../../src/storage/dexie');
        const adapter = new DexieAdapter('concurrency-dexie-test');

        try {
            adapter.defineSchema(1, {
                test: '_localId',
            });

            const table = adapter.table('test');

            // Multiple concurrent operations without explicit open
            await Promise.all([table.add({ _localId: '1', value: 'a' }), table.add({ _localId: '2', value: 'b' }), table.add({ _localId: '3', value: 'c' })]);

            const count = await table.count();
            expect(count).toBe(3);
        } finally {
            await adapter.delete();
        }
    });

    it('DexieAdapter open() is a safe no-op that can be called concurrently', async () => {
        const { DexieAdapter } = await import('../../../src/storage/dexie');
        const adapter = new DexieAdapter('concurrency-dexie-noop-test');

        try {
            adapter.defineSchema(1, {
                items: '_localId',
            });

            // Multiple concurrent open calls (all no-ops for Dexie)
            await Promise.all([adapter.open(), adapter.open(), adapter.open(), adapter.open()]);

            const table = adapter.table('items');
            await table.add({ _localId: '1', data: 'test' });

            const result = await table.get('1');
            expect(result).toEqual({ _localId: '1', data: 'test' });
        } finally {
            await adapter.delete();
        }
    });
});

describe('Driver Concurrency - MemoryAdapter', () => {
    it('MemoryAdapter handles concurrent operations without open', async () => {
        const { MemoryAdapter } = await import('../../../src/storage/memory');
        const adapter = new MemoryAdapter('concurrency-memory-test');

        adapter.defineSchema(1, {
            test: '_localId',
        });

        const table = adapter.table('test');

        // Concurrent adds
        await Promise.all([table.add({ _localId: '1', value: 'a' }), table.add({ _localId: '2', value: 'b' }), table.add({ _localId: '3', value: 'c' })]);

        const count = await table.count();
        expect(count).toBe(3);

        await adapter.close();
    });

    it('MemoryAdapter open() can be called concurrently', async () => {
        const { MemoryAdapter } = await import('../../../src/storage/memory');
        const adapter = new MemoryAdapter('concurrency-memory-open-test');

        adapter.defineSchema(1, {
            data: '_localId',
        });

        // Multiple concurrent opens (should all be safe)
        await Promise.all([adapter.open(), adapter.open(), adapter.open()]);

        const table = adapter.table('data');
        await table.add({ _localId: '1', value: 'test' });

        const result = await table.get('1');
        expect(result).toEqual({ _localId: '1', value: 'test' });

        await adapter.close();
    });
});

// Schema for _dync_state table required by SQLiteAdapter's internal versioning
const dyncStateSchema = {
    columns: {
        _localId: { type: 'TEXT' },
        value: { type: 'TEXT' },
    },
} as const;

describe('Driver Concurrency - SQLiteAdapter', () => {
    it('SQLiteAdapter auto-opens on first operation without explicit open', async () => {
        const driver = createSqlJsDriver('concurrency-sqlite-test', { locateFile: locateSqlJsFile });
        const adapter = new SQLiteAdapter(driver);

        try {
            adapter.defineSchema(1, {
                _dync_state: dyncStateSchema,
                test: {
                    columns: {
                        _localId: { type: 'TEXT' },
                        value: { type: 'TEXT' },
                    },
                },
            });

            const table = adapter.table('test');

            // Multiple concurrent operations without explicit open
            await Promise.all([table.add({ _localId: '1', value: 'a' }), table.add({ _localId: '2', value: 'b' }), table.add({ _localId: '3', value: 'c' })]);

            const count = await table.count();
            expect(count).toBe(3);
        } finally {
            await adapter.close();
        }
    });

    it('SQLiteAdapter open() is idempotent and safe for concurrent calls', async () => {
        const driver = createSqlJsDriver('concurrency-sqlite-open-test', { locateFile: locateSqlJsFile });
        const adapter = new SQLiteAdapter(driver);

        try {
            adapter.defineSchema(1, {
                _dync_state: dyncStateSchema,
                items: {
                    columns: {
                        _localId: { type: 'TEXT' },
                        data: { type: 'TEXT' },
                    },
                },
            });

            // Multiple concurrent open calls (should all resolve to same initialization)
            await Promise.all([adapter.open(), adapter.open(), adapter.open(), adapter.open()]);

            const table = adapter.table('items');
            await table.add({ _localId: '1', data: 'test' });

            const result = await table.get('1');
            expect(result).toMatchObject({ _localId: '1', data: 'test' });
        } finally {
            await adapter.close();
        }
    });

    it('SQLiteAdapter handles interleaved open() and operations', async () => {
        const driver = createSqlJsDriver('concurrency-sqlite-interleaved-test', { locateFile: locateSqlJsFile });
        const adapter = new SQLiteAdapter(driver);

        try {
            adapter.defineSchema(1, {
                _dync_state: dyncStateSchema,
                data: {
                    columns: {
                        _localId: { type: 'TEXT' },
                        value: { type: 'TEXT' },
                    },
                },
            });

            const table = adapter.table('data');

            // Interleave open() calls with operations (all should auto-open correctly)
            await Promise.all([
                adapter.open(),
                table.add({ _localId: '1', value: 'first' }),
                adapter.open(),
                table.add({ _localId: '2', value: 'second' }),
                adapter.open(),
            ]);

            const count = await table.count();
            expect(count).toBe(2);

            const items = await table.toArray();
            expect(items).toHaveLength(2);
        } finally {
            await adapter.close();
        }
    });
});
