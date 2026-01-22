import path from 'node:path';
import { createRequire } from 'node:module';
import type { StorageAdapter } from '../../src/storage/types';
import { DexieAdapter } from '../../src/storage/dexie';
import { MemoryAdapter } from '../../src/storage/memory';
import { SQLiteAdapter } from '../../src/storage/sqlite';
import { createSqlJsDriver } from './sqlJsDriver';

export interface StorageAdapterScenario {
    key: string;
    label: string;
    createAdapter: (dbName: string) => StorageAdapter;
}

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

export const storageAdapterScenarios: StorageAdapterScenario[] = [
    {
        key: 'dexie',
        label: 'Dexie (IndexedDB)',
        createAdapter: (dbName) => new DexieAdapter(dbName),
    },
    {
        key: 'memory',
        label: 'MemoryAdapter',
        createAdapter: (dbName) => new MemoryAdapter(dbName),
    },
    {
        key: 'sqlite',
        label: 'SQLiteAdapter (sql.js)',
        createAdapter: (dbName) => new SQLiteAdapter(createSqlJsDriver(dbName, { locateFile: locateSqlJsFile })),
    },
];

export const storageAdapterMatrix = storageAdapterScenarios.map((scenario) => [scenario.label, scenario] as const);

export const getAdapterOverrides = (scenario: StorageAdapterScenario): { storageAdapterFactory: (dbName: string) => StorageAdapter } => ({
    storageAdapterFactory: scenario.createAdapter,
});
