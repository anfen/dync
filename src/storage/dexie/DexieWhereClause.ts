import type { WhereClause } from 'dexie';
import type { StorageCollection, StorageWhereClause } from '../types';
import { DexieCollection } from './DexieCollection';

export class DexieWhereClause<T = any> implements StorageWhereClause<T> {
    private readonly clause: WhereClause<T, any, T>;

    constructor(clause: WhereClause<T, any, T>) {
        this.clause = clause;
    }

    equals(value: any): StorageCollection<T> {
        return new DexieCollection(this.clause.equals(value));
    }

    above(value: any): StorageCollection<T> {
        return new DexieCollection(this.clause.above(value));
    }

    aboveOrEqual(value: any): StorageCollection<T> {
        return new DexieCollection(this.clause.aboveOrEqual(value));
    }

    below(value: any): StorageCollection<T> {
        return new DexieCollection(this.clause.below(value));
    }

    belowOrEqual(value: any): StorageCollection<T> {
        return new DexieCollection(this.clause.belowOrEqual(value));
    }

    between(lower: any, upper: any, includeLower?: boolean, includeUpper?: boolean): StorageCollection<T> {
        return new DexieCollection(this.clause.between(lower, upper, includeLower, includeUpper));
    }

    inAnyRange(ranges: Array<[any, any]>, options?: { includeLower?: boolean; includeUpper?: boolean }): StorageCollection<T> {
        const normalizedOptions = options
            ? {
                  includeLowers: options.includeLower,
                  includeUppers: options.includeUpper,
              }
            : undefined;
        return new DexieCollection(this.clause.inAnyRange(ranges as any, normalizedOptions));
    }

    startsWith(prefix: string): StorageCollection<T> {
        return new DexieCollection(this.clause.startsWith(prefix));
    }

    startsWithIgnoreCase(prefix: string): StorageCollection<T> {
        return new DexieCollection(this.clause.startsWithIgnoreCase(prefix));
    }

    startsWithAnyOf(...prefixes: string[]): StorageCollection<T>;
    startsWithAnyOf(prefixes: string[]): StorageCollection<T>;
    startsWithAnyOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<string>(args);
        return new DexieCollection(this.clause.startsWithAnyOf(...values));
    }

    startsWithAnyOfIgnoreCase(...prefixes: string[]): StorageCollection<T>;
    startsWithAnyOfIgnoreCase(prefixes: string[]): StorageCollection<T>;
    startsWithAnyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<string>(args);
        return new DexieCollection(this.clause.startsWithAnyOfIgnoreCase(...values));
    }

    equalsIgnoreCase(value: string): StorageCollection<T> {
        return new DexieCollection(this.clause.equalsIgnoreCase(value));
    }

    anyOf(...values: any[]): StorageCollection<T>;
    anyOf(values: any[]): StorageCollection<T>;
    anyOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        return new DexieCollection(this.clause.anyOf(...values));
    }

    anyOfIgnoreCase(...values: string[]): StorageCollection<T>;
    anyOfIgnoreCase(values: string[]): StorageCollection<T>;
    anyOfIgnoreCase(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<string>(args);
        return new DexieCollection(this.clause.anyOfIgnoreCase(...values));
    }

    noneOf(...values: any[]): StorageCollection<T>;
    noneOf(values: any[]): StorageCollection<T>;
    noneOf(...args: any[]): StorageCollection<T> {
        const values = this.flattenArgs<any>(args);
        return new DexieCollection(this.clause.noneOf(values as any));
    }

    notEqual(value: any): StorageCollection<T> {
        return new DexieCollection(this.clause.notEqual(value));
    }

    private flattenArgs<TValue>(args: any[]): TValue[] {
        if (args.length === 1 && Array.isArray(args[0])) {
            return args[0] as TValue[];
        }
        return args as TValue[];
    }
}
