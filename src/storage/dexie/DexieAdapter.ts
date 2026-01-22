import Dexie from 'dexie';
import type { StorageAdapter, StorageTable, StorageTransactionContext, TransactionMode } from '../types';
import type { StorageSchemaDefinitionOptions } from '../sqlite/types';
import type { TableSchemaDefinition } from '../sqlite/schema';
import { DexieQueryContext } from './DexieQueryContext';
import { DexieStorageTable } from './DexieStorageTable';

export class DexieAdapter implements StorageAdapter {
    readonly type = 'DexieAdapter';
    readonly name: string;
    readonly db: Dexie;
    private readonly tableCache = new Map<string, StorageTable<any>>();

    constructor(databaseName: string) {
        this.db = new Dexie(databaseName);
        this.name = this.db.name;
    }

    async open(): Promise<void> {
        // Dexie auto-opens on first operation, so this is typically a no-op.
        // However, after delete() we explicitly re-open to ensure continued usability.
    }

    async close(): Promise<void> {
        if (this.db.isOpen()) {
            this.db.close();
        }
        this.tableCache.clear();
    }

    async delete(): Promise<void> {
        await this.db.delete();
        this.tableCache.clear();
        // Dexie.delete() closes the database, so re-open it to allow continued use.
        // Without this, subsequent operations would fail with DatabaseClosedError.
        await this.db.open();
    }

    async query<R>(callback: (ctx: DexieQueryContext) => Promise<R>): Promise<R> {
        return callback(new DexieQueryContext(this));
    }

    defineSchema(version: number, schema: Record<string, TableSchemaDefinition>, _options?: StorageSchemaDefinitionOptions): void {
        const normalized: Record<string, string> = {};
        for (const [tableName, definition] of Object.entries(schema)) {
            if (typeof definition !== 'string') {
                throw new Error(`DexieAdapter requires string schema definitions. Received non-string definition for table '${tableName}'.`);
            }
            normalized[tableName] = definition;
        }
        const dexieVersion = this.db.version(version);
        dexieVersion.stores(normalized);
    }

    table<T = any>(name: string): StorageTable<T> {
        if (!this.tableCache.has(name)) {
            const table = this.db.table<T>(name);
            this.tableCache.set(name, new DexieStorageTable(table));
        }
        return this.tableCache.get(name)! as StorageTable<T>;
    }

    async transaction<T>(mode: TransactionMode, tableNames: string[], callback: (context: StorageTransactionContext) => Promise<T>): Promise<T> {
        return (this.db.transaction as any)(mode, ...tableNames, async () => {
            const tables: Record<string, StorageTable<any>> = {};
            for (const tableName of tableNames) {
                tables[tableName] = this.table(tableName);
            }
            return callback({ tables });
        });
    }
}
