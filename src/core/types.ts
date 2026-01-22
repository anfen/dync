import type { StorageTable, TransactionMode } from '../storage/types';

export type WithTransaction = <T>(mode: TransactionMode, tableNames: string[], fn: (tables: Record<string, StorageTable<any>>) => Promise<T>) => Promise<T>;
