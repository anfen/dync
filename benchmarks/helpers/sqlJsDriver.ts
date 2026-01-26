import path from 'node:path';
import { createRequire } from 'node:module';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - sql.js doesn't have proper types
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult } from '../../src/storage/sqlite/types';

interface SqlJsDriverOptions {
    locateFile?: (file: string) => string;
}

export class SqlJsDriver implements SQLiteDatabaseDriver {
    readonly type = 'SqlJsDriver';
    private db?: SqlJsDatabase;
    private initializing?: Promise<void>;
    private readonly options: SqlJsDriverOptions;
    readonly name: string;

    constructor(name: string, options: SqlJsDriverOptions = {}) {
        this.name = name;
        this.options = options;
    }

    async open(): Promise<void> {
        if (this.db) return;
        if (!this.initializing) {
            this.initializing = (async () => {
                const sql = await initSqlJs({
                    locateFile: this.options.locateFile,
                });
                this.db = new sql.Database();
            })();
        }
        await this.initializing;
        this.initializing = undefined;
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = undefined;
        }
    }

    async run(sql: string, params?: unknown[]): Promise<SQLiteRunResult> {
        if (!this.db) throw new Error('Database not open');
        this.db.run(sql, params as (string | number | Uint8Array | null | undefined)[]);
        return { changes: this.db.getRowsModified() };
    }

    async query(sql: string, params?: unknown[]): Promise<SQLiteQueryResult> {
        if (!this.db) throw new Error('Database not open');
        const stmt = this.db.prepare(sql);
        stmt.bind(params as (string | number | Uint8Array | null | undefined)[]);
        const columns = stmt.getColumnNames();
        const values: unknown[][] = [];
        while (stmt.step()) {
            values.push(stmt.get());
        }
        stmt.free();
        return { columns, values };
    }

    async execute(sql: string): Promise<void> {
        if (!this.db) throw new Error('Database not open');
        this.db.exec(sql);
    }
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

export const createSqlJsDriver = (name: string): SQLiteDatabaseDriver => {
    return new SqlJsDriver(name, { locateFile: locateSqlJsFile });
};
