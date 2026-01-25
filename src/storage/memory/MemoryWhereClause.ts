import type { StorageCollection, StorageWhereClause } from '../types';
import type { MemoryRecord } from './types';
import type { MemoryTable } from './MemoryTable';
import type { MemoryCollection } from './MemoryCollection';

export class MemoryWhereClause<T extends MemoryRecord = MemoryRecord> implements StorageWhereClause<T> {
    private readonly table: MemoryTable<T>;
    private readonly column: string;
    private readonly baseCollection?: MemoryCollection<T>;

    constructor(table: MemoryTable<T>, column: string, baseCollection?: MemoryCollection<T>) {
        this.table = table;
        this.column = column;
        this.baseCollection = baseCollection;
    }

    equals(value: any): StorageCollection<T> {
        return this.createCollection((current) => this.table.compareValues(current, value) === 0);
    }

    above(value: any): StorageCollection<T> {
        return this.createCollection((current) => this.table.compareValues(current, value) > 0);
    }

    aboveOrEqual(value: any): StorageCollection<T> {
        return this.createCollection((current) => this.table.compareValues(current, value) >= 0);
    }

    below(value: any): StorageCollection<T> {
        return this.createCollection((current) => this.table.compareValues(current, value) < 0);
    }

    belowOrEqual(value: any): StorageCollection<T> {
        return this.createCollection((current) => this.table.compareValues(current, value) <= 0);
    }

    between(lower: any, upper: any, includeLower = true, includeUpper = false): StorageCollection<T> {
        return this.createCollection((current) => {
            const lowerCmp = this.table.compareValues(current, lower);
            const upperCmp = this.table.compareValues(current, upper);
            const lowerOk = includeLower ? lowerCmp >= 0 : lowerCmp > 0;
            const upperOk = includeUpper ? upperCmp <= 0 : upperCmp < 0;
            return lowerOk && upperOk;
        });
    }

    inAnyRange(ranges: Array<[any, any]>, options?: { includeLower?: boolean; includeUpper?: boolean }): StorageCollection<T> {
        const includeLower = options?.includeLower ?? true;
        const includeUpper = options?.includeUpper ?? false;
        return this.createCollection((current) => {
            for (const [lower, upper] of ranges) {
                const lowerCmp = this.table.compareValues(current, lower);
                const upperCmp = this.table.compareValues(current, upper);
                const lowerOk = includeLower ? lowerCmp >= 0 : lowerCmp > 0;
                const upperOk = includeUpper ? upperCmp <= 0 : upperCmp < 0;
                if (lowerOk && upperOk) {
                    return true;
                }
            }
            return false;
        });
    }

    startsWith(prefix: string): StorageCollection<T> {
        return this.createCollection((current) => typeof current === 'string' && current.startsWith(prefix));
    }

    startsWithIgnoreCase(prefix: string): StorageCollection<T> {
        return this.createCollection((current) => typeof current === 'string' && current.toLowerCase().startsWith(prefix.toLowerCase()));
    }

    startsWithAnyOf(...prefixes: string[]): StorageCollection<T>;
    startsWithAnyOf(prefixes: string[]): StorageCollection<T>;
    startsWithAnyOf(...args: any[]): StorageCollection<T> {
        const prefixes = this.flattenArgs<string>(args);
        return this.createCollection((current) => typeof current === 'string' && prefixes.some((prefix) => current.startsWith(prefix)));
    }

    startsWithAnyOfIgnoreCase(...prefixes: string[]): StorageCollection<T>;
    startsWithAnyOfIgnoreCase(prefixes: string[]): StorageCollection<T>;
    startsWithAnyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const prefixes = this.flattenArgs<string>(args).map((prefix) => prefix.toLowerCase());
        return this.createCollection((current) => typeof current === 'string' && prefixes.some((prefix) => current.toLowerCase().startsWith(prefix)));
    }

    equalsIgnoreCase(value: string): StorageCollection<T> {
        return this.createCollection((current) => typeof current === 'string' && current.toLowerCase() === value.toLowerCase());
    }

    anyOf(...values: any[]): StorageCollection<T>;
    anyOf(values: any[]): StorageCollection<T>;
    anyOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        const valueSet = new Set(values.map((entry) => JSON.stringify(entry)));
        return this.createCollection((current) => valueSet.has(JSON.stringify(current)));
    }

    anyOfIgnoreCase(...values: string[]): StorageCollection<T>;
    anyOfIgnoreCase(values: string[]): StorageCollection<T>;
    anyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<string>(args).map((value) => value.toLowerCase());
        const valueSet = new Set(values);
        return this.createCollection((current) => typeof current === 'string' && valueSet.has(current.toLowerCase()));
    }

    noneOf(...values: any[]): StorageCollection<T>;
    noneOf(values: any[]): StorageCollection<T>;
    noneOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        const valueSet = new Set(values.map((entry) => JSON.stringify(entry)));
        return this.createCollection((current) => !valueSet.has(JSON.stringify(current)));
    }

    notEqual(value: any): StorageCollection<T> {
        return this.createCollection((current) => this.table.compareValues(current, value) !== 0);
    }

    private createCollection(predicate: (indexValue: unknown) => boolean): StorageCollection<T> {
        const condition = (record: T, _key: string): boolean => predicate(this.table.getIndexValue(record, this.column));
        if (this.baseCollection) {
            const combined = (record: T, key: string): boolean =>
                this.baseCollection!.matches(record, key) || predicate(this.table.getIndexValue(record, this.column));
            return this.table.createCollectionFromPredicate(combined, this.baseCollection);
        }
        return this.table.createCollectionFromPredicate(condition);
    }

    private flattenArgs<TValue>(args: any[]): TValue[] {
        if (args.length === 1 && Array.isArray(args[0])) {
            return args[0] as TValue[];
        }
        return args as TValue[];
    }
}
