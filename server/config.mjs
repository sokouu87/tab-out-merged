import { readFile } from 'node:fs/promises';

const HEX_32_BYTES = /^[a-f0-9]{64}$/i;
const HEX_16_BYTES = /^[a-f0-9]{32}$/i;
const HEX_64_BYTES = /^[a-f0-9]{128}$/i;

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('配置内容不是有效对象。');
  if (typeof config.username !== 'string' || !config.username.trim()) throw new Error('配置缺少 username。');
  if (!HEX_16_BYTES.test(config.passwordSalt || '')) throw new Error('passwordSalt 格式无效。');
  if (!HEX_64_BYTES.test(config.passwordHash || '')) throw new Error('passwordHash 格式无效。');
  if (!HEX_32_BYTES.test(config.cookieSecret || '')) throw new Error('cookieSecret 格式无效。');
  if (!HEX_32_BYTES.test(config.extensionKey || '')) throw new Error('extensionKey 格式无效。');
  return config;
}

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf8');
  return validateConfig(JSON.parse(raw));
}
