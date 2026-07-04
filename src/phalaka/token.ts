import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export const TOKEN_PATH = resolve(homedir(), '.shreni', 'shreni.token');

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function ensureToken(): string {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
  const token = generateToken();
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, token, 'utf8');
  return token;
}

export function readToken(): string | null {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}