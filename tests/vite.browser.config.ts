import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
    root: path.resolve(__dirname, 'browser'),
    resolve: {
        alias: {
            // Ensure we use the source files for development
            '@': path.resolve(__dirname, '../src'),
        },
    },
    optimizeDeps: {
        // Exclude wa-sqlite WASM files from optimization
        exclude: ['@journeyapps/wa-sqlite'],
    },
    build: {
        outDir: path.resolve(__dirname, 'browser-dist'),
        sourcemap: true,
    },
    server: {
        port: 5174,
        strictPort: true,
    },
});
