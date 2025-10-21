import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        rollupOptions: {
            output: {
                manualChunks: {
                    phaser: ['phaser']
                }
            }
        },
    },
    server: {
        port: 8080,
        proxy: {
            '/api': {
                target: 'http://localhost:4173',
                changeOrigin: true,
                secure: false
            }
        }
    }
});
