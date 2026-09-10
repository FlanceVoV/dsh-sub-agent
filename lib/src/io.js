/**
 * 文件与路径工具。
 *
 * `resolveDataDir` 刻意与 token-helper 保持同一套约定（宿主 dshHomePath → DSH_HOME →
 * 用户家目录下的 `.dsh`），这样本插件的数据目录和其它插件并排、可预期、可搬运。
 *
 * @module dsh-subagent-hub/io
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 解析本插件的数据目录（不保证存在，调用方按需 mkdir）。
 * @param {{get?:Function}|undefined} ctx - cordis 上下文（可缺省）。
 * @param {string} [dirName] - 数据目录名。
 * @returns {string} 绝对路径。
 */
export function resolveDataDir(ctx, dirName = 'subagent-hub') {
  const fromService = typeof ctx?.get === 'function' ? ctx.get('dshHomePath') : undefined;
  if (typeof fromService === 'function') {
    try {
      return fromService(dirName);
    } catch {
      /* 继续走下面的兜底 */
    }
  }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, dirName);
}

/**
 * 确保目录存在。
 * @param {string} dir - 目标目录。
 * @returns {string} 同一路径，便于链式使用。
 */
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 读 JSON 文件；不存在或损坏时返回 undefined，不抛错。
 *
 * 「损坏也当不存在」是刻意的：配置文件的正确姿势是「读不到就用默认值」，
 * 而不是让插件因为一行坏 JSON 起不来。
 *
 * @param {string} path - 文件路径。
 * @returns {unknown|undefined}
 */
export function readJsonIfExists(path) {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename，避免中途失败留下半截文件。
 * @param {string} path - 目标路径。
 * @param {unknown} value - 任意可 JSON 序列化的值。
 * @returns {void}
 */
export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
