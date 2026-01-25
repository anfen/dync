import type { StorageWhereClause, StorageCollection } from '../types';
import type { SQLiteCondition } from './types';
import { SQLiteTable } from './SQLiteTable';
import { SQLiteCollection } from './SQLiteCollection';

export class SQLiteWhereClause<T = any> implements StorageWhereClause<T> {
    private readonly table: SQLiteTable<T>;
    private readonly column: string;
    private readonly baseCollection?: SQLiteCollection<T>;

    constructor(table: SQLiteTable<T>, column: string, baseCollection?: SQLiteCollection<T>) {
        this.table = table;
        this.column = column;
        this.baseCollection = baseCollection;
    }

    private createCollectionWithCondition(condition: SQLiteCondition): SQLiteCollection<T> {
        const base = this.baseCollection ?? this.table.createCollection();
        return base.addSqlCondition(condition);
    }

    private flattenArgs<TValue>(args: any[]): TValue[] {
        if (args.length === 1 && Array.isArray(args[0])) {
            return args[0] as TValue[];
        }
        return args as TValue[];
    }

    equals(value: any): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'equals',
            column: this.column,
            value,
        });
    }

    above(value: any): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.column,
            op: '>',
            value,
        });
    }

    aboveOrEqual(value: any): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.column,
            op: '>=',
            value,
        });
    }

    below(value: any): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.column,
            op: '<',
            value,
        });
    }

    belowOrEqual(value: any): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.column,
            op: '<=',
            value,
        });
    }

    between(lower: any, upper: any, includeLower = true, includeUpper = false): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'between',
            column: this.column,
            lower,
            upper,
            includeLower,
            includeUpper,
        });
    }

    inAnyRange(ranges: Array<[any, any]>, options?: { includeLower?: boolean; includeUpper?: boolean }): StorageCollection<T> {
        if (ranges.length === 0) {
            // Empty ranges = no matches
            return this.createCollectionWithCondition({
                type: 'comparison',
                column: this.column,
                op: '=',
                value: null,
            }).jsFilter(() => false) as SQLiteCollection<T>;
        }

        const orConditions: SQLiteCondition[] = ranges.map(([lower, upper]) => ({
            type: 'between' as const,
            column: this.column,
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
        // SQLite LIKE pattern: 'prefix%' matches strings starting with prefix
        // Escape special LIKE characters in the prefix
        const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
        return this.createCollectionWithCondition({
            type: 'like',
            column: this.column,
            pattern: `${escapedPrefix}%`,
        });
    }

    startsWithIgnoreCase(prefix: string): StorageCollection<T> {
        const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
        return this.createCollectionWithCondition({
            type: 'like',
            column: this.column,
            pattern: `${escapedPrefix}%`,
            caseInsensitive: true,
        });
    }

    startsWithAnyOf(...args: any[]): StorageCollection<T> {
        const prefixes = this.flattenArgs<string>(args);
        if (prefixes.length === 0) {
            return this.createCollectionWithCondition({
                type: 'comparison',
                column: this.column,
                op: '=',
                value: null,
            }).jsFilter(() => false) as SQLiteCollection<T>;
        }

        const orConditions: SQLiteCondition[] = prefixes.map((prefix) => {
            const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
            return {
                type: 'like' as const,
                column: this.column,
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
        if (prefixes.length === 0) {
            return this.createCollectionWithCondition({
                type: 'comparison',
                column: this.column,
                op: '=',
                value: null,
            }).jsFilter(() => false) as SQLiteCollection<T>;
        }

        const orConditions: SQLiteCondition[] = prefixes.map((prefix) => {
            const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
            return {
                type: 'like' as const,
                column: this.column,
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
        return this.createCollectionWithCondition({
            type: 'equals',
            column: this.column,
            value,
            caseInsensitive: true,
        });
    }

    anyOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        return this.createCollectionWithCondition({
            type: 'in',
            column: this.column,
            values,
        });
    }

    anyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<string>(args);
        return this.createCollectionWithCondition({
            type: 'in',
            column: this.column,
            values,
            caseInsensitive: true,
        });
    }

    noneOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        return this.createCollectionWithCondition({
            type: 'notIn',
            column: this.column,
            values,
        });
    }

    notEqual(value: any): StorageCollection<T> {
        return this.createCollectionWithCondition({
            type: 'comparison',
            column: this.column,
            op: '!=',
            value,
        });
    }
}
