import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY_SNAPSHOT = Object.freeze({
  tabs: [],
  saved: [],
  ts: null,
  lastSyncTs: null,
});

async function readJsonOrDefault(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`无法读取 ${filePath}: ${error.message}`);
  }
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, json, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

export class PersistentStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.snapshotPath = path.join(dataDir, 'snapshot.json');
    this.commandsPath = path.join(dataDir, 'commands.json');
    this.snapshot = structuredClone(EMPTY_SNAPSHOT);
    this.commands = [];
    this.waiters = new Set();
    this.mutation = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    const [snapshot, commands] = await Promise.all([
      readJsonOrDefault(this.snapshotPath, EMPTY_SNAPSHOT),
      readJsonOrDefault(this.commandsPath, []),
    ]);
    this.snapshot = {
      ...structuredClone(EMPTY_SNAPSHOT),
      ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
      tabs: Array.isArray(snapshot?.tabs) ? snapshot.tabs : [],
      saved: Array.isArray(snapshot?.saved) ? snapshot.saved : [],
    };
    this.commands = Array.isArray(commands) ? commands : [];
  }

  runMutation(callback) {
    const result = this.mutation.then(callback, callback);
    this.mutation = result.catch(() => {});
    return result;
  }

  async replaceSnapshot({ tabs, saved, ts }, receivedAt = Date.now()) {
    return this.runMutation(async () => {
      const next = { tabs, saved, ts, lastSyncTs: receivedAt };
      await atomicWriteJson(this.snapshotPath, next);
      this.snapshot = next;
      return structuredClone(next);
    });
  }

  async enqueueCommand(type, tabId, createdAt = Date.now()) {
    return this.runMutation(async () => {
      const command = { id: randomUUID(), type, tabId, createdAt };
      const next = [...this.commands, command];
      await atomicWriteJson(this.commandsPath, next);
      this.commands = next;
      for (const wake of this.waiters) wake();
      return structuredClone(command);
    });
  }

  async acknowledgeCommands(ids) {
    const idSet = new Set(ids);
    return this.runMutation(async () => {
      const next = this.commands.filter(command => !idSet.has(command.id));
      await atomicWriteJson(this.commandsPath, next);
      this.commands = next;
      return next.length;
    });
  }

  getCommands() {
    return structuredClone(this.commands);
  }

  getState(now = Date.now()) {
    const lastSyncTs = Number(this.snapshot.lastSyncTs) || null;
    return {
      tabs: structuredClone(this.snapshot.tabs),
      saved: structuredClone(this.snapshot.saved),
      lastSyncTs,
      online: lastSyncTs !== null && now - lastSyncTs >= 0 && now - lastSyncTs < 90_000,
      pendingCount: this.commands.length,
    };
  }

  waitForCommands(timeoutMs, signal) {
    if (this.commands.length > 0 || timeoutMs <= 0) return Promise.resolve(this.getCommands());

    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(this.getCommands());
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}
