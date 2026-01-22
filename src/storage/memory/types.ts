export interface MemoryRecord {
    _localId?: string;
    id?: unknown;
    updated_at?: string;
    [key: string]: unknown;
}

export interface MemoryCollectionState<T extends MemoryRecord> {
    predicate: (record: T, key: string) => boolean;
    orderBy?: { index: string | string[]; direction: 'asc' | 'desc' };
    reverse: boolean;
    offset: number;
    limit?: number;
    distinct: boolean;
}

export const createDefaultState = <T extends MemoryRecord>(): MemoryCollectionState<T> => ({
    predicate: () => true,
    orderBy: undefined,
    reverse: false,
    offset: 0,
    limit: undefined,
    distinct: false,
});
