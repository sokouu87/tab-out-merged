import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const manifestPath = new URL('../extension/manifest.json', import.meta.url);

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

describe('extension manifest contract', () => {
  test('uses Manifest V3 and replaces the Chrome new tab page', async () => {
    const manifest = await readManifest();

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.chrome_url_overrides).toEqual({ newtab: 'index.html' });
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
  });

  test('keeps stable Chrome permissions for tab cleanup and system memory', async () => {
    const manifest = await readManifest();

    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['tabs', 'activeTab', 'storage', 'system.memory'])
    );
    expect(manifest.permissions).not.toContain('processes');
    expect(manifest.permissions).not.toContain('debugger');
  });
});
