const path = require('path');
const { getDefaultConfig } = require('@expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Allow Metro to follow pnpm symlinks to the workspace root so packages like @anfenn/dync resolve.
config.watchFolders = [workspaceRoot];
config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(workspaceRoot, 'node_modules'),
  ],
  unstable_enableSymlinks: true,
  // Add WASM support
  assetExts: [...(config.resolver.assetExts || []), 'wasm'],
  sourceExts: [...(config.resolver.sourceExts || [])],
};

module.exports = config;
