// Type declarations for @journeyapps/wa-sqlite VFS modules
// These extend the base VFS class and add static create methods

declare module '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js' {
    import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';

    export class IDBBatchAtomicVFS extends VFS.Base {
        name: string;

        static create(name: string, module: any, options?: { durability?: string }): Promise<IDBBatchAtomicVFS>;
        close(): Promise<void>;
    }
}

declare module '@journeyapps/wa-sqlite/src/examples/IDBMirrorVFS.js' {
    import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';

    export class IDBMirrorVFS extends VFS.Base {
        name: string;

        static create(name: string, module: any, options?: { durability?: string }): Promise<IDBMirrorVFS>;
        close(): Promise<void>;
    }
}

declare module '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
    import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';

    export class OPFSCoopSyncVFS extends VFS.Base {
        name: string;

        static create(name: string, module: any): Promise<OPFSCoopSyncVFS>;
        close(): Promise<void>;
    }
}

declare module '@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js' {
    import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';

    export class AccessHandlePoolVFS extends VFS.Base {
        name: string;

        static create(name: string, module: any): Promise<AccessHandlePoolVFS>;
        close(): Promise<void>;
    }
}
