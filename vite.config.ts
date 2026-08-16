import { defineConfig, loadEnv } from 'vite';

export const DEFAULT_PORT = 5173;

export function resolvePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT;

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`APP_PORT 必须是 1 到 65535 之间的整数, 当前值: ${value}`);
  }

  const port = Number(normalized);
  if (port < 1 || port > 65535) {
    throw new Error(`APP_PORT 必须是 1 到 65535 之间的整数, 当前值: ${value}`);
  }
  return port;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'APP_');
  const port = resolvePort(env.APP_PORT);

  return {
    server: {
      port,
      strictPort: true,
    },
    preview: {
      port,
      strictPort: true,
    },
    build: {
      // Three.js 核心是不可再拆的单模块。保留跨模块压缩后的更小首屏包，
      // 并把预算设在当前 610 kB 以内，后续业务增长仍会重新触发警告。
      chunkSizeWarningLimit: 610,
    },
  };
});
