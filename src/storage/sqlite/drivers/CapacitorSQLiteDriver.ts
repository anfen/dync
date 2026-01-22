import type { SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult } from '../types';

// Lazily loaded module cache to avoid top-level imports that break web bundlers
let sqliteModuleCache: typeof import('@capacitor-community/sqlite') | null = null;

async function getSqliteModule(): Promise<typeof import('@capacitor-community/sqlite')> {
    if (!sqliteModuleCache) {
        sqliteModuleCache = await import('@capacitor-community/sqlite');
    }
    return sqliteModuleCache;
}

export interface CapacitorSQLiteDriverOptions {
    encrypted?: boolean;
    getEncryptionKey?: () => string;
    readonly?: boolean;
    mode?: string;
    version?: number;
}

export class CapacitorSQLiteDriver implements SQLiteDatabaseDriver {
    readonly type = 'CapacitorSQLiteDriver';
    private connectionFactory?: SQLiteConnection;
    private readonly config: CapacitorSQLiteDriverOptions;
    private db?: SQLiteDBConnection;
    private openPromise?: Promise<void>;
    private opened = false;
    readonly name: string;

    constructor(databaseName: string, config: CapacitorSQLiteDriverOptions = {}) {
        this.name = databaseName;
        this.config = config;
    }

    private async getConnectionFactory(): Promise<SQLiteConnection> {
        if (!this.connectionFactory) {
            const { CapacitorSQLite, SQLiteConnection } = await getSqliteModule();
            this.connectionFactory = new SQLiteConnection(CapacitorSQLite);
        }
        return this.connectionFactory;
    }

    private async ensureDb(): Promise<SQLiteDBConnection> {
        if (!this.db) {
            const connectionFactory = await this.getConnectionFactory();
            const readonly = this.config.readonly ?? false;

            // Check if a connection already exists (e.g., after page reload)
            const existsResult = await connectionFactory.isConnection(this.name, readonly);
            if (existsResult.result) {
                // Connection exists - retrieve it instead of creating a new one
                this.db = await connectionFactory.retrieveConnection(this.name, readonly);
            } else {
                // Close any stale native connection (e.g., after page reload) before creating
                await connectionFactory.closeConnection(this.name, readonly).catch(() => {});
                this.db = await connectionFactory.createConnection(
                    this.name,
                    this.config.encrypted ?? false,
                    this.config.mode ?? 'no-encryption',
                    this.config.version ?? 1,
                    readonly,
                );
            }

            // New/retrieved connection means we need to (re)open it.
            this.opened = false;
        }
        return this.db;
    }

    async open(): Promise<void> {
        if (this.opened) return;
        if (this.openPromise) return this.openPromise;

        this.openPromise = (async () => {
            const connectionFactory = await this.getConnectionFactory();
            // Set encryption secret if provided and not already stored (must be done before opening)
            if (this.config.getEncryptionKey) {
                const { result: isStored } = await connectionFactory.isSecretStored();
                if (!isStored) {
                    const key = this.config.getEncryptionKey();
                    if (!key && this.config.encrypted) {
                        throw new Error('CapacitorSQLiteDriverOptions.encrypted=true but no encryption key was provided (getEncryptionKey).');
                    }
                    await connectionFactory.setEncryptionSecret(key);
                }
            }
            const db = await this.ensureDb();
            await db.open();
            this.opened = true;
        })();

        try {
            await this.openPromise;
        } finally {
            this.openPromise = undefined;
        }
    }

    async close(): Promise<void> {
        if (!this.db) return;
        await this.db.close();
        const connectionFactory = await this.getConnectionFactory();
        await connectionFactory.closeConnection(this.name, this.config.readonly ?? false);
        this.db = undefined;
        this.opened = false;
        this.openPromise = undefined;
    }

    async execute(statement: string): Promise<void> {
        await this.open();
        const db = await this.ensureDb();
        await db.execute(statement, false);
    }

    async run(statement: string, values: any[] = []): Promise<SQLiteRunResult> {
        await this.open();
        const db = await this.ensureDb();
        const result = await db.run(statement, values, false, 'no');
        const changes = (result as any)?.changes?.changes ?? (result as any)?.changes ?? 0;
        const lastId = (result as any)?.changes?.lastId ?? undefined;
        return { changes, lastId };
    }

    async query(statement: string, values: any[] = []): Promise<SQLiteQueryResult> {
        await this.open();
        const db = await this.ensureDb();
        const result: any = await db.query(statement, values, true);
        if (Array.isArray(result?.values) && result.values.length > 0 && !Array.isArray(result.values[0])) {
            const columns = Object.keys(result.values[0]);
            const rows = result.values.map((row: Record<string, any>) => columns.map((column) => row[column]));
            return { columns, values: rows };
        }
        return { columns: result?.columns ?? [], values: result?.values ?? [] };
    }
}
