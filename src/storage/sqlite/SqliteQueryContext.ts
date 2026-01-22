import type { StorageTable, StorageTransactionContext, TransactionMode } from '../types';
import type { SQLiteDatabaseDriver, SQLiteRunResult } from './types';
import { SQLiteAdapter } from './SQLiteAdapter';

export class SqliteQueryContext {
    constructor(
        private readonly driver: SQLiteDatabaseDriver,
        private readonly adapter: SQLiteAdapter,
    ) {}

    table<T = any>(name: string): StorageTable<T> {
        return this.adapter.table(name);
    }

    transaction<T>(mode: TransactionMode, tableNames: string[], callback: (context: StorageTransactionContext) => Promise<T>): Promise<T> {
        return this.adapter.transaction(mode, tableNames, callback);
    }

    async execute(statement: string): Promise<void> {
        return this.driver.execute(statement);
    }

    async run(statement: string, values?: any[]): Promise<SQLiteRunResult> {
        return this.driver.run(statement, values);
    }

    async queryRows(statement: string, values?: any[]): Promise<Array<Record<string, any>>> {
        return this.adapter.queryRows(statement, values);
    }
}
