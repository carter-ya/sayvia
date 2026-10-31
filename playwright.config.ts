import { defineConfig } from '@playwright/test';
import { browserLaunchOptions } from './tests/fixtures/browser-options';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: { headless: true, launchOptions: browserLaunchOptions() },
});
