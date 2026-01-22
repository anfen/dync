import type { SQLiteDatabaseDriver, SQLiteQueryResult, SQLiteRunResult } from '../types';

/**
 * Options for configuring the BetterSqlite3Driver.
 */
export interface BetterSqlite3DriverOptions {
    /**
     * Open the database in readonly mode.
     * @default false
     */
    readonly?: boolean;

    /**
     * Create the database file if it doesn't exist.
     * Set to false to throw an error if the file doesn't exist.
     * @default true
     */
    fileMustExist?: boolean;

    /**
     * Timeout in milliseconds when waiting for the database to become unlocked.
     * @default 5000
     */
    timeout?: number;

    /**
     * Enable verbose mode for debugging SQL statements.
     */
    verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;

    /**
     * Enable WAL (Write-Ahead Logging) mode for better concurrent access.
     * Recommended for most use cases.
     * @default true
     */
    wal?: boolean;
}

/**
 * SQLite driver for Node.js using better-sqlite3.
 * This driver is synchronous but wraps operations in Promises for API compatibility.
 *
 * @example
 * ```ts
 * import { BetterSqlite3Driver } from '@anfenn/dync/node';
 * import { SQLiteAdapter } from '@anfenn/dync';
 *
 * const driver = new BetterSqlite3Driver('myapp.db', { wal: true });
 * const adapter = new SQLiteAdapter('myapp', driver);
 * ```
 */
export class BetterSqlite3Driver implements SQLiteDatabaseDriver {
    readonly type = 'BetterSqlite3Driver';
    private db: import('better-sqlite3').Database | null = null;
    private readonly options: BetterSqlite3DriverOptions;
    private opened = false;
    readonly name: string;

    constructor(databasePath: string, options: BetterSqlite3DriverOptions = {}) {
        this.name = databasePath;
        this.options = {
            wal: true,
            ...options,
        };
    }

    async open(): Promise<void> {
        if (this.opened) return;

        // Dynamic import to avoid bundling issues in non-Electron environments
        const Database = (await import('better-sqlite3')).default;

        this.db = new Database(this.name, {
            readonly: this.options.readonly ?? false,
            fileMustExist: this.options.fileMustExist ?? false,
            timeout: this.options.timeout ?? 5000,
            verbose: this.options.verbose,
        });

        // Enable WAL mode for better concurrent access (recommended)
        if (this.options.wal && !this.options.readonly) {
            this.db.pragma('journal_mode = WAL');
        }

        this.opened = true;
    }

    async close(): Promise<void> {
        if (!this.db) return;

        this.db.close();
        this.db = null;
        this.opened = false;
    }

    async execute(statement: string): Promise<void> {
        await this.open();
        this.db!.exec(statement);
    }

    async run(statement: string, values: unknown[] = []): Promise<SQLiteRunResult> {
        await this.open();

        const stmt = this.db!.prepare(statement);
        const result = stmt.run(...values);

        return {
            changes: result.changes,
            lastId: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : undefined,
        };
    }

    async query(statement: string, values: unknown[] = []): Promise<SQLiteQueryResult> {
        await this.open();

        const stmt = this.db!.prepare(statement);
        const rows = stmt.all(...values) as Record<string, unknown>[];

        if (rows.length === 0) {
            return { columns: [], values: [] };
        }

        const firstRow = rows[0]!;
        const columns = Object.keys(firstRow);
        const valuesMatrix = rows.map((row) => columns.map((col) => row[col]));

        return { columns, values: valuesMatrix };
    }

    /**
     * Access the underlying better-sqlite3 Database instance for advanced operations.
     * Returns null if the database is not open.
     */
    getDatabase(): import('better-sqlite3').Database | null {
        return this.db;
    }

    /**
     * Execute a function within a transaction.
     * This provides better performance when doing many writes.
     *
     * @example
     * ```ts
     * await driver.transaction(() => {
     *   driver.run('INSERT INTO users (name) VALUES (?)', ['Alice']);
     *   driver.run('INSERT INTO users (name) VALUES (?)', ['Bob']);
     * });
     * ```
     */
    transaction<T>(fn: () => T): T {
        if (!this.db) {
            throw new Error('Database not open. Call open() first.');
        }
        return this.db.transaction(fn)();
    }
}
