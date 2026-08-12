import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { canAttach, emptyAttachments, magSizeOf, recoilFactorOf, sightZoomOf } from '../src/attachments';
import { WEAPONS } from '../src/weapons';
import { attachWeaponMods, buildWeaponModel, FIREARM_MODEL_SCALE } from '../src/weaponmodels';

describe('武器配件规则', () => {
  it('枪械模型统一放大且近战装备保持原尺寸', () => {
    expect(buildWeaponModel('rifle').group.scale.x).toBe(FIREARM_MODEL_SCALE);
    expect(buildWeaponModel('pistol').group.scale.x).toBe(FIREARM_MODEL_SCALE);
    expect(buildWeaponModel('knife').group.scale.x).toBe(1);
  });
  it('瞄具和枪口配件具有可辨认的近景结构', () => {
    const scoped = buildWeaponModel('rifle');
    attachWeaponMods(scoped.group, { sight: 'scope4', muzzle: 'suppressor', mag: null });
    expect(scoped.group.getObjectsByProperty('name', 'optic-lens')).toHaveLength(2);
    expect(scoped.group.getObjectsByProperty('name', 'scope-mount')).toHaveLength(2);
    expect(scoped.group.getObjectByName('scope-turret')).toBeTruthy();
    expect(scoped.group.getObjectByName('scope-side-turret')).toBeTruthy();
    expect(scoped.group.getObjectsByProperty('name', 'scope-detail-ring')).toHaveLength(2);
    expect(scoped.group.getObjectsByProperty('name', 'suppressor-band')).toHaveLength(2);
    expect(scoped.group.getObjectByName('suppressor-end-cap')).toBeTruthy();
    expect(scoped.group.getObjectByName('suppressor-bore')).toBeTruthy();

    const dotted = buildWeaponModel('akm');
    attachWeaponMods(dotted.group, { sight: 'reddot', muzzle: 'comp', mag: 'extmag' });
    expect(dotted.group.getObjectByName('reddot-hood')).toBeTruthy();
    expect(dotted.group.getObjectByName('reddot-reticle')).toBeTruthy();
    expect(dotted.group.getObjectsByProperty('name', 'reddot-guard')).toHaveLength(2);
    expect(dotted.group.getObjectsByProperty('name', 'compensator-port')).toHaveLength(2);
    expect(dotted.group.getObjectByName('compensator-crown')).toBeTruthy();
    expect(dotted.group.getObjectByName('extmag-baseplate')).toBeTruthy();
    expect(dotted.group.getObjectsByProperty('name', 'extmag-rib')).toHaveLength(3);
  });

  it('八类枪械均达到第五版模型细节预算并保留独立轮廓', () => {
    const ids = ['pistol', 'smg', 'rifle', 'akm', 'lmg', 'dmr', 'sniper', 'shotgun'] as const;
    for (const id of ids) {
      const model = buildWeaponModel(id);
      let physicalParts = 0;
      let maxGeometryVertices = 0;
      const materials = new Set<THREE.Material>();
      model.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        physicalParts += object instanceof THREE.InstancedMesh ? object.count : 1;
        const position = object.geometry.getAttribute('position');
        maxGeometryVertices = Math.max(maxGeometryVertices, position?.count ?? 0);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.forEach((material) => materials.add(material));
      });
      expect(model.group.userData.assetQuality).toBe('firearm-v5');
      expect(model.group.getObjectByName('muzzle-bore')).toBeTruthy();
      expect(model.group.getObjectByName('trigger-guard')).toBeTruthy();
      expect(model.group.getObjectByName('receiver-markings')).toBeTruthy();
      expect(model.group.getObjectByName('firearm-premium-finish')).toBeTruthy();
      expect(model.group.getObjectsByProperty('name', 'receiver-inlay-panel')).toHaveLength(2);
      expect(model.group.getObjectsByProperty('name', 'receiver-highlight-edge')).toHaveLength(2);
      expect(model.group.getObjectByName('finish-fasteners')).toBeTruthy();
      expect(model.group.getObjectByName('serial-engraving')).toBeTruthy();
      expect(model.group.getObjectsByProperty('name', 'selector-indicator')).toHaveLength(2);
      expect(physicalParts, `${id} 的结构零件不足`).toBeGreaterThanOrEqual(38);
      expect(maxGeometryVertices, `${id} 仍使用过粗几何`).toBeGreaterThanOrEqual(100);
      expect(materials.size, `${id} 的材质分区不足`).toBeGreaterThanOrEqual(4);
    }
    const rifleSize = new THREE.Box3().setFromObject(buildWeaponModel('rifle').group).getSize(new THREE.Vector3());
    const sniperSize = new THREE.Box3().setFromObject(buildWeaponModel('sniper').group).getSize(new THREE.Vector3());
    const pistolSize = new THREE.Box3().setFromObject(buildWeaponModel('pistol').group).getSize(new THREE.Vector3());
    expect(sniperSize.z).toBeGreaterThan(rifleSize.z);
    expect(rifleSize.z).toBeGreaterThan(pistolSize.z * 2.5);
  });

  it('扩容弹匣按枪型增加正确容量', () => {
    expect(magSizeOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(40);
    expect(magSizeOf({ def: WEAPONS.sniper, mag: 5, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(7);
    expect(magSizeOf({ def: WEAPONS.lmg, mag: 50, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(75);
  });

  it('瞄具提供真实 ADS 倍率', () => {
    expect(sightZoomOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), sight: 'scope4' } })).toBe(4);
    expect(sightZoomOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), sight: 'scope2' } })).toBe(2);
  });

  it('兼容规则和补偿器后坐系数保持稳定', () => {
    expect(canAttach('shotgun', 'reddot')).toBe(false);
    expect(canAttach('sniper', 'scope4')).toBe(false);
    expect(canAttach('pistol', 'scope2')).toBe(false);
    expect(canAttach('pistol', 'reddot')).toBe(true);
    expect(recoilFactorOf({ def: WEAPONS.akm, mag: 30, att: { ...emptyAttachments(), muzzle: 'comp' } })).toBe(0.7);
  });
});
