import * as SQLite from 'expo-sqlite';

import type { SQLiteDatabaseDriver, SQLiteQueryResult, SQLiteRunResult } from '../types';

export class ExpoSQLiteDriver implements SQLiteDatabaseDriver {
    readonly type = 'ExpoSQLiteDriver';
    private db: SQLite.SQLiteDatabase | null = null;
    private openPromise?: Promise<void>;
    private opened = false;
    readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    async open(): Promise<void> {
        if (this.opened) return;
        if (this.openPromise) return this.openPromise;

        this.openPromise = (async () => {
            if (!this.db) {
                this.db = await SQLite.openDatabaseAsync(this.name);
                // Case-sensitive LIKE to match Dexie's startsWith() behavior
                await this.db.execAsync('PRAGMA case_sensitive_like = ON');
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
        const db = this.db;
        this.db = null;
        this.opened = false;
        this.openPromise = undefined;
        if (db?.closeAsync) {
            await db.closeAsync();
        }
    }

    async execute(statement: string): Promise<void> {
        await this.run(statement, []);
    }

    async run(statement: string, values: any[] = []): Promise<SQLiteRunResult> {
        await this.open();
        const db = this.db!;
        const result = await db.runAsync(statement, values);
        return {
            changes: result.changes ?? 0,
            lastId: (result as any).lastInsertRowId ?? (result as any).lastInsertId ?? undefined,
        };
    }

    async query(statement: string, values: any[] = []): Promise<SQLiteQueryResult> {
        await this.open();
        const db = this.db!;
        const rows = await db.getAllAsync(statement, values);
        const first = rows[0];
        const columns = first ? Object.keys(first) : [];
        const valuesMatrix = rows.map((row) => columns.map((col) => (row as any)[col]));
        return { columns, values: valuesMatrix };
    }
}
