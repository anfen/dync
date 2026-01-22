import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'com.example.capacitor',
    appName: 'react-capacitor',
    webDir: 'dist',
    plugins: {
        CapacitorSQLite: {
            iosDatabaseLocation: 'Library/CapacitorDatabase',
            iosIsEncryption: true,
            iosKeychainPrefix: 'react-capacitor',
            androidIsEncryption: true,
        },
    },
};

export default config;
