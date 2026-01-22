import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@anfenn/dync/capacitor': path.resolve(__dirname, '../../src/capacitor.ts'),
            '@anfenn/dync/dexie': path.resolve(__dirname, '../../src/dexie.ts'),
            '@anfenn/dync/react': path.resolve(__dirname, '../../src/react/index.ts'),
            '@anfenn/dync/wa-sqlite': path.resolve(__dirname, '../../src/wa-sqlite.ts'),
            '@anfenn/dync': path.resolve(__dirname, '../../src/index.ts'),
        },
    },
    optimizeDeps: {
        exclude: ['@journeyapps/wa-sqlite'],
    },
    server: {
        fs: {
            allow: [path.resolve(__dirname, '../..')],
        },
        headers: {
            // Required for WebAssembly streaming compilation
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
});
