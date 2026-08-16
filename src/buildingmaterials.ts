import * as THREE from 'three';
import { applySurfaceAsset, type SurfaceAssetId } from './assets';
import { SURFACE_MATERIAL_PRESETS } from './assetcatalog';

export function enhanceStructureMaterial(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vStructureLocal;\nvarying vec3 vStructureWorld;\nvarying vec3 vStructureNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vStructureLocal = position;\n  vStructureNormal = objectNormal;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n  vStructureWorld = worldPosition.xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vStructureLocal;\nvarying vec3 vStructureWorld;\nvarying vec3 vStructureNormal;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float structureGrain = sin(vStructureWorld.x * 2.17 + vStructureWorld.y * 0.73)
    * cos(vStructureWorld.z * 1.93 - vStructureWorld.y * 0.51) * 0.5 + 0.5;
  float baseDust = 1.0 - smoothstep(-0.5, 0.34, vStructureLocal.y);
  float verticalFace = 1.0 - abs(normalize(vStructureNormal).y);
  float fineStreak = smoothstep(0.68, 0.98,
    sin(vStructureWorld.x * 0.71 + vStructureWorld.z * 0.53) * 0.5 + 0.5);
  float structureTone = 0.975 + structureGrain * 0.04;
  structureTone -= baseDust * verticalFace * 0.045;
  structureTone -= fineStreak * verticalFace * 0.018;
  structureTone += max(normalize(vStructureNormal).y, 0.0) * 0.025;
  diffuseColor.rgb *= structureTone;`,
      );
  };
  mat.customProgramCacheKey = () => 'building-surface-detail-v1';
}

export function createBuildingSurfaceMaterial(surface: SurfaceAssetId): THREE.MeshStandardMaterial {
  const preset = SURFACE_MATERIAL_PRESETS[surface];
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: preset.roughness,
    metalness: preset.metalness,
  });
  enhanceStructureMaterial(material);
  applySurfaceAsset(material, surface, preset.scale * 0.52, preset.strength, true);
  return material;
}
