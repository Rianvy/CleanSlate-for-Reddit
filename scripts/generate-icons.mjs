import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = resolve(root, 'public', 'icon.svg');

await mkdir(resolve(root, 'public'), { recursive: true });
await Promise.all(
  [16, 32, 48, 128].map((size) =>
    sharp(source)
      .resize(size, size)
      .png()
      .toFile(resolve(root, 'public', `icon-${size}.png`)),
  ),
);
