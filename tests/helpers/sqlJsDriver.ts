import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult } from '../../src/storage/sqlite/types';

export type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult };

export interface SqlJsDriverOptions {
    locateFile?: (file: string) => string;
}

const VITE_FS_PREFIX = '/@fs/';
const FILE_SCHEME = 'file://';

const normalizeLocalAssetPath = (pathname: string): string => {
    if (!pathname) {
        return pathname;
    }
    let normalized = pathname;
    if (normalized.startsWith(FILE_SCHEME)) {
        try {
            normalized = new URL(normalized).pathname;
        } catch {
            // ignore
        }
    }
    if (normalized.startsWith(VITE_FS_PREFIX)) {
        normalized = normalized.slice(VITE_FS_PREFIX.length - 1);
    }
    if (normalized.startsWith('/') && /^[A-Za-z]:/.test(normalized.slice(1))) {
        normalized = normalized.slice(1);
    }
    try {
        normalized = decodeURIComponent(normalized);
    } catch {
        // ignore decode errors
    }
    return normalized;
};

const defaultLocateSqlJsFile = (file: string): string => {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        return file;
    }
    try {
        const url = new URL(`../../node_modules/sql.js/dist/${file}`, import.meta.url);
        return normalizeLocalAssetPath(url.pathname ?? file) || file;
    } catch {
        return file;
    }
};

class SqlJsDriver implements SQLiteDatabaseDriver {
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
        if (this.db) {
            return;
        }
        if (!this.initializing) {
            this.initializing = (async () => {
                const sql = await initSqlJs({
                    locateFile: this.options.locateFile ?? defaultLocateSqlJsFile,
                });
                this.db = new sql.Database();
                // Case-sensitive LIKE to match Dexie's startsWith() behavior
                this.db.exec('PRAGMA case_sensitive_like = ON');
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

    private async requireDb(): Promise<SqlJsDatabase> {
        if (!this.db) {
            await this.open();
        }
        if (!this.db) {
            throw new Error('Failed to initialize sql.js database');
        }
        return this.db;
    }

    async execute(statement: string): Promise<void> {
        const db = await this.requireDb();
        db.exec(statement);
    }

    async run(statement: string, values: any[] = []): Promise<SQLiteRunResult> {
        const db = await this.requireDb();
        const stmt = db.prepare(statement);
        try {
            stmt.bind(values ?? []);
            stmt.step();
        } finally {
            stmt.free();
        }
        const changes = db.getRowsModified ? db.getRowsModified() : 0;
        const lastIdResult = db.exec('SELECT last_insert_rowid() as id');
        const lastId = lastIdResult[0]?.values?.[0]?.[0];
        return { changes, lastId: typeof lastId === 'number' ? lastId : undefined };
    }

    async query(statement: string, values: any[] = []): Promise<SQLiteQueryResult> {
        const db = await this.requireDb();
        const stmt = db.prepare(statement);
        const rows: any[][] = [];
        let columns: string[] = [];
        try {
            stmt.bind(values ?? []);
            columns = stmt.getColumnNames();
            while (stmt.step()) {
                rows.push(stmt.get());
            }
        } finally {
            stmt.free();
        }
        return { columns, values: rows };
    }
}

export const createSqlJsDriver = (name: string, options?: SqlJsDriverOptions): SQLiteDatabaseDriver => new SqlJsDriver(name, options);
