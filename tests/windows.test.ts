import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Character } from '../src/character';
import { probeVault } from '../src/vault';
import { World, type StaticHit } from '../src/world';

function createWorld(): World {
  return new World(new THREE.Scene());
}

describe('建筑窗户与教堂玻璃', () => {
  it('住宅同时生成十字玻璃窗和可碎无格玻璃窗', () => {
    const world = createWorld();
    expect(world.buildings.openWindowCount).toBeGreaterThan(20);
    expect(world.buildings.crossWindowCount).toBeGreaterThan(world.buildings.openWindowCount);
    expect(world.buildings.openWindowOpenings).toHaveLength(world.buildings.openWindowCount);

    for (const opening of world.buildings.openWindowOpenings) {
      const centerA = (opening.a0 + opening.a1) * 0.5;
      const centerY = (opening.y0 + opening.y1) * 0.5;
      const occupyingGlass = world.aabbs.find((collider) => (
        !collider.off && collider.tag === 'window' &&
        centerY > collider.minY && centerY < collider.maxY &&
        (opening.axis === 'x'
          ? centerA > collider.minX && centerA < collider.maxX &&
            opening.fixed > collider.minZ - 0.02 && opening.fixed < collider.maxZ + 0.02
          : centerA > collider.minZ && centerA < collider.maxZ &&
            opening.fixed > collider.minX - 0.02 && opening.fixed < collider.maxX + 0.02)
      ));
      expect(occupyingGlass, `地块 ${opening.plotIndex} 的无格窗缺少玻璃碰撞`).toBeDefined();
      expect(occupyingGlass?.destruct?.vaultable).toBe(true);
      expect(occupyingGlass?.destruct?.mesh).toMatchObject({
        name: 'vaultable-plain-window-glass',
      });
    }
    const crossPanes = world.buildings.destructibles.filter((item) => item.mesh.name === 'cross-window-glass');
    expect(crossPanes.length).toBe(world.buildings.crossWindowCount);
    expect(crossPanes.every((item) => !item.vaultable)).toBe(true);
  });

  it('首层空窗可从室外和室内双向翻越', () => {
    const world = createWorld();
    const character = new Character('双向翻窗测试', true, 0x3a6ea5);
    let checked = 0;
    let bidirectional = 0;
    for (const opening of world.buildings.openWindowOpenings) {
      const plot = world.buildings.plots[opening.plotIndex];
      if (!plot || opening.y0 > plot.flatH + 1.8) continue;
      checked++;
      let directions = 0;
      for (const fromInterior of [false, true]) {
        const side = (fromInterior ? opening.interior : -opening.interior) as 1 | -1;
        const mid = (opening.a0 + opening.a1) * 0.5;
        const x = opening.axis === 'x' ? mid : opening.fixed + side * 0.92;
        const z = opening.axis === 'x' ? opening.fixed + side * 0.92 : mid;
        const expectedFloor = opening.y0 - 0.88;
        const feetY = world.groundHeight(x, z, expectedFloor + 0.2);
        character.pos.set(x, feetY, z);
        const dx = opening.axis === 'x' ? 0 : -side;
        const dz = opening.axis === 'x' ? -side : 0;
        if (probeVault(character, dx, dz, world)) directions++;
      }
      if (directions === 2) bidirectional++;
    }
    expect(checked).toBeGreaterThan(12);
    expect(bidirectional / checked).toBeGreaterThanOrEqual(0.7);
  });

  it('二楼无格玻璃窗可从室内击碎并翻越到室外', () => {
    const world = createWorld();
    const character = new Character('二楼翻窗测试', true, 0x3a6ea5);
    let checked = 0;
    let vaultable = 0;
    for (const opening of world.buildings.openWindowOpenings) {
      const plot = world.buildings.plots[opening.plotIndex];
      if (!plot || opening.y0 < plot.flatH + 3.7 || opening.y0 > plot.flatH + 5.2) continue;
      checked++;
      const side = opening.interior;
      const mid = (opening.a0 + opening.a1) * 0.5;
      const x = opening.axis === 'x' ? mid : opening.fixed + side * 0.92;
      const z = opening.axis === 'x' ? opening.fixed + side * 0.92 : mid;
      const expectedFloor = opening.y0 - 0.9;
      const feetY = world.groundHeight(x, z, expectedFloor + 0.2);
      character.pos.set(x, feetY, z);
      const probe = probeVault(
        character,
        opening.axis === 'x' ? 0 : -side,
        opening.axis === 'x' ? -side : 0,
        world,
      );
      if (probe?.win?.vaultable && probe.landY < feetY - 2) vaultable++;
    }
    expect(checked).toBeGreaterThan(10);
    expect(vaultable / checked).toBeGreaterThanOrEqual(0.65);
  });

  it('教堂十一块玻璃全部接入射击破坏和对局复位', () => {
    const world = createWorld();
    const panes = world.buildings.destructibles.filter((item) => item.mesh.name === 'church-breakable-glass');
    const church = world.landmarks.find((site) => site.kind === 'church');
    expect(church).toBeDefined();
    expect(world.churchBreakableGlassCount).toBe(11);
    expect(panes).toHaveLength(11);
    expect(panes.every((pane) => pane.vaultable)).toBe(true);

    for (const pane of panes) {
      expect(world.aabbs).toContain(pane.collider);
      expect(pane.collider.destruct).toBe(pane);
      const thinX = pane.collider.maxX - pane.collider.minX < pane.collider.maxZ - pane.collider.minZ;
      const origin = new THREE.Vector3(pane.cx, pane.cy + 0.36, pane.cz);
      const direction = thinX
        ? new THREE.Vector3(Math.sign(pane.cx - church!.x), 0, 0)
        : new THREE.Vector3(0, 0, -1);
      origin.addScaledVector(direction, -0.5);
      // 偏离十字窗格中心再发射射线，验证玻璃面本身可命中，而不是装饰窗棂。
      if (thinX) origin.z += 0.48;
      else origin.x += 0.56;
      const hit: StaticHit = { t: 0, kind: 'wall' };
      expect(world.raycastStatics(origin, direction, 1, hit)).toBe(true);
      expect(hit.kind).toBe('window');
      expect(hit.destruct).toBe(pane);
    }

    const pane = panes[0]!;
    pane.reset(false);
    expect(pane.mesh.visible).toBe(false);
    expect(pane.collider.off).toBe(true);
    world.buildings.reset();
    expect(pane.alive).toBe(true);
    expect(pane.mesh.visible).toBe(true);
    expect(pane.collider.off).toBe(false);
  });

  it('教堂侧窗可从室内外双向击碎翻越', () => {
    const world = createWorld();
    const church = world.landmarks.find((site) => site.kind === 'church');
    expect(church).toBeDefined();
    if (!church) return;
    const sidePanes = world.buildings.destructibles.filter((item) => (
      item.mesh.name === 'church-breakable-glass' && Math.abs(item.cx - church.x) > 4
    ));
    const floorTop = world.platforms
      .filter((platform) => (
        platform.minX < church.x && platform.maxX > church.x &&
        platform.minZ < church.z - 5 && platform.maxZ > church.z - 5
      ))
      .reduce((highest, platform) => Math.max(highest, platform.top), -Infinity);
    const character = new Character('教堂翻窗测试', true, 0x3a6ea5);
    let successfulDirections = 0;
    for (const pane of sidePanes) {
      const outward = Math.sign(pane.cx - church.x) || 1;
      for (const fromInside of [true, false]) {
        character.pos.set(pane.cx + (fromInside ? -outward : outward) * 0.92, floorTop, pane.cz);
        const probe = probeVault(character, fromInside ? outward : -outward, 0, world);
        if (probe?.win === pane) successfulDirections++;
      }
    }
    expect(sidePanes).toHaveLength(10);
    expect(successfulDirections).toBe(20);
  });

  it('教堂后窗是没有隐藏整墙的真实双向翻越洞口', () => {
    const world = createWorld();
    const church = world.landmarks.find((site) => site.kind === 'church');
    expect(church).toBeDefined();
    if (!church) return;
    const pane = world.buildings.destructibles.find((item) => (
      item.mesh.name === 'church-breakable-glass' && Math.abs(item.cx - church.x) < 0.1
    ));
    expect(pane).toBeDefined();
    if (!pane) return;
    const floorTop = world.platforms
      .filter((platform) => platform.minX < church.x && platform.maxX > church.x && platform.minZ < pane.cz)
      .reduce((highest, platform) => Math.max(highest, platform.top), -Infinity);
    const character = new Character('教堂后窗测试', true, 0x3a6ea5);
    for (const fromInside of [true, false]) {
      const side = fromInside ? 1 : -1;
      character.pos.set(pane.cx, floorTop, pane.cz + side * 0.92);
      const probe = probeVault(character, 0, -side, world);
      expect(probe?.win).toBe(pane);
    }
  });
});
