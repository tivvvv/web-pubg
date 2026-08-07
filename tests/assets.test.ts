import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_ASSET_URLS,
  FOOTSTEP_ASSET_IDS,
  setSurfaceEnvironment,
  shotAssetId,
  surfaceEnvironmentState,
  SURFACE_ASSET_URLS,
} from '../src/assets';
import { ambienceMix } from '../src/audio';
import type { WeaponId } from '../src/types';

const projectFile = (url: string): string => join(process.cwd(), 'public', url);

describe('美术与音效静态资产', () => {
  it('十一类表面材质均为有效轻量 PNG', () => {
    expect(Object.keys(SURFACE_ASSET_URLS)).toEqual([
      'plaster', 'terrain', 'wood', 'metal', 'fabric', 'stone', 'concrete', 'roof', 'foliage', 'paintedMetal',
      'stonegateBrick',
    ]);
    let total = 0;
    for (const url of Object.values(SURFACE_ASSET_URLS)) {
      const bytes = readFileSync(projectFile(url));
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(bytes.length).toBeLessThan(128 * 1024);
      total += bytes.length;
    }
    expect(total).toBeLessThan(512 * 1024);
  });

  it('建筑和道具材质共享天气湿润参数并限制在有效范围', () => {
    setSurfaceEnvironment(0.82, 0.9, 0.56, 0.76, 0.42);
    expect(surfaceEnvironmentState()).toEqual({
      wetness: 0.82, cloudiness: 0.9, daylight: 0.56, rain: 0.76, warmth: 0.42,
    });
    setSurfaceEnvironment(2, -1, 4, 3, -2);
    expect(surfaceEnvironmentState()).toEqual({
      wetness: 1, cloudiness: 0, daylight: 1, rain: 1, warmth: 0,
    });
    setSurfaceEnvironment(0, 0.18, 1);
  });

  it('关键音效清单与生成清单一致且保持轻量', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'public/assets/audio/manifest.json'), 'utf8'),
    ) as { sampleRate: number; files: { file: string; duration: number; bytes: number }[] };
    const configured = Object.values(AUDIO_ASSET_URLS).map((url) => basename(url)).sort();
    expect(manifest.sampleRate).toBe(22050);
    expect(manifest.files.map((entry) => entry.file).sort()).toEqual(configured);
    let total = 0;
    for (const url of Object.values(AUDIO_ASSET_URLS)) {
      const bytes = readFileSync(projectFile(url));
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
      total += statSync(projectFile(url)).size;
    }
    expect(total).toBeLessThan(1024 * 1024);
  });

  it('所有枪械均映射枪声且消音器统一使用消音采样', () => {
    const weapons: WeaponId[] = ['pistol', 'rifle', 'akm', 'lmg', 'smg', 'dmr', 'sniper', 'shotgun'];
    for (const weapon of weapons) {
      expect(shotAssetId(weapon, false)).toBe(weapon === 'lmg' ? 'shot-rifle' : `shot-${weapon}`);
      expect(shotAssetId(weapon, true)).toBe('shot-suppressed');
    }
  });

  it('入水音效使用柔和起音而不是枪声式瞬态', () => {
    const wav = readFileSync(projectFile(AUDIO_ASSET_URLS['movement-splash']));
    const peak = (startMs: number, endMs: number): number => {
      const start = 44 + Math.floor(startMs * 22.05) * 2;
      const end = Math.min(wav.length, 44 + Math.floor(endMs * 22.05) * 2);
      let value = 0;
      for (let offset = start; offset + 1 < end; offset += 2) {
        value = Math.max(value, Math.abs(wav.readInt16LE(offset)));
      }
      return value;
    };
    expect(peak(0, 5)).toBeLessThan(peak(35, 90) * 0.45);
  });

  it('六种落脚表面均提供两个独立声音变体', () => {
    expect(Object.keys(FOOTSTEP_ASSET_IDS)).toEqual([
      'grass', 'dirt', 'wood', 'stone', 'metal', 'water',
    ]);
    for (const variants of Object.values(FOOTSTEP_ASSET_IDS)) {
      expect(variants).toHaveLength(2);
      expect(variants[0]).not.toBe(variants[1]);
      for (const id of variants) expect(AUDIO_ASSET_URLS[id]).toMatch(/movement-footstep-/);
    }
  });

  it('区域环境声在室内衰减并按林地和海岸独立混音', () => {
    const forest = ambienceMix(0, 1, 'forest', false);
    const coast = ambienceMix(0, 1, 'coast', false);
    const rainOutside = ambienceMix(1, 0.5, 'open', false);
    const rainInside = ambienceMix(1, 0.5, 'open', true);

    expect(forest.forest).toBeGreaterThan(0);
    expect(forest.coast).toBe(0);
    expect(coast.coast).toBeGreaterThan(0);
    expect(coast.forest).toBe(0);
    expect(rainInside.wind).toBeLessThan(rainOutside.wind);
    expect(rainInside.rain).toBeLessThan(rainOutside.rain);
  });
});
