import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main.ts', 'src/checkpoint-store.ts', 'src/stores/valkey-checkpoint-store.ts'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
