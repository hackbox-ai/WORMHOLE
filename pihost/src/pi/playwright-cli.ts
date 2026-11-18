import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

export async function ensurePlaywrightCliConfig(cwd: string): Promise<boolean> {
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath)) return false;
  const configPath = path.join(cwd, '.playwright', 'cli.config.json');
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o755 });
  const config = { browser: { browserName: 'chromium', launchOptions: {
    executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  } } };
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return true;
}
