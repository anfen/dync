import type { StorageAdapter, StorageTable, StorageTransactionContext, TransactionMode } from '../types';
import type { StorageSchemaDefinitionOptions } from '../sqlite/types';
import { MemoryQueryContext } from './MemoryQueryContext';
import { MemoryTable } from './MemoryTable';

export class MemoryAdapter implements StorageAdapter {
    readonly type = 'MemoryAdapter';
    readonly name: string;
    readonly tables = new Map<string, MemoryTable<any>>();

    constructor(name: string) {
        this.name = name;
    }

    async open(): Promise<void> {
        // No-op for memory adapter - always "open"
    }

    async close(): Promise<void> {
        this.tables.clear();
    }

    async delete(): Promise<void> {
        this.tables.clear();
    }

    async query<R>(callback: (ctx: MemoryQueryContext) => Promise<R>): Promise<R> {
        return callback(new MemoryQueryContext(this));
    }

    defineSchema(_version: number, schema: Record<string, string>, _options?: StorageSchemaDefinitionOptions): void {
        for (const tableName of Object.keys(schema)) {
            this.ensureTable(tableName);
        }
    }

    table<T = any>(name: string): StorageTable<T> {
        return this.ensureTable(name) as StorageTable<T>;
    }

    async transaction<T>(_mode: TransactionMode, tableNames: string[], callback: (context: StorageTransactionContext) => Promise<T>): Promise<T> {
        const tables: Record<string, StorageTable<any>> = {};
        for (const tableName of tableNames) {
            tables[tableName] = this.ensureTable(tableName);
        }
        return callback({ tables });
    }

    private ensureTable(name: string): MemoryTable<any> {
        if (!this.tables.has(name)) {
            this.tables.set(name, new MemoryTable(name));
        }
        return this.tables.get(name)!;
    }
}
