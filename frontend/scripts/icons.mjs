import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  await sharp(new URL('../public/icon.svg', import.meta.url).pathname)
    .resize(size, size).png().toFile(new URL(`../public/icons/icon-${size}.png`, import.meta.url).pathname);
}
await sharp(new URL('../public/icon.svg', import.meta.url).pathname)
  .resize(384, 384).extend({ top: 64, bottom: 64, left: 64, right: 64, background: '#101211' })
  .png().toFile(new URL('../public/icons/maskable-512.png', import.meta.url).pathname);
