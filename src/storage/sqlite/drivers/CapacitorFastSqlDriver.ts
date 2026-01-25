import type { SQLConnection, SQLValue } from '@capgo/capacitor-fast-sql';

import type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult } from '../types';

export interface FastSqlDriverOptions {
    encrypted?: boolean;
    getEncryptionKey?: () => string;
    readonly?: boolean;
}

// Lazily loaded module cache to avoid top-level imports that break web bundlers
let fastSqlModuleCache: typeof import('@capgo/capacitor-fast-sql') | null = null;

async function getFastSqlModule(): Promise<typeof import('@capgo/capacitor-fast-sql')> {
    if (!fastSqlModuleCache) {
        fastSqlModuleCache = await import('@capgo/capacitor-fast-sql');
    }
    return fastSqlModuleCache;
}

/**
 * SQLiteDatabaseDriver implementation for @capgo/capacitor-fast-sql plugin.
 *
 * This driver provides a compatible interface with the existing SQLiteAdapter
 * while using the Capgo Fast SQL plugin which offers better performance through
 * a local HTTP server approach that bypasses Capacitor's bridge.
 * 
 * Update your AndroidManifest.xml to allow cleartext traffic:
 * <application
        ...
        android:usesCleartextTraffic="true">

    Requires Capacitor HTTP plugin to prevent CORS, as FastSql server runs on localhost:9000, not Capacitor's localhost
 */
export class CapacitorFastSqlDriver implements SQLiteDatabaseDriver {
    readonly type = 'CapacitorFastSqlDriver';
    private readonly options: FastSqlDriverOptions;
    private db?: SQLConnection;
    private openPromise?: Promise<void>;
    private opened = false;
    readonly name: string;

    constructor(databaseName: string, options: FastSqlDriverOptions = {}) {
        this.name = databaseName;
        this.options = options;
    }

    async open(): Promise<void> {
        if (this.opened) return;
        if (this.openPromise) return this.openPromise;

        this.openPromise = (async () => {
            if (!this.db) {
                const { FastSQL } = await getFastSqlModule();
                const encryptionKey = this.options.getEncryptionKey?.();
                if (!encryptionKey && this.options.encrypted) {
                    throw new Error('FastSqlDriverOptions.encrypted=true but no encryption key was provided (getEncryptionKey).');
                }
                this.db = await FastSQL.connect({
                    database: this.name,
                    encrypted: this.options.encrypted,
                    encryptionKey,
                    readOnly: this.options.readonly,
                });
                // Case-sensitive LIKE to match Dexie's startsWith() behavior
                await this.db.execute('PRAGMA case_sensitive_like = ON');
                this.opened = true;
            }
        })();

        try {
            await this.openPromise;
        } finally {
            this.openPromise = undefined;
        }
    }

    async close(): Promise<void> {
        if (this.db) {
            const { FastSQL } = await getFastSqlModule();
            await FastSQL.disconnect(this.name);
            this.db = undefined;
            this.opened = false;
            this.openPromise = undefined;
        }
    }

    async execute(statement: string): Promise<void> {
        await this.open();
        await this.db!.execute(statement);
    }

    async run(statement: string, values: any[] = []): Promise<SQLiteRunResult> {
        await this.open();
        const result = await this.db!.run(statement, values as SQLValue[]);
        return {
            changes: result.rowsAffected,
            lastId: result.insertId,
        };
    }

    async query(statement: string, values: any[] = []): Promise<SQLiteQueryResult> {
        await this.open();
        const rows = await this.db!.query(statement, values as SQLValue[]);

        // Convert array of objects to columns + values format expected by adapter
        if (!rows.length) {
            return { columns: [], values: [] };
        }

        const columns = Object.keys(rows[0]!);
        const resultValues = rows.map((row) => columns.map((col) => (row as Record<string, any>)[col]));

        return { columns, values: resultValues };
    }
}
