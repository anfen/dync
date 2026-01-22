import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/react/index.ts', 'src/expoSqlite.ts', 'src/dexie.ts', 'src/capacitor.ts', 'src/node.ts', 'src/wa-sqlite.ts'],
  sourcemap: true,
  clean: true,
  dts: true,
  format: ['cjs', 'esm'],
  external: ['react', 'expo-sqlite', 'react-native', 'expo-crypto', 'dexie', 'better-sqlite3', 'wa-sqlite'],
});
