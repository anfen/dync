import type { AddItem, StorageTable, StorageWhereClause, StorageCollection } from '../types';
import { LOCAL_PK } from '../../types';
import type { SQLiteTableSchemaMetadata, SQLiteIterateEntriesOptions, SQLiteOrderByOptions, SQLiteCollectionState, TableEntry } from './types';
import { SQLiteAdapter } from './SQLiteAdapter';
import { SQLiteCollection } from './SQLiteCollection';
import { SQLiteWhereClause } from './SQLiteWhereClause';
import { cloneValue, createDefaultState, normalizeComparableValue, quoteIdentifier, DEFAULT_STREAM_BATCH_SIZE } from './helpers';

export class SQLiteTable<T = any> implements StorageTable<T> {
    readonly name: string;
    readonly schema: SQLiteTableSchemaMetadata;
    readonly hook: unknown = Object.freeze({});
    readonly raw: {
        add: (item: T) => Promise<string>;
        put: (item: T) => Promise<string>;
        update: (key: string, changes: Partial<T>) => Promise<number>;
        delete: (key: string) => Promise<void>;
        get: (key: string) => Promise<T | undefined>;
        bulkAdd: (items: T[]) => Promise<string[]>;
        bulkPut: (items: T[]) => Promise<string[]>;
        bulkUpdate: (keysAndChanges: Array<{ key: string; changes: Partial<T> }>) => Promise<number>;
        bulkDelete: (keys: string[]) => Promise<void>;
        clear: () => Promise<void>;
    };

    private readonly adapter: SQLiteAdapter;
    private readonly columnNames: string[];
    private readonly booleanColumns: Set<string>;

    constructor(adapter: SQLiteAdapter, schema: SQLiteTableSchemaMetadata) {
        this.adapter = adapter;
        this.schema = schema;
        this.name = schema.name;
        this.columnNames = Object.keys(schema.definition.columns ?? {});
        // Track which columns are declared as BOOLEAN for read/write conversion
        this.booleanColumns = new Set(
            Object.entries(schema.definition.columns ?? {})
                .filter(([_, col]) => col.type?.toUpperCase() === 'BOOLEAN')
                .map(([name]) => name),
        );
        // Capture bound methods BEFORE any wrapping can occur
        // These provide access to the underlying storage operations
        this.raw = Object.freeze({
            add: this.baseAdd.bind(this),
            put: this.basePut.bind(this),
            update: this.baseUpdate.bind(this),
            delete: this.baseDelete.bind(this),
            get: this.get.bind(this),
            bulkAdd: this.baseBulkAdd.bind(this),
            bulkPut: this.baseBulkPut.bind(this),
            bulkUpdate: this.baseBulkUpdate.bind(this),
            bulkDelete: this.baseBulkDelete.bind(this),
            clear: this.baseClear.bind(this),
        });
    }

    async add(item: AddItem<T>): Promise<string> {
        return this.baseAdd(item as T);
    }

    async put(item: T): Promise<string> {
        return this.basePut(item);
    }

    async update(key: string, changes: Partial<T>): Promise<number> {
        return this.baseUpdate(key, changes);
    }

    async delete(key: string): Promise<void> {
        await this.baseDelete(key);
    }

    async clear(): Promise<void> {
        await this.baseClear();
    }

    private async baseClear(): Promise<void> {
        await this.adapter.execute(`DELETE FROM ${quoteIdentifier(this.name)}`);
    }

    async get(key: string): Promise<T | undefined> {
        if (!key || typeof key !== 'string') {
            return undefined;
        }
        const row = await this.fetchRow(key);
        return row ? this.cloneRecord(row) : undefined;
    }

    async toArray(): Promise<T[]> {
        const entries = await this.getEntries();
        return entries.map((entry) => this.cloneRecord(entry.value));
    }

    async count(): Promise<number> {
        const rows = await this.adapter.queryRows(`SELECT COUNT(*) as count FROM ${quoteIdentifier(this.name)}`);
        return Number(rows[0]?.count ?? 0);
    }

    async bulkAdd(items: AddItem<T>[]): Promise<string[]> {
        return this.baseBulkAdd(items as T[]);
    }

    private async baseBulkAdd(items: T[]): Promise<string[]> {
        if (!items.length) return [];

        const columns = this.columnNames;
        const columnCount = columns.length;
        // SQLite has a parameter limit (typically 999 or 32766). Use conservative batch size.
        const maxParamsPerBatch = 500;
        const batchSize = Math.max(1, Math.floor(maxParamsPerBatch / columnCount));

        const allKeys: string[] = [];

        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            const records = batch.map((item) => this.prepareRecordForWrite(item));

            const placeholderRow = `(${columns.map(() => '?').join(', ')})`;
            const placeholders = records.map(() => placeholderRow).join(', ');
            const values: unknown[] = [];

            for (const record of records) {
                values.push(...this.extractColumnValues(record));
                allKeys.push((record as any)[LOCAL_PK]);
            }

            await this.adapter.run(
                `INSERT INTO ${quoteIdentifier(this.name)} (${columns.map((c) => quoteIdentifier(c)).join(', ')}) VALUES ${placeholders}`,
                values,
            );
        }

        return allKeys;
    }

    async bulkPut(items: T[]): Promise<string[]> {
        return this.baseBulkPut(items);
    }

    private async baseBulkPut(items: T[]): Promise<string[]> {
        if (!items.length) return [];

        const columns = this.columnNames;
        const columnCount = columns.length;
        const maxParamsPerBatch = 500;
        const batchSize = Math.max(1, Math.floor(maxParamsPerBatch / columnCount));

        const allKeys: string[] = [];

        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            const records = batch.map((item) => this.prepareRecordForWrite(item));

            const placeholderRow = `(${columns.map(() => '?').join(', ')})`;
            const placeholders = records.map(() => placeholderRow).join(', ');
            const values: unknown[] = [];

            for (const record of records) {
                values.push(...this.extractColumnValues(record));
                allKeys.push((record as any)[LOCAL_PK]);
            }

            await this.adapter.run(
                `INSERT OR REPLACE INTO ${quoteIdentifier(this.name)} (${columns.map((c) => quoteIdentifier(c)).join(', ')}) VALUES ${placeholders}`,
                values,
            );
        }

        return allKeys;
    }

    async bulkGet(keys: string[]): Promise<Array<T | undefined>> {
        if (!keys.length) return [];

        // Use IN clause for bulk lookup
        const validKeys = keys.filter((k) => k && typeof k === 'string');
        if (!validKeys.length) return keys.map(() => undefined);

        const selectClause = this.buildSelectClause();
        const placeholders = validKeys.map(() => '?').join(', ');

        const rows = await this.adapter.queryRows(
            `SELECT ${selectClause} FROM ${quoteIdentifier(this.name)} WHERE ${quoteIdentifier(LOCAL_PK)} IN (${placeholders})`,
            validKeys,
        );

        // Build a map of key -> record for quick lookup
        const recordMap = new Map<string, T>();
        for (const row of rows) {
            const record = this.hydrateRow(row);
            recordMap.set(String(row[LOCAL_PK]), this.cloneRecord(record));
        }

        // Return results in the same order as input keys
        return keys.map((key) => (key && typeof key === 'string' ? recordMap.get(key) : undefined));
    }

    async bulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): Promise<number> {
        return this.baseBulkUpdate(keysAndChanges);
    }

    private async baseBulkUpdate(keysAndChanges: Array<{ key: string; changes: Partial<T> }>): Promise<number> {
        if (!keysAndChanges.length) return 0;

        let updatedCount = 0;
        for (const { key, changes } of keysAndChanges) {
            const result = await this.baseUpdate(key, changes);
            updatedCount += result;
        }
        return updatedCount;
    }

    async bulkDelete(keys: string[]): Promise<void> {
        await this.baseBulkDelete(keys);
    }

    private async baseBulkDelete(keys: string[]): Promise<void> {
        if (!keys.length) return;

        const validKeys = keys.filter((k) => k && typeof k === 'string');
        if (!validKeys.length) return;

        const placeholders = validKeys.map(() => '?').join(', ');
        await this.adapter.run(`DELETE FROM ${quoteIdentifier(this.name)} WHERE ${quoteIdentifier(LOCAL_PK)} IN (${placeholders})`, validKeys);
    }

    where(index: string | string[]): StorageWhereClause<T> {
        return this.createWhereClause(index);
    }

    orderBy(index: string | string[]): StorageCollection<T> {
        return this.createCollection({
            orderBy: { index, direction: 'asc' },
        });
    }

    reverse(): StorageCollection<T> {
        return this.createCollection({ reverse: true });
    }

    offset(offset: number): StorageCollection<T> {
        return this.createCollection({ offset });
    }

    limit(count: number): StorageCollection<T> {
        return this.createCollection({ limit: count });
    }

    mapToClass(_ctor: new (...args: any[]) => any): StorageTable<T> {
        return this;
    }

    async each(callback: (item: T) => void | Promise<void>): Promise<void> {
        const entries = await this.getEntries();
        for (const entry of entries) {
            await callback(this.cloneRecord(entry.value));
        }
    }

    jsFilter(predicate: (item: T) => boolean): StorageCollection<T> {
        return this.createCollection({ jsPredicate: (record) => predicate(record) });
    }

    createCollection(stateOverrides?: Partial<SQLiteCollectionState<T>>): SQLiteCollection<T> {
        return new SQLiteCollection(this, stateOverrides);
    }

    createCollectionFromPredicate(predicate: (record: T, key: string, index: number) => boolean, template?: SQLiteCollection<T>): SQLiteCollection<T> {
        const baseState = template ? template.getState() : createDefaultState<T>();
        const existingPredicate = baseState.jsPredicate;
        const combinedPredicate = existingPredicate
            ? (record: T, key: string, index: number) => existingPredicate(record, key, index) && predicate(record, key, index)
            : predicate;
        return new SQLiteCollection(this, {
            ...baseState,
            jsPredicate: combinedPredicate,
        });
    }

    createWhereClause(index: string | string[], baseCollection?: SQLiteCollection<T>): SQLiteWhereClause<T> {
        return new SQLiteWhereClause(this, index, baseCollection);
    }

    async *iterateEntries(options?: SQLiteIterateEntriesOptions): AsyncGenerator<TableEntry<T>> {
        const selectClause = this.buildSelectClause();
        const chunkSize = options?.chunkSize ?? DEFAULT_STREAM_BATCH_SIZE;
        const orderClause = this.buildOrderByClause(options?.orderBy);
        let offset = 0;

        while (true) {
            const statementParts = [`SELECT ${selectClause} FROM ${quoteIdentifier(this.name)}`];
            if (orderClause) {
                statementParts.push(orderClause);
            }
            statementParts.push(`LIMIT ${chunkSize} OFFSET ${offset}`);
            const rows = await this.adapter.queryRows(statementParts.join(' '));
            if (!rows.length) {
                break;
            }
            for (const row of rows) {
                yield { key: String(row[LOCAL_PK]), value: this.hydrateRow(row) };
            }
            if (rows.length < chunkSize) {
                break;
            }
            offset += rows.length;
        }
    }

    /**
     * Execute a query with pre-built WHERE clause and parameters.
     * This is used by SQLiteCollection for native SQL performance.
     */
    async queryWithConditions(options: {
        whereClause: string;
        parameters: unknown[];
        orderBy?: { index: string | string[]; direction: 'asc' | 'desc' };
        limit?: number;
        offset?: number;
        distinct?: boolean;
    }): Promise<T[]> {
        const selectClause = this.buildSelectClause();
        const distinctKeyword = options.distinct ? 'DISTINCT ' : '';
        const parts = [`SELECT ${distinctKeyword}${selectClause} FROM ${quoteIdentifier(this.name)}`];

        if (options.whereClause) {
            parts.push(options.whereClause);
        }

        if (options.orderBy) {
            parts.push(this.buildOrderByClause(options.orderBy));
        }

        if (options.limit !== undefined) {
            parts.push(`LIMIT ${options.limit}`);
        }

        if (options.offset !== undefined && options.offset > 0) {
            parts.push(`OFFSET ${options.offset}`);
        }

        const rows = await this.adapter.queryRows(parts.join(' '), options.parameters);
        return rows.map((row) => this.hydrateRow(row));
    }

    /**
     * Execute a COUNT query with pre-built WHERE clause.
     */
    async countWithConditions(options: { whereClause: string; parameters: unknown[]; distinct?: boolean }): Promise<number> {
        const distinctKeyword = options.distinct ? 'DISTINCT ' : '';
        const selectClause = this.buildSelectClause();
        // For DISTINCT, we need to count distinct rows, not just COUNT(*)
        const countExpr = options.distinct ? `COUNT(${distinctKeyword}${selectClause})` : 'COUNT(*)';
        const parts = [`SELECT ${countExpr} as count FROM ${quoteIdentifier(this.name)}`];

        if (options.whereClause) {
            parts.push(options.whereClause);
        }

        const rows = await this.adapter.queryRows(parts.join(' '), options.parameters);
        return Number(rows[0]?.count ?? 0);
    }

    /**
     * Execute a DELETE query with pre-built WHERE clause.
     * Returns the number of deleted rows.
     */
    async deleteWithConditions(options: { whereClause: string; parameters: unknown[] }): Promise<number> {
        const parts = [`DELETE FROM ${quoteIdentifier(this.name)}`];

        if (options.whereClause) {
            parts.push(options.whereClause);
        }

        const result = await this.adapter.run(parts.join(' '), options.parameters);
        return result.changes ?? 0;
    }

    /**
     * Execute an UPDATE query with pre-built WHERE clause.
     * Returns the number of updated rows.
     */
    async updateWithConditions(options: { whereClause: string; parameters: unknown[]; changes: Partial<T> }): Promise<number> {
        const changeEntries = Object.entries(options.changes);
        if (changeEntries.length === 0) {
            return 0;
        }

        const setClauses = changeEntries.map(([column]) => `${quoteIdentifier(column)} = ?`);
        const setValues = changeEntries.map(([, value]) => this.normalizeColumnValue(value));

        const parts = [`UPDATE ${quoteIdentifier(this.name)} SET ${setClauses.join(', ')}`];

        if (options.whereClause) {
            parts.push(options.whereClause);
        }

        const result = await this.adapter.run(parts.join(' '), [...setValues, ...options.parameters]);
        return result.changes ?? 0;
    }

    /**
     * Query only primary keys with pre-built WHERE clause.
     * This is more efficient than fetching full rows when only keys are needed.
     */
    async queryKeysWithConditions(options: {
        whereClause: string;
        parameters: unknown[];
        orderBy?: { index: string | string[]; direction: 'asc' | 'desc' };
        limit?: number;
        offset?: number;
        distinct?: boolean;
    }): Promise<string[]> {
        const distinctKeyword = options.distinct ? 'DISTINCT ' : '';
        const parts = [`SELECT ${distinctKeyword}${quoteIdentifier(LOCAL_PK)} FROM ${quoteIdentifier(this.name)}`];

        if (options.whereClause) {
            parts.push(options.whereClause);
        }

        if (options.orderBy) {
            parts.push(this.buildOrderByClause(options.orderBy));
        }

        if (options.limit !== undefined) {
            parts.push(`LIMIT ${options.limit}`);
        }

        if (options.offset !== undefined && options.offset > 0) {
            parts.push(`OFFSET ${options.offset}`);
        }

        const rows = await this.adapter.queryRows(parts.join(' '), options.parameters);
        return rows.map((row) => String(row[LOCAL_PK]));
    }

    async getEntries(): Promise<TableEntry<T>[]> {
        const entries: TableEntry<T>[] = [];
        for await (const entry of this.iterateEntries()) {
            entries.push(entry);
        }
        return entries;
    }

    cloneRecord(record: T): T {
        return cloneValue(record);
    }

    compareValues(left: unknown, right: unknown): number {
        const normalizedLeft = normalizeComparableValue(left) as any;
        const normalizedRight = normalizeComparableValue(right) as any;
        if (normalizedLeft < normalizedRight) return -1;
        if (normalizedLeft > normalizedRight) return 1;
        return 0;
    }

    compareByIndex(left: T, right: T, index: string | string[]): number {
        if (Array.isArray(index)) {
            for (const key of index) {
                const diff = this.compareValues((left as any)[key], (right as any)[key]);
                if (diff !== 0) {
                    return diff;
                }
            }
            return 0;
        }
        return this.compareValues((left as any)[index], (right as any)[index]);
    }

    getIndexValue(record: T, index: string | string[]): unknown {
        if (Array.isArray(index)) {
            return index.map((key) => (record as any)[key]);
        }
        return (record as any)[index];
    }

    async replaceRecord(record: T): Promise<void> {
        if (!this.columnNames.length) {
            return;
        }
        const assignments = this.columnNames.map((column) => `${quoteIdentifier(column)} = ?`).join(', ');
        const values = this.extractColumnValues(record);
        await this.adapter.run(`UPDATE ${quoteIdentifier(this.name)} SET ${assignments} WHERE ${quoteIdentifier(LOCAL_PK)} = ?`, [
            ...values,
            (record as any)[LOCAL_PK],
        ]);
    }

    async deleteByPrimaryKey(primaryKey: string): Promise<void> {
        await this.adapter.run(`DELETE FROM ${quoteIdentifier(this.name)} WHERE ${quoteIdentifier(LOCAL_PK)} = ?`, [primaryKey]);
    }

    private async baseAdd(item: T): Promise<string> {
        const record = this.prepareRecordForWrite(item);
        const columns = this.columnNames;
        const placeholders = columns.map(() => '?').join(', ');
        const values = this.extractColumnValues(record);
        await this.adapter.run(
            `INSERT INTO ${quoteIdentifier(this.name)} (${columns.map((column) => quoteIdentifier(column)).join(', ')}) VALUES (${placeholders})`,
            values,
        );
        return (record as any)[LOCAL_PK];
    }

    private async basePut(item: T): Promise<string> {
        const record = this.prepareRecordForWrite(item);
        const columns = this.columnNames;
        const placeholders = columns.map(() => '?').join(', ');
        const values = this.extractColumnValues(record);
        await this.adapter.run(
            `INSERT OR REPLACE INTO ${quoteIdentifier(this.name)} (${columns.map((column) => quoteIdentifier(column)).join(', ')}) VALUES (${placeholders})`,
            values,
        );
        return (record as any)[LOCAL_PK];
    }

    private async baseUpdate(key: unknown, changes: Partial<T>): Promise<number> {
        if (!key || typeof key !== 'string') {
            return 0;
        }
        const existing = await this.fetchRow(key);
        if (!existing) {
            return 0;
        }
        const updated = { ...existing, ...changes } as T;
        await this.replaceRecord(updated);
        return 1;
    }

    private async baseDelete(key: unknown): Promise<void> {
        if (!key || typeof key !== 'string') {
            return;
        }
        await this.deleteByPrimaryKey(key);
    }

    private prepareRecordForWrite(item: T): T {
        const clone = this.cloneRecord(item);
        const primaryValue = (clone as any)[LOCAL_PK];

        if (!primaryValue || typeof primaryValue !== 'string') {
            throw new Error(`Missing required primary key field "${LOCAL_PK}" - a string value must be provided`);
        }

        return clone;
    }

    private async fetchRow(primaryKey: string): Promise<T | undefined> {
        const selectClause = this.buildSelectClause();
        const rows = await this.adapter.queryRows(`SELECT ${selectClause} FROM ${quoteIdentifier(this.name)} WHERE ${quoteIdentifier(LOCAL_PK)} = ? LIMIT 1`, [
            primaryKey,
        ]);
        if (!rows.length) {
            return undefined;
        }
        return this.hydrateRow(rows[0]!);
    }

    private buildSelectClause(): string {
        const dataColumns = this.columnNames.map((column) => quoteIdentifier(column));
        return dataColumns.join(', ');
    }

    private hydrateRow(row: Record<string, any>): T {
        const record: Record<string, any> = {};
        for (const column of this.columnNames) {
            let value = row[column];
            // Convert INTEGER back to boolean for BOOLEAN columns
            if (this.booleanColumns.has(column) && value !== null && value !== undefined) {
                value = value === 1 || value === true;
            }
            record[column] = value;
        }
        return record as T;
    }

    private buildOrderByClause(orderBy?: SQLiteOrderByOptions): string {
        const target = orderBy ?? { index: LOCAL_PK, direction: 'asc' as const };
        const columns = Array.isArray(target.index) ? target.index : [target.index];
        const direction = target.direction.toUpperCase();
        const clause = columns.map((column) => `${quoteIdentifier(column)} ${direction}`).join(', ');
        return `ORDER BY ${clause}`;
    }

    private extractColumnValues(record: T): any[] {
        return this.columnNames.map((column) => this.normalizeColumnValue((record as any)[column]));
    }

    private normalizeColumnValue(value: unknown): unknown {
        if (value === undefined) {
            return null;
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        // Convert boolean to INTEGER for SQLite storage
        if (typeof value === 'boolean') {
            return value ? 1 : 0;
        }
        return value;
    }
}
