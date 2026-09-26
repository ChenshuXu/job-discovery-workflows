import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT_REAL = realpathSync(PROJECT_ROOT);
const ADAPTER_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const DEFAULT_REGISTRY_PATH = path.join(PROJECT_ROOT, 'config/discovery-adapters.v1.json');

const digest = content => createHash('sha256').update(content).digest('hex');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function readJson(file, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`${label} cannot be read: ${file}: ${error.message}`); }
  try { return { value: JSON.parse(text), text }; }
  catch (error) { throw new Error(`${label} is not valid JSON: ${file}: ${error.message}`); }
}

function projectFile(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error(`${label} must be a project-relative path`);
  const resolved = path.resolve(PROJECT_ROOT, value);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes the project root`);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${value}`);
  const realRelative = path.relative(PROJECT_ROOT_REAL, realpathSync(resolved));
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`${label} escapes the project root`);
  return resolved;
}

function validateCommand(value, label) {
  if (!Array.isArray(value) || !value.length || value.some(part => typeof part !== 'string' || !part || part.includes('\0'))) {
    throw new Error(`${label} must be a non-empty argv array`);
  }
}

function sourceConfigHash(file, label) {
  const { value, text } = readJson(file, label);
  if (!Number.isInteger(value.schema_version) || value.schema_version < 1) throw new Error(`${label} must define schema_version`);
  if (!Number.isInteger(value.max_post_age_hours) || value.max_post_age_hours < 1) throw new Error(`${label} must define a positive max_post_age_hours`);
  return digest(text);
}

export function loadAdapterRegistry(file = process.env.JOB_DISCOVERY_ADAPTER_REGISTRY || DEFAULT_REGISTRY_PATH) {
  const resolved = path.resolve(file);
  const { value: registry, text } = readJson(resolved, 'adapter registry');
  if (registry.schema_version !== 1 || String(registry.registry_version) !== '1') throw new Error(`unsupported adapter registry schema/version: ${resolved}`);
  if (registry.contract_version !== 2 || registry.identity_schema !== 'posting-key-v1') throw new Error('daily adapter registry must use posting-key-v1 contract v2');
  if (!isObject(registry.adapters) || !Object.keys(registry.adapters).length) throw new Error(`adapter registry must define adapters: ${resolved}`);

  const profileId = registry.profile_id ?? 'daily';
  const strictDaily = profileId === 'daily';
  const adapters = {};
  for (const [adapterId, definition] of Object.entries(registry.adapters)) {
    if (!ADAPTER_ID.test(adapterId)) throw new Error(`invalid adapter id: ${adapterId}`);
    if (!isObject(definition)) throw new Error(`${adapterId} adapter definition must be an object`);
    if ('enabled' in definition && typeof definition.enabled !== 'boolean') throw new Error(`${adapterId}.enabled must be boolean`);
    if (strictDaily && !('enabled' in definition)) throw new Error(`${adapterId}.enabled is required in the daily registry`);
    if (strictDaily || 'command' in definition) validateCommand(definition.command, `${adapterId}.command`);
    if (typeof definition.employer_exclusions !== 'boolean') throw new Error(`${adapterId}.employer_exclusions must be boolean`);

    let configFile;
    let configSha256;
    if (strictDaily && !('config' in definition)) throw new Error(`${adapterId}.config is required in the daily registry`);
    if ('config' in definition && definition.enabled !== false) {
      configFile = projectFile(definition.config, `${adapterId}.config`);
      configSha256 = sourceConfigHash(configFile, `${adapterId} config`);
    }
    adapters[adapterId] = {
      ...definition,
      enabled: definition.enabled ?? true,
      ...(configFile ? { config_file: configFile, config_sha256: configSha256 } : {}),
    };
  }

  const enabled = Object.values(adapters).filter(adapter => adapter.enabled).length;
  if (!enabled) throw new Error('adapter registry must enable at least one adapter');
  if (!Number.isInteger(registry.minimum_successful_adapters) || registry.minimum_successful_adapters < 1
      || registry.minimum_successful_adapters > enabled) {
    throw new Error(`adapter registry minimum_successful_adapters must be between 1 and enabled adapter count (${enabled})`);
  }
  return { ...registry, profile_id: profileId, adapters, file: resolved, sha256: digest(text) };
}

export function snapshotAdapterProfile(registryFile) {
  const registry = loadAdapterRegistry(registryFile);
  const adapterDefinitions = {};
  for (const [adapterId, definition] of Object.entries(registry.adapters)) {
    if (!definition.enabled) continue;
    adapterDefinitions[adapterId] = {
      ...('command' in definition ? { command: [...definition.command] } : {}),
      ...('config' in definition ? { config: definition.config, config_sha256: definition.config_sha256 } : {}),
      employer_exclusions: definition.employer_exclusions,
    };
  }
  return {
    schema_version: 1,
    profile_id: registry.profile_id,
    registry_sha256: registry.sha256,
    minimum_successful_adapters: registry.minimum_successful_adapters,
    adapters: Object.keys(adapterDefinitions),
    adapter_definitions: adapterDefinitions,
  };
}

function validateProfile(profile, label, verifyConfigs = false) {
  if (!isObject(profile) || profile.schema_version !== 1 || typeof profile.profile_id !== 'string' || !profile.profile_id) throw new Error(`${label} is invalid`);
  if (!SHA256.test(String(profile.registry_sha256 ?? ''))) throw new Error(`${label}.registry_sha256 is invalid`);
  if (!Array.isArray(profile.adapters) || !profile.adapters.length || !isObject(profile.adapter_definitions)) throw new Error(`${label} must contain enabled adapters`);
  if (new Set(profile.adapters).size !== profile.adapters.length
      || profile.adapters.some(adapterId => !ADAPTER_ID.test(String(adapterId)) || !(adapterId in profile.adapter_definitions))
      || Object.keys(profile.adapter_definitions).some(adapterId => !profile.adapters.includes(adapterId))) {
    throw new Error(`${label} adapter set is invalid`);
  }
  for (const adapterId of profile.adapters) {
    const definition = profile.adapter_definitions[adapterId];
    if (!isObject(definition) || typeof definition.employer_exclusions !== 'boolean') throw new Error(`${label}.${adapterId} is invalid`);
    if ('command' in definition) validateCommand(definition.command, `${label}.${adapterId}.command`);
    if ('config' in definition && (typeof definition.config !== 'string' || !definition.config || path.isAbsolute(definition.config))) {
      throw new Error(`${label}.${adapterId}.config must be a project-relative path`);
    }
    if ('config' in definition && !SHA256.test(String(definition.config_sha256 ?? ''))) throw new Error(`${label}.${adapterId}.config_sha256 is invalid`);
    if (profile.profile_id === 'daily' && (!definition.command || !definition.config)) throw new Error(`${label}.${adapterId} lacks its frozen command/config`);
    if (verifyConfigs && definition.config) {
      const configFile = projectFile(definition.config, `${label}.${adapterId}.config`);
      if (sourceConfigHash(configFile, `${label}.${adapterId} config`) !== definition.config_sha256) {
        throw new Error(`${label}.${adapterId} config hash changed after baseline capture`);
      }
    }
  }
  if (!Number.isInteger(profile.minimum_successful_adapters) || profile.minimum_successful_adapters < 1
      || profile.minimum_successful_adapters > profile.adapters.length) throw new Error(`${label}.minimum_successful_adapters is invalid`);
  return structuredClone(profile);
}

export function loadRunProfile(runRoot, options = {}) {
  if (runRoot) {
    const baselineFile = path.join(path.resolve(runRoot), 'baseline.json');
    if (existsSync(baselineFile)) {
      const { value: baseline } = readJson(baselineFile, 'run baseline');
      if (baseline.adapter_profile) return validateProfile(baseline.adapter_profile, 'baseline.adapter_profile', true);
      if (Number(baseline.schema_version) >= 3) throw new Error('baseline.adapter_profile is required');
    }
  }
  return validateProfile(snapshotAdapterProfile(options.registryFile), 'adapter profile');
}
