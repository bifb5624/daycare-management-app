import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ★ 最小化しても関数・クラス名を残す。 本番のエラースタック(uZ等)を読める名前にして原因特定を容易にする。
  esbuild: { keepNames: true },
  build: {
    chunkSizeWarningLimit: 5000,
    minify: 'esbuild',
  },
});
