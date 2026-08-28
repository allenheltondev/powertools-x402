import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stripe.ts', 'src/coinbase.ts', 'src/testing.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node18',
});
