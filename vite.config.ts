import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'mypc-dist-dir-sync',
        apply: 'build',
        closeBundle() {
          const outDir = path.resolve(__dirname, 'dist_dir');
          if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, {recursive: true});
          }
          for (const file of ['mypc-app.json', 'icon.svg', 'CLAUDE.md', '.nojekyll']) {
            const srcPath = path.resolve(__dirname, file);
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, path.join(outDir, file));
            }
          }
          const assetsDir = path.join(outDir, 'assets');
          if (fs.existsSync(assetsDir)) {
            for (const f of fs.readdirSync(assetsDir)) {
              if (f.endsWith('.js') || f.endsWith('.css')) {
                const fullPath = path.join(assetsDir, f);
                const content = fs.readFileSync(fullPath, 'utf8');
                if (!content.startsWith('/* abyssal-evo-asset */')) {
                  fs.writeFileSync(fullPath, `/* abyssal-evo-asset */\n${content}`, 'utf8');
                }
              }
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: 'dist_dir',
      emptyOutDir: true,
      target: 'chrome108',
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          trainer: path.resolve(__dirname, 'trainer.html'),
        },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
