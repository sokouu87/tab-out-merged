import { randomBytes } from 'node:crypto';
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPasswordRecord } from './security.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(serverDir, 'config.json');
const force = process.argv.includes('--force');
// 只换密码，保留 cookieSecret 和 extensionKey——这样改完密码不用回扩展里重填 key，
// 手机上已登录的会话也不会被踢掉。
const changePassword = process.argv.includes('--change-password');
// 配合 --change-password：连 cookieSecret 一起换，让所有设备的登录态立即失效（手机丢了用这个）。
const revokeSessions = process.argv.includes('--revoke-sessions');

async function configExists() {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

async function readHiddenPassword() {
  if (process.env.TAB_OUT_PASSWORD) return process.env.TAB_OUT_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('请通过交互终端输入密码，或临时设置 TAB_OUT_PASSWORD 环境变量。');

  process.stdout.write('请输入远程查看器密码：');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let password = '';
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    const onData = chunk => {
      for (const key of chunk) {
        if (key === '\r' || key === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(password);
          return;
        }
        if (key === '\u0003') {
          cleanup();
          reject(new Error('已取消。'));
          return;
        }
        if (key === '\u007f' || key === '\b') {
          password = password.slice(0, -1);
        } else {
          password += key;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function writeConfigAtomically(config) {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, configPath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

try {
  if (changePassword && force) {
    throw new Error('--change-password 和 --force 不能同时使用：前者保留密钥，后者重新生成全部密钥。');
  }
  if (revokeSessions && !changePassword) {
    throw new Error('--revoke-sessions 需要配合 --change-password 使用。');
  }

  if (changePassword) {
    if (!await configExists()) {
      throw new Error('server/config.json 不存在，请先跑一次不带参数的 setup 生成配置。');
    }
    const existing = JSON.parse(await readFile(configPath, 'utf8'));
    if (!existing.extensionKey || !existing.cookieSecret) {
      throw new Error('现有配置缺少 extensionKey 或 cookieSecret，请改用 --force 重新生成。');
    }

    const password = await readHiddenPassword();
    if (!password) throw new Error('密码不能为空。');

    await writeConfigAtomically({
      ...existing,
      ...await createPasswordRecord(password),
      ...(revokeSessions ? { cookieSecret: randomBytes(32).toString('hex') } : {}),
    });

    console.log('密码已更新。');
    console.log('extensionKey 未变动，扩展里不需要重新填写。');
    console.log(revokeSessions
      ? 'cookieSecret 已重置：所有设备上的登录态立即失效，需要重新登录。'
      : '已登录的设备不受影响；要把它们全部踢下线，请加 --revoke-sessions 重跑。');
  } else {
    if (!force && await configExists()) {
      throw new Error('server/config.json 已存在。只改密码用 --change-password；要重新生成全部密钥用 --force。');
    }
    const password = await readHiddenPassword();
    if (!password) throw new Error('密码不能为空。');

    const config = {
      username: 'sokouu',
      ...await createPasswordRecord(password),
      cookieSecret: randomBytes(32).toString('hex'),
      extensionKey: randomBytes(32).toString('hex'),
    };
    await writeConfigAtomically(config);

    console.log('配置已写入 server/config.json。');
    console.log(`extensionKey: ${config.extensionKey}`);
    if (force) console.log('注意：extensionKey 已变更，请到扩展设置里重新填写。');
  }
} catch (error) {
  console.error(`配置生成失败：${error.message}`);
  process.exitCode = 1;
}
