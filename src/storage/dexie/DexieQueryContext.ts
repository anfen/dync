import type { StorageTable, StorageTransactionContext, TransactionMode } from '../types';
import type { DexieAdapter } from './DexieAdapter';

export class DexieQueryContext {
    constructor(private readonly adapter: DexieAdapter) {}

    table<T = any>(name: string): StorageTable<T> {
        return this.adapter.table(name);
    }

    transaction<T>(mode: TransactionMode, tableNames: string[], callback: (context: StorageTransactionContext) => Promise<T>): Promise<T> {
        return this.adapter.transaction(mode, tableNames, callback);
    }
}
