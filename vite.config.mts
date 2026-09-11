import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    base: './',
    server: {
      port: 3000,
      host: '0.0.0.0',
      // Electron 的 ELECTRON_START_URL 固定指向 3000（见 package.json 的 electron:dev），
      // 端口被占用时必须直接失败，否则 Vite 会静默换到 3001，而 Electron 仍连 3000 的旧进程
      strictPort: true,
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        // AI 密钥等敏感配置一律由主进程读取 .env，不再注入渲染进程
        '@': path.resolve(import.meta.dirname, 'src'),
      }
    }
});
