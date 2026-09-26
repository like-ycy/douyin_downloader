import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../shared/types'
import { getDataDir } from './paths'

export type { Config } from '../shared/types'

const FILE = 'config.json'

function configPath(): string {
  return path.join(getDataDir(), FILE)
}

function defaults(): Config {
  return {
    downloadDir: path.join(os.homedir(), 'Downloads'),
    defaultRatio: 'default',
    loginTimeoutSec: 180,
  }
}

export function loadConfig(): Config {
  const base = defaults()
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'))
    return { ...base, ...raw }
  } catch {
    return base
  }
}

export function saveConfig(patch: Partial<Config>): Config {
  const merged = { ...loadConfig(), ...patch }
  fs.mkdirSync(getDataDir(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}
