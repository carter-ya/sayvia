import type { Locator } from '@playwright/test';
export async function chooseLanguage(field: Locator, code: string) {
  await field.fill(code);
  await field.press('Enter');
}
