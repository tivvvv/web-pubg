import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildAttachmentLootModel } from '../src/loot';
import type { AttachLootId } from '../src/types';

const ATTACHMENTS: AttachLootId[] = [
  'attReddot', 'attScope2', 'attScope4', 'attExtmag', 'attComp', 'attSuppressor',
];

describe('地面配件模型', () => {
  it('六种配件都有多部件模型和足够可见尺寸', () => {
    for (const kind of ATTACHMENTS) {
      const model = buildAttachmentLootModel(kind);
      const meshes: THREE.Mesh[] = [];
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) meshes.push(object);
      });
      expect(meshes.length, `${kind} 仍是占位模型`).toBeGreaterThanOrEqual(4);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      expect(Math.max(size.x, size.y, size.z), `${kind} 模型太小`).toBeGreaterThan(0.25);
      expect(meshes.every((mesh) => mesh.name.length > 0), `${kind} 存在无语义部件`).toBe(true);
    }
  });

  it('瞄准镜拥有镜片和安装座而且四倍镜大于二倍镜', () => {
    const two = buildAttachmentLootModel('attScope2');
    const four = buildAttachmentLootModel('attScope4');
    for (const model of [two, four]) {
      expect(model.getObjectByName('objective-lens')).toBeDefined();
      expect(model.getObjectByName('ocular-lens')).toBeDefined();
      expect(model.getObjectByName('scope-mount')).toBeDefined();
    }
    const twoSize = new THREE.Box3().setFromObject(two).getSize(new THREE.Vector3());
    const fourSize = new THREE.Box3().setFromObject(four).getSize(new THREE.Vector3());
    expect(fourSize.length()).toBeGreaterThan(twoSize.length());
  });
});
