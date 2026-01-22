import type { StorageWhereClause, StorageCollection } from '../types';
import type { SQLiteCondition } from './types';
import { SQLiteTable } from './SQLiteTable';
import { SQLiteCollection } from './SQLiteCollection';

export class SQLiteWhereClause<T = any> implements StorageWhereClause<T> {
    private readonly table: SQLiteTable<T>;
    private readonly index: string | string[];
    private readonly baseCollection?: SQLiteCollection<T>;

    constructor(table: SQLiteTable<T>, index: string | string[], baseCollection?: SQLiteCollection<T>) {
        this.table = table;
        this.index = index;
        this.baseCollection = baseCollection;
    }

    private getColumn(): string {
        // For compound indexes, we only support the first column in SQL conditions
        // Complex compound index queries fall back to JS
        if (Array.isArray(this.index)) {
            return this.index[0]!;
        }
        return this.index;
    }

    private isCompoundIndex(): boolean {
        return Array.isArray(this.index) && this.index.length > 1;
    }

    private getCompoundColumns(): string[] {
        return Array.isArray(this.index) ? this.index : [this.index];
    }

    private getCompoundValues(value: unknown): unknown[] {
        // For compound indexes, value should be an array of values matching each column
        if (Array.isArray(value)) {
            return value;
        }
        // Single value for single-column index
        return [value];
    }

    private createCollectionWithCondition(condition: SQLiteCondition): SQLiteCollection<T> {
        const base = this.baseCollection ?? this.table.createCollection();
        return base.addSqlCondition(condition);
    }

    private createCollectionWithJsPredicate(predicate: (record: T) => boolean): SQLiteCollection<T> {
        const base = this.baseCollection ?? this.table.createCollection();
        return base.jsFilter(predicate) as SQLiteCollection<T>;
    }

    private getIndexValue(record: T): unknown {
        return this.table.getIndexValue(record, this.index);
    }

    private flattenArgs<TValue>(args: any[]): TValue[] {
        if (args.length === 1 && Array.isArray(args[0])) {
            return args[0] as TValue[];
        }
        return args as TValue[];
    }

    equals(value: any): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            // Use native SQL: WHERE col1 = ? AND col2 = ? AND ...
            const columns = this.getCompoundColumns();
            const values = this.getCompoundValues(value);
            return this.createCollectionWithCondition({
                type: 'compoundEquals',
                columns,
                values,
            });
        }
        return this.createCollectionWithCondition({
            type: 'equals',
            column: this.getColumn(),
            value,
        });
    }

    above(value: any): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => this.table.compareValues(this.getIndexValue(record), value) > 0);
        }
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.getColumn(),
            op: '>',
            value,
        });
    }

    aboveOrEqual(value: any): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => this.table.compareValues(this.getIndexValue(record), value) >= 0);
        }
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.getColumn(),
            op: '>=',
            value,
        });
    }

    below(value: any): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => this.table.compareValues(this.getIndexValue(record), value) < 0);
        }
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.getColumn(),
            op: '<',
            value,
        });
    }

    belowOrEqual(value: any): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => this.table.compareValues(this.getIndexValue(record), value) <= 0);
        }
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.getColumn(),
            op: '<=',
            value,
        });
    }

    between(lower: any, upper: any, includeLower = true, includeUpper = false): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => {
                const value = this.getIndexValue(record);
                const lowerCmp = this.table.compareValues(value, lower);
                const upperCmp = this.table.compareValues(value, upper);
                const lowerPass = includeLower ? lowerCmp >= 0 : lowerCmp > 0;
                const upperPass = includeUpper ? upperCmp <= 0 : upperCmp < 0;
                return lowerPass && upperPass;
            });
        }
        return this.createCollectionWithCondition({
            type: 'between',
            column: this.getColumn(),
            lower,
            upper,
            includeLower,
            includeUpper,
        });
    }

    inAnyRange(ranges: Array<[any, any]>, options?: { includeLower?: boolean; includeUpper?: boolean }): StorageCollection<T> {
        // inAnyRange with multiple ranges uses OR logic - can be expressed in SQL
        if (this.isCompoundIndex() || ranges.length === 0) {
            return this.createCollectionWithJsPredicate((record) => {
                const value = this.getIndexValue(record);
                return ranges.some(([lower, upper]) => {
                    const lowerCmp = this.table.compareValues(value, lower);
                    const upperCmp = this.table.compareValues(value, upper);
                    const lowerPass = options?.includeLower !== false ? lowerCmp >= 0 : lowerCmp > 0;
                    const upperPass = options?.includeUpper ? upperCmp <= 0 : upperCmp < 0;
                    return lowerPass && upperPass;
                });
            });
        }

        const column = this.getColumn();
        const orConditions: SQLiteCondition[] = ranges.map(([lower, upper]) => ({
            type: 'between' as const,
            column,
            lower,
            upper,
            includeLower: options?.includeLower !== false,
            includeUpper: options?.includeUpper ?? false,
        }));

        return this.createCollectionWithCondition({
            type: 'or',
            conditions: orConditions,
        });
    }

    startsWith(prefix: string): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => String(this.getIndexValue(record) ?? '').startsWith(prefix));
        }
        // SQLite LIKE pattern: 'prefix%' matches strings starting with prefix
        // Escape special LIKE characters in the prefix
        const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
        return this.createCollectionWithCondition({
            type: 'like',
            column: this.getColumn(),
            pattern: `${escapedPrefix}%`,
        });
    }

    startsWithIgnoreCase(prefix: string): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) =>
                String(this.getIndexValue(record) ?? '')
                    .toLowerCase()
                    .startsWith(prefix.toLowerCase()),
            );
        }
        const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
        return this.createCollectionWithCondition({
            type: 'like',
            column: this.getColumn(),
            pattern: `${escapedPrefix}%`,
            caseInsensitive: true,
        });
    }

    startsWithAnyOf(...args: any[]): StorageCollection<T> {
        const prefixes = this.flattenArgs<string>(args);
        if (this.isCompoundIndex() || prefixes.length === 0) {
            return this.createCollectionWithJsPredicate((record) => {
                const value = String(this.getIndexValue(record) ?? '');
                return prefixes.some((prefix) => value.startsWith(prefix));
            });
        }

        const column = this.getColumn();
        const orConditions: SQLiteCondition[] = prefixes.map((prefix) => {
            const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
            return {
                type: 'like' as const,
                column,
                pattern: `${escapedPrefix}%`,
            };
        });

        return this.createCollectionWithCondition({
            type: 'or',
            conditions: orConditions,
        });
    }

    startsWithAnyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const prefixes = this.flattenArgs<string>(args);
        if (this.isCompoundIndex() || prefixes.length === 0) {
            const lowerPrefixes = prefixes.map((p) => p.toLowerCase());
            return this.createCollectionWithJsPredicate((record) => {
                const value = String(this.getIndexValue(record) ?? '').toLowerCase();
                return lowerPrefixes.some((prefix) => value.startsWith(prefix));
            });
        }

        const column = this.getColumn();
        const orConditions: SQLiteCondition[] = prefixes.map((prefix) => {
            const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
            return {
                type: 'like' as const,
                column,
                pattern: `${escapedPrefix}%`,
                caseInsensitive: true,
            };
        });

        return this.createCollectionWithCondition({
            type: 'or',
            conditions: orConditions,
        });
    }

    equalsIgnoreCase(value: string): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => String(this.getIndexValue(record) ?? '').toLowerCase() === value.toLowerCase());
        }
        return this.createCollectionWithCondition({
            type: 'equals',
            column: this.getColumn(),
            value,
            caseInsensitive: true,
        });
    }

    anyOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        if (this.isCompoundIndex()) {
            // Use native SQL: (col1 = ? AND col2 = ?) OR (col1 = ? AND col2 = ?) OR ...
            const columns = this.getCompoundColumns();
            const orConditions: SQLiteCondition[] = values.map((value) => ({
                type: 'compoundEquals' as const,
                columns,
                values: this.getCompoundValues(value),
            }));
            return this.createCollectionWithCondition({
                type: 'or',
                conditions: orConditions,
            });
        }
        return this.createCollectionWithCondition({
            type: 'in',
            column: this.getColumn(),
            values,
        });
    }

    anyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<string>(args);
        if (this.isCompoundIndex()) {
            const lowerValues = values.map((v) => v.toLowerCase());
            return this.createCollectionWithJsPredicate((record) => {
                const value = String(this.getIndexValue(record) ?? '').toLowerCase();
                return lowerValues.includes(value);
            });
        }
        return this.createCollectionWithCondition({
            type: 'in',
            column: this.getColumn(),
            values,
            caseInsensitive: true,
        });
    }

    noneOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) =>
                values.every((candidate) => this.table.compareValues(this.getIndexValue(record), candidate) !== 0),
            );
        }
        return this.createCollectionWithCondition({
            type: 'notIn',
            column: this.getColumn(),
            values,
        });
    }

    notEqual(value: any): StorageCollection<T> {
        if (this.isCompoundIndex()) {
            return this.createCollectionWithJsPredicate((record) => this.table.compareValues(this.getIndexValue(record), value) !== 0);
        }
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.getColumn(),
            op: '!=',
            value,
        });
    }
}
