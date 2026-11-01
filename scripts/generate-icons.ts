import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// Local SVG rasterization only. This utility never loads websites or credentials.
const svg = await readFile(resolve('public/icons/sayvia.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const encoded = await page.evaluate(
      async ({ svg, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1]!;
      },
      { svg, size },
    );
    await writeFile(resolve(`public/icons/icon-${size}.png`), Buffer.from(encoded, 'base64'));
  }
} finally {
  await browser.close();
}
