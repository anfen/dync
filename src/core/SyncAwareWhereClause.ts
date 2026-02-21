import type { StorageCollection, StorageTable, StorageWhereClause } from '../storage/types';
import { SyncAwareCollection } from './SyncAwareCollection';

/**
 * Wraps a StorageWhereClause so that every collection it produces is a
 * SyncAwareCollection.
 */
export class SyncAwareWhereClause<T> implements StorageWhereClause<T> {
    constructor(
        private readonly inner: StorageWhereClause<T>,
        private readonly tableRef: StorageTable<any>,
    ) {}

    private wrap(col: StorageCollection<T>): SyncAwareCollection<T> {
        return new SyncAwareCollection(col, this.tableRef);
    }

    equals(value: any) {
        return this.wrap(this.inner.equals(value));
    }
    above(value: any) {
        return this.wrap(this.inner.above(value));
    }
    aboveOrEqual(value: any) {
        return this.wrap(this.inner.aboveOrEqual(value));
    }
    below(value: any) {
        return this.wrap(this.inner.below(value));
    }
    belowOrEqual(value: any) {
        return this.wrap(this.inner.belowOrEqual(value));
    }
    between(lower: any, upper: any, includeLower?: boolean, includeUpper?: boolean) {
        return this.wrap(this.inner.between(lower, upper, includeLower, includeUpper));
    }
    inAnyRange(ranges: Array<[any, any]>, options?: { includeLower?: boolean; includeUpper?: boolean }) {
        return this.wrap(this.inner.inAnyRange(ranges, options));
    }
    startsWith(prefix: string) {
        return this.wrap(this.inner.startsWith(prefix));
    }
    startsWithIgnoreCase(prefix: string) {
        return this.wrap(this.inner.startsWithIgnoreCase(prefix));
    }
    startsWithAnyOf(...args: any[]) {
        return this.wrap((this.inner.startsWithAnyOf as any)(...args));
    }
    startsWithAnyOfIgnoreCase(...args: any[]) {
        return this.wrap((this.inner.startsWithAnyOfIgnoreCase as any)(...args));
    }
    equalsIgnoreCase(value: string) {
        return this.wrap(this.inner.equalsIgnoreCase(value));
    }
    anyOf(...args: any[]) {
        return this.wrap((this.inner.anyOf as any)(...args));
    }
    anyOfIgnoreCase(...args: any[]) {
        return this.wrap((this.inner.anyOfIgnoreCase as any)(...args));
    }
    noneOf(...args: any[]) {
        return this.wrap((this.inner.noneOf as any)(...args));
    }
    notEqual(value: any) {
        return this.wrap(this.inner.notEqual(value));
    }
}
