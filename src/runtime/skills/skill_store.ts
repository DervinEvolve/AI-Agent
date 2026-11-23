import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import {
  SkillRecord,
  SkillConfig,
  SkillStoreFs,
  SkillManifestEntry,
  canonicalizeJson,
  sha256Hex,
  caps as defaultCaps,
} from './types.js';

const defaultFs: SkillStoreFs = {
  async readFile(p, enc) {
    return await fsPromises.readFile(p, { encoding: enc });
  },
  async writeFile(p, data, enc) {
    await fsPromises.writeFile(p, data, { encoding: enc });
  },
  async rename(oldPath, newPath) {
    await fsPromises.rename(oldPath, newPath);
  },
  async mkdir(p, opts) {
    await fsPromises.mkdir(p, opts);
  },
  async readdir(p) {
    return await fsPromises.readdir(p);
  },
  async exists(p) {
    try {
      await fsPromises.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

export class SkillStore {
  private readonly principal: string;
  private readonly storeDir: string;
  private readonly fs: SkillStoreFs;
  private readonly principalDir: string;
  private readonly recordsDir: string;
  private readonly sidecarPath: string;

  constructor(config: Pick<SkillConfig, 'principal' | 'storeDir' | 'fs'>) {
    this.principal = config.principal;
    this.storeDir = config.storeDir;
    this.fs = config.fs ?? defaultFs;
    this.principalDir = path.join(this.storeDir, 'principals', this.principal);
    this.recordsDir = path.join(this.principalDir, 'skills');
    this.sidecarPath = path.join(this.principalDir, 'telemetry.json');
  }

  async init(): Promise<void> {
    await this.fs.mkdir(this.recordsDir, { recursive: true });
  }

  async getLatestVersion(name: string): Promise<number> {
    const skills = await this.listRecords();
    const matching = skills.filter((s) => s.name === name);
    if (matching.length === 0) return 0;
    return Math.max(...matching.map((s) => s.version));
  }

  async saveRecord(record: SkillRecord): Promise<void> {
    await this.init();
    const canonical = canonicalizeJson(record);
    const fileName = `${record.name}.v${record.version}.json`;
    const targetPath = path.join(this.recordsDir, fileName);
    const tempPath = path.join(this.recordsDir, `${fileName}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

    await this.fs.writeFile(tempPath, canonical, 'utf-8');
    await this.fs.rename(tempPath, targetPath);
  }

  async listRecords(): Promise<SkillRecord[]> {
    if (!(await this.fs.exists(this.recordsDir))) {
      return [];
    }
    const files = await this.fs.readdir(this.recordsDir);
    const records: SkillRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp')) continue;
      try {
        const content = await this.fs.readFile(path.join(this.recordsDir, file), 'utf-8');
        const parsed = JSON.parse(content) as SkillRecord;
        records.push(parsed);
      } catch {
        // ignore corrupted/unparseable files
      }
    }
    return records.sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  async getRecord(name: string, version: number): Promise<SkillRecord | null> {
    const fileName = `${name}.v${version}.json`;
    const targetPath = path.join(this.recordsDir, fileName);
    if (!(await this.fs.exists(targetPath))) {
      return null;
    }
    try {
      const content = await this.fs.readFile(targetPath, 'utf-8');
      return JSON.parse(content) as SkillRecord;
    } catch {
      return null;
    }
  }

  async buildManifest(
    activation: SkillConfig['activation'],
    caps: typeof defaultCaps
  ): Promise<{ manifest: SkillManifestEntry[]; totalBytes: number }> {
    if (!activation || (Array.isArray(activation) && activation.length === 0)) {
      return { manifest: [], totalBytes: 0 };
    }

    const records = await this.listRecords();
    const manifest: SkillManifestEntry[] = [];
    let totalBytes = 0;

    if (activation === 'latest_authorized') {
      const latestByName = new Map<string, SkillRecord>();
      for (const rec of records) {
        const existing = latestByName.get(rec.name);
        if (!existing || rec.version > existing.version) {
          latestByName.set(rec.name, rec);
        }
      }
      for (const rec of latestByName.values()) {
        manifest.push({
          name: rec.name,
          skill_id: rec.skill_id,
          version: rec.version,
          code_sha256: rec.code_sha256,
          schema_sha256: rec.schema_sha256,
        });
        totalBytes += Buffer.byteLength(rec.description, 'utf-8') + Buffer.byteLength(canonicalizeJson(rec.params_schema), 'utf-8');
      }
    } else {
      for (const pinned of activation) {
        const rec = records.find((r) => r.name === pinned.name && r.version === pinned.version);
        if (!rec) {
          throw new Error(`Skill ${pinned.name} v${pinned.version} not found in store`);
        }
        if (rec.code_sha256 !== pinned.code_sha256) {
          throw new Error(`Digest mismatch for skill ${pinned.name} v${pinned.version}: expected ${pinned.code_sha256}, got ${rec.code_sha256}`);
        }
        // Recompute digest
        const computedCodeSha = sha256Hex(rec.code);
        if (computedCodeSha !== pinned.code_sha256) {
          throw new Error(`Code tampering detected for skill ${pinned.name} v${pinned.version}`);
        }
        manifest.push({
          name: rec.name,
          skill_id: rec.skill_id,
          version: rec.version,
          code_sha256: rec.code_sha256,
          schema_sha256: rec.schema_sha256,
        });
        totalBytes += Buffer.byteLength(rec.description, 'utf-8') + Buffer.byteLength(canonicalizeJson(rec.params_schema), 'utf-8');
      }
    }

    if (manifest.length > caps.hardMaxActiveSkills || manifest.length > caps.maxActiveSkills) {
      throw new Error(`Active skills count (${manifest.length}) exceeds maximum allowed (${caps.maxActiveSkills})`);
    }
    if (totalBytes > caps.maxTotalStubBytes) {
      throw new Error(`Total active skill stub bytes (${totalBytes}) exceeds cap (${caps.maxTotalStubBytes})`);
    }

    return { manifest, totalBytes };
  }

  async recordTelemetry(name: string, success: boolean): Promise<void> {
    try {
      let data: Record<string, { invocations: number; failures: number }> = {};
      if (await this.fs.exists(this.sidecarPath)) {
        const content = await this.fs.readFile(this.sidecarPath, 'utf-8');
        data = JSON.parse(content);
      }
      if (!data[name]) {
        data[name] = { invocations: 0, failures: 0 };
      }
      data[name].invocations += 1;
      if (!success) {
        data[name].failures += 1;
      }
      await this.fs.writeFile(this.sidecarPath, JSON.stringify(data), 'utf-8');
    } catch {
      // best-effort sidecar, ignore failure
    }
  }

  async getTelemetry(): Promise<Record<string, { invocations: number; failures: number }>> {
    try {
      if (await this.fs.exists(this.sidecarPath)) {
        const content = await this.fs.readFile(this.sidecarPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // ignore
    }
    return {};
  }
}
