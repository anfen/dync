import type { StorageAdapter, StorageTable, StorageTransactionContext, TransactionMode } from '../types';
import type {
    TableSchemaDefinition,
    SQLiteTableDefinition,
    SQLiteColumnDefinition,
    SQLiteIndexDefinition,
    SQLiteDefaultValue,
    SQLiteForeignKeyReference,
} from './schema';
import type { StorageSchemaDefinitionOptions, SQLiteMigrationContext, SQLiteMigrationHandler } from './types';
import type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult } from './types';
import { LOCAL_PK } from '../../types';
import type { SQLiteAdapterOptions, SQLiteTableSchemaMetadata, SQLiteColumnSchema } from './types';
import { DYNC_STATE_TABLE } from '../../core/StateManager';
import { SQLITE_SCHEMA_VERSION_STATE_KEY, quoteIdentifier } from './helpers';
import { SQLiteTable } from './SQLiteTable';
import { SQLiteQueryContext } from './SQLiteQueryContext';

export class SQLiteAdapter implements StorageAdapter {
    readonly type = 'SQLiteAdapter';
    readonly name: string;

    private readonly options: SQLiteAdapterOptions;
    private readonly schemas = new Map<string, SQLiteTableSchemaMetadata>();
    private readonly versionSchemas = new Map<number, Map<string, SQLiteTableSchemaMetadata>>();
    private readonly versionOptions = new Map<number, StorageSchemaDefinitionOptions>();
    private readonly tableCache = new Map<string, SQLiteTable<any>>();
    private driver: SQLiteDatabaseDriver;
    private openPromise?: Promise<void>;
    private isOpen = false;
    private schemaApplied = false;
    private transactionDepth = 0;
    private targetVersion = 0;

    constructor(driver: SQLiteDatabaseDriver, options: SQLiteAdapterOptions = {}) {
        this.driver = driver;
        this.name = driver.name;
        this.options = options;
    }

    get driverType(): string {
        return this.driver.type;
    }

    /**
     * Opens the database connection and applies schema.
     * This is called automatically when performing operations,
     * so explicit calls are optional but safe (idempotent).
     * When called explicitly after schema changes, it will run any pending migrations.
     */
    async open(): Promise<void> {
        if (this.isOpen) {
            // Explicit open() call while already open - check for pending migrations
            await this.runPendingMigrations();
            return;
        }
        return this.ensureOpen();
    }

    private async ensureOpen(): Promise<void> {
        if (this.isOpen) {
            return;
        }
        if (this.openPromise) {
            return this.openPromise;
        }
        this.openPromise = this.performOpen();
        try {
            await this.openPromise;
        } finally {
            this.openPromise = undefined;
        }
    }

    private async performOpen(): Promise<void> {
        await this.driver.open();
        await this.applySchema();
        await this.runPendingMigrations();
        this.isOpen = true;
    }

    async close(): Promise<void> {
        if (this.driver) {
            await this.driver.close();
        }
        this.isOpen = false;
        this.tableCache.clear();
    }

    async delete(): Promise<void> {
        for (const table of this.schemas.keys()) {
            await this.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
        }
        await this.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(DYNC_STATE_TABLE)}`);

        this.tableCache.clear();
        this.schemaApplied = false;
        // Rebuild schemas from versionSchemas so the adapter remains usable.
        // The next operation will re-create the tables via applySchema().
        this.refreshActiveSchema();
    }

    defineSchema(version: number, schema: Record<string, TableSchemaDefinition>, options?: StorageSchemaDefinitionOptions): void {
        const normalized = new Map<string, SQLiteTableSchemaMetadata>();
        for (const [tableName, definition] of Object.entries(schema)) {
            if (typeof definition === 'string') {
                throw new Error(`SQLite adapter requires structured schema definitions. Table '${tableName}' must provide an object-based schema.`);
            }
            normalized.set(tableName, this.parseStructuredSchema(tableName, definition));
        }
        this.versionSchemas.set(version, normalized);
        this.versionOptions.set(version, options ?? {});
        this.refreshActiveSchema();
    }

    private refreshActiveSchema(): void {
        if (!this.versionSchemas.size) {
            this.schemas.clear();
            this.targetVersion = 0;
            this.schemaApplied = false;
            this.tableCache.clear();
            return;
        }

        const versions = Array.from(this.versionSchemas.keys());
        const latestVersion = Math.max(...versions);
        const latestSchema = this.versionSchemas.get(latestVersion);
        if (!latestSchema) {
            return;
        }

        this.schemas.clear();
        for (const [name, schema] of latestSchema.entries()) {
            this.schemas.set(name, schema);
        }

        if (this.targetVersion !== latestVersion) {
            this.tableCache.clear();
        }

        this.targetVersion = latestVersion;
        this.schemaApplied = false;
    }

    table<T = any>(name: string): StorageTable<T> {
        if (!this.schemas.has(name)) {
            throw new Error(`Table '${name}' is not part of the defined schema`);
        }
        if (!this.tableCache.has(name)) {
            this.tableCache.set(name, new SQLiteTable<T>(this, this.schemas.get(name)!));
        }
        return this.tableCache.get(name)! as StorageTable<T>;
    }

    async transaction<T>(_mode: TransactionMode, tableNames: string[], callback: (context: StorageTransactionContext) => Promise<T>): Promise<T> {
        const driver = await this.getDriver();
        const shouldManageTransaction = this.transactionDepth === 0;
        this.transactionDepth += 1;
        if (shouldManageTransaction) {
            this.logSql('BEGIN TRANSACTION');
            await driver.execute('BEGIN TRANSACTION');
        }
        try {
            const tables: Record<string, StorageTable<any>> = {};
            for (const tableName of tableNames) {
                tables[tableName] = this.table(tableName);
            }
            const result = await callback({ tables });
            if (shouldManageTransaction) {
                this.logSql('COMMIT');
                await driver.execute('COMMIT');
            }
            return result;
        } catch (err) {
            if (shouldManageTransaction) {
                this.logSql('ROLLBACK');
                await driver.execute('ROLLBACK');
            }
            throw err;
        } finally {
            this.transactionDepth -= 1;
        }
    }

    async execute(statement: string, values?: any[]): Promise<void> {
        if (values && values.length) {
            await this.run(statement, values);
            return;
        }
        const driver = await this.getDriver();
        this.logSql(statement);
        await driver.execute(statement);
    }

    async run(statement: string, values?: any[]): Promise<SQLiteRunResult> {
        const driver = await this.getDriver();
        const params = values ?? [];
        this.logSql(statement, params);
        return driver.run(statement, params);
    }

    async query<R>(callback: (ctx: SQLiteQueryContext) => Promise<R>): Promise<R>;
    async query(statement: string, values?: any[]): Promise<SQLiteQueryResult>;
    async query<R>(arg1: string | ((ctx: SQLiteQueryContext) => Promise<R>), arg2?: any[]): Promise<R | SQLiteQueryResult> {
        if (typeof arg1 === 'function') {
            return arg1(new SQLiteQueryContext(this));
        }
        const statement = arg1;
        const values = arg2;
        const driver = await this.getDriver();
        const params = values ?? [];
        this.logSql(statement, params);
        return driver.query(statement, params);
    }

    async queryRows(statement: string, values?: any[]): Promise<Array<Record<string, any>>> {
        const result = await this.query(statement, values);
        const columns = result.columns ?? [];
        return (result.values ?? []).map((row) => {
            const record: Record<string, any> = {};
            for (let index = 0; index < columns.length; index += 1) {
                record[columns[index]!] = row[index];
            }
            return record;
        });
    }

    /**
     * Ensures the database is open and returns the driver.
     * This is the main entry point for all public database operations.
     */
    private async getDriver(): Promise<SQLiteDatabaseDriver> {
        await this.ensureOpen();
        return this.driver;
    }

    /**
     * Internal execute that uses driver directly.
     * Used during the open process to avoid recursion.
     */
    private async internalExecute(statement: string, values?: any[]): Promise<void> {
        if (values && values.length) {
            await this.internalRun(statement, values);
            return;
        }
        this.logSql(statement);
        await this.driver.execute(statement);
    }

    /**
     * Internal run that uses driver directly.
     * Used during the open process to avoid recursion.
     */
    private async internalRun(statement: string, values?: any[]): Promise<SQLiteRunResult> {
        const params = values ?? [];
        this.logSql(statement, params);
        return this.driver.run(statement, params);
    }

    /**
     * Internal queryRows that uses driver directly.
     * Used during the open process to avoid recursion.
     */
    private async internalQueryRows(statement: string, values?: any[]): Promise<Array<Record<string, any>>> {
        const params = values ?? [];
        this.logSql(statement, params);
        const result = await this.driver.query(statement, params);
        const columns = result.columns ?? [];
        return (result.values ?? []).map((row) => {
            const record: Record<string, any> = {};
            for (let index = 0; index < columns.length; index += 1) {
                record[columns[index]!] = row[index];
            }
            return record;
        });
    }

    /**
     * Internal query that uses driver directly.
     * Used during migrations to avoid recursion.
     */
    private async internalQuery(statement: string, values?: any[]): Promise<SQLiteQueryResult> {
        const params = values ?? [];
        this.logSql(statement, params);
        return this.driver.query(statement, params);
    }

    private logSql(statement: string, parameters?: any[]): void {
        const { debug } = this.options;
        if (!debug) {
            return;
        }
        const hasParams = parameters && parameters.length;
        if (typeof debug === 'function') {
            debug(statement, hasParams ? parameters : undefined);
            return;
        }
        if (debug === true) {
            if (hasParams) {
                console.debug('[dync][sqlite]', statement, parameters);
            } else {
                console.debug('[dync][sqlite]', statement);
            }
        }
    }

    private async getStoredSchemaVersion(): Promise<number> {
        const rows = await this.internalQueryRows(`SELECT value FROM ${quoteIdentifier(DYNC_STATE_TABLE)} WHERE ${quoteIdentifier(LOCAL_PK)} = ? LIMIT 1`, [
            SQLITE_SCHEMA_VERSION_STATE_KEY,
        ]);
        const rawValue = rows[0]?.value;
        const parsed = Number(rawValue ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private async setStoredSchemaVersion(version: number): Promise<void> {
        await this.internalRun(
            `INSERT INTO ${quoteIdentifier(DYNC_STATE_TABLE)} (${quoteIdentifier(LOCAL_PK)}, value) VALUES (?, ?) ON CONFLICT(${quoteIdentifier(LOCAL_PK)}) DO UPDATE SET value = excluded.value`,
            [SQLITE_SCHEMA_VERSION_STATE_KEY, String(version)],
        );
    }

    private async runPendingMigrations(): Promise<void> {
        if (!this.versionSchemas.size) {
            await this.setStoredSchemaVersion(0);
            return;
        }

        const targetVersion = this.targetVersion;
        const currentVersion = await this.getStoredSchemaVersion();

        if (currentVersion === targetVersion) {
            return;
        }

        if (currentVersion < targetVersion) {
            for (let version = currentVersion + 1; version <= targetVersion; version += 1) {
                await this.runMigrationStep(version, 'up');
                await this.setStoredSchemaVersion(version);
            }
            return;
        }

        for (let version = currentVersion; version > targetVersion; version -= 1) {
            await this.runMigrationStep(version, 'down');
            await this.setStoredSchemaVersion(version - 1);
        }
    }

    private async runMigrationStep(version: number, direction: 'up' | 'down'): Promise<void> {
        const handler = this.getMigrationHandler(version, direction);
        if (!handler) {
            return;
        }
        const context: SQLiteMigrationContext = {
            execute: (statement: string) => this.internalExecute(statement),
            run: (statement: string, values?: any[]) => this.internalRun(statement, values),
            query: (statement: string, values?: any[]) => this.internalQuery(statement, values),
        };
        await handler(context);
    }

    private getMigrationHandler(version: number, direction: 'up' | 'down'): SQLiteMigrationHandler | undefined {
        const options = this.versionOptions.get(version);
        const migrations = options?.sqlite?.migrations;
        if (!migrations) {
            return undefined;
        }
        return direction === 'up' ? migrations.up : migrations.down;
    }

    private async applySchema(): Promise<void> {
        if (this.schemaApplied) {
            return;
        }
        for (const schema of this.schemas.values()) {
            await this.internalExecute(this.buildCreateTableStatement(schema));
            const indexStatements = this.buildIndexStatements(schema);
            for (const statement of indexStatements) {
                await this.internalExecute(statement);
            }
        }
        this.schemaApplied = true;
    }

    private buildCreateTableStatement(schema: SQLiteTableSchemaMetadata): string {
        const columns: string[] = [];

        for (const column of Object.values(schema.definition.columns)) {
            columns.push(this.buildStructuredColumnDefinition(column));
        }

        if (schema.definition.source === 'structured' && Array.isArray(schema.definition.tableConstraints)) {
            columns.push(...schema.definition.tableConstraints.filter(Boolean));
        }

        const trailingClauses = [schema.definition.withoutRowId ? 'WITHOUT ROWID' : undefined, schema.definition.strict ? 'STRICT' : undefined].filter(Boolean);

        const suffix = trailingClauses.length ? ` ${trailingClauses.join(' ')}` : '';
        return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schema.name)} (${columns.join(', ')})${suffix}`;
    }

    private buildStructuredColumnDefinition(column: SQLiteColumnSchema): string {
        const parts: string[] = [];
        parts.push(quoteIdentifier(column.name));
        parts.push(this.formatColumnType(column));

        if (column.name === LOCAL_PK) {
            parts.push('PRIMARY KEY');
        }

        if (column.collate) {
            parts.push(`COLLATE ${column.collate}`);
        }

        if (column.generatedAlwaysAs) {
            const storage = column.stored ? 'STORED' : 'VIRTUAL';
            parts.push(`GENERATED ALWAYS AS (${column.generatedAlwaysAs}) ${storage}`);
        }

        if (column.unique) {
            parts.push('UNIQUE');
        }

        if (column.default !== undefined) {
            parts.push(`DEFAULT ${this.formatDefaultValue(column.default)}`);
        }

        if (column.check) {
            parts.push(`CHECK (${column.check})`);
        }

        if (column.references) {
            parts.push(this.buildReferencesClause(column.references));
        }

        if (column.constraints?.length) {
            parts.push(...column.constraints);
        }

        return parts.filter(Boolean).join(' ');
    }

    private formatColumnType(column: SQLiteColumnSchema): string {
        const declaredType = column.type?.trim().toUpperCase();
        // Map BOOLEAN to INTEGER for SQLite storage (SQLite has no native boolean type)
        const base = !declaredType || !declaredType.length ? 'NUMERIC' : declaredType === 'BOOLEAN' ? 'INTEGER' : declaredType;
        if (column.length && !base.includes('(')) {
            return `${base}(${column.length})`;
        }
        return base;
    }

    private formatDefaultValue(value: SQLiteDefaultValue): string {
        if (value === null) {
            return 'NULL';
        }
        if (typeof value === 'number') {
            return String(value);
        }
        if (typeof value === 'boolean') {
            return value ? '1' : '0';
        }
        const escaped = String(value).replace(/'/g, "''");
        return `'${escaped}'`;
    }

    private buildReferencesClause(reference: SQLiteForeignKeyReference | string): string {
        if (typeof reference === 'string') {
            return `REFERENCES ${reference}`;
        }
        const parts: string[] = [];
        parts.push(`REFERENCES ${quoteIdentifier(reference.table)}`);
        if (reference.column) {
            parts.push(`(${quoteIdentifier(reference.column)})`);
        }
        if (reference.match) {
            parts.push(`MATCH ${reference.match}`);
        }
        if (reference.onDelete) {
            parts.push(`ON DELETE ${reference.onDelete}`);
        }
        if (reference.onUpdate) {
            parts.push(`ON UPDATE ${reference.onUpdate}`);
        }
        return parts.join(' ');
    }

    private buildIndexStatements(schema: SQLiteTableSchemaMetadata): string[] {
        if (schema.definition.source !== 'structured' || !schema.definition.indexes?.length) {
            return [];
        }
        const statements: string[] = [];
        schema.definition.indexes.forEach((index, position) => {
            if (!index.columns?.length) {
                return;
            }
            const indexName = this.generateIndexName(schema, index, position);
            const columnSegments = index.columns.map((columnName, columnIndex) => {
                const segments = [quoteIdentifier(columnName)];
                if (index.collate) {
                    segments.push(`COLLATE ${index.collate}`);
                }
                const order = index.orders?.[columnIndex];
                if (order) {
                    segments.push(order);
                }
                return segments.join(' ');
            });
            const whereClause = index.where ? ` WHERE ${index.where}` : '';
            statements.push(
                `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(schema.name)} (${columnSegments.join(', ')})${whereClause}`,
            );
        });
        return statements;
    }

    private generateIndexName(schema: SQLiteTableSchemaMetadata, index: SQLiteIndexDefinition, position: number): string {
        if (index.name) {
            return index.name;
        }
        const sanitizedColumns = index.columns.map((column) => column.replace(/[^A-Za-z0-9_]/g, '_')).join('_');
        const suffix = sanitizedColumns || String(position);
        return `${schema.name}_${suffix}_idx`;
    }

    private parseStructuredSchema(tableName: string, definition: SQLiteTableDefinition): SQLiteTableSchemaMetadata {
        if (!definition?.columns || !Object.keys(definition.columns).length) {
            throw new Error(`SQLite schema for table '${tableName}' must define at least one column.`);
        }

        if (!definition.columns[LOCAL_PK]) {
            throw new Error(`SQLite schema for table '${tableName}' must define a column named '${LOCAL_PK}'.`);
        }

        const normalizedColumns = this.normalizeColumns(definition.columns);

        return {
            name: tableName,
            definition: {
                ...definition,
                name: tableName,
                columns: normalizedColumns,
                source: 'structured',
            },
        };
    }

    private normalizeColumns(columns: Record<string, SQLiteColumnDefinition>): Record<string, SQLiteColumnSchema> {
        const normalized: Record<string, SQLiteColumnSchema> = {};
        for (const [name, column] of Object.entries(columns)) {
            normalized[name] = {
                name,
                ...column,
                nullable: column?.nullable ?? true,
            };
        }
        return normalized;
    }
}
