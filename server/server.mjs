import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { startTabOutServer } from './app.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(serverDir, 'config.json');
const dataDir = path.join(serverDir, 'data');

try {
  const config = await loadConfig(configPath);
  const { server } = await startTabOutServer({
    config,
    dataDir,
    host: '127.0.0.1',
    port: 8787,
  });
  console.log('Tab Out 远程查看器已监听 http://127.0.0.1:8787');

  const close = signal => {
    console.log(`收到 ${signal}，正在停止服务。`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => close('SIGINT'));
  process.on('SIGTERM', () => close('SIGTERM'));
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error('缺少 server/config.json。请先运行：node server/setup.mjs');
  } else {
    console.error(`Tab Out 服务启动失败：${error.message}`);
  }
  process.exitCode = 1;
}
