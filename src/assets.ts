// 轻量静态资产表和材质细节注入。测试环境使用中性纹理，浏览器中异步替换为正式 PNG。
import * as THREE from 'three';
import type { WeaponId } from './types';

export type SurfaceAssetId = 'plaster' | 'terrain' | 'wood' | 'metal' | 'fabric';
export type AudioAssetId =
  | `shot-${WeaponId}`
  | 'shot-suppressed'
  | 'impact-body'
  | 'impact-head'
  | 'impact-wood'
  | 'impact-glass'
  | 'impact-metal'
  | 'explosion-frag'
  | 'explosion-artillery'
  | 'ui-pickup'
  | 'action-reload'
  | 'movement-footstep'
  | 'movement-splash'
  | 'action-door';

export const SURFACE_ASSET_URLS: Readonly<Record<SurfaceAssetId, string>> = Object.freeze({
  plaster: '/assets/textures/plaster-detail.png',
  terrain: '/assets/textures/terrain-detail.png',
  wood: '/assets/textures/wood-detail.png',
  metal: '/assets/textures/metal-detail.png',
  fabric: '/assets/textures/fabric-detail.png',
});

export const AUDIO_ASSET_URLS: Readonly<Record<AudioAssetId, string>> = Object.freeze({
  'shot-pistol': '/assets/audio/shot-pistol.wav',
  'shot-rifle': '/assets/audio/shot-rifle.wav',
  'shot-akm': '/assets/audio/shot-akm.wav',
  'shot-smg': '/assets/audio/shot-smg.wav',
  'shot-dmr': '/assets/audio/shot-dmr.wav',
  'shot-sniper': '/assets/audio/shot-sniper.wav',
  'shot-shotgun': '/assets/audio/shot-shotgun.wav',
  'shot-suppressed': '/assets/audio/shot-suppressed.wav',
  'impact-body': '/assets/audio/impact-body.wav',
  'impact-head': '/assets/audio/impact-head.wav',
  'impact-wood': '/assets/audio/impact-wood.wav',
  'impact-glass': '/assets/audio/impact-glass.wav',
  'impact-metal': '/assets/audio/impact-metal.wav',
  'explosion-frag': '/assets/audio/explosion-frag.wav',
  'explosion-artillery': '/assets/audio/explosion-artillery.wav',
  'ui-pickup': '/assets/audio/ui-pickup.wav',
  'action-reload': '/assets/audio/action-reload.wav',
  'movement-footstep': '/assets/audio/movement-footstep.wav',
  'movement-splash': '/assets/audio/movement-splash.wav',
  'action-door': '/assets/audio/action-door.wav',
});

const textureCache = new Map<SurfaceAssetId, THREE.Texture>();

function neutralTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([224, 224, 224, 255]), 1, 1);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function surfaceTexture(id: SurfaceAssetId): THREE.Texture {
  const cached = textureCache.get(id);
  if (cached) return cached;
  if (typeof document === 'undefined') {
    const texture = neutralTexture();
    textureCache.set(id, texture);
    return texture;
  }
  const texture = new THREE.TextureLoader().load(
    SURFACE_ASSET_URLS[id],
    () => {
      texture.needsUpdate = true;
      const loaded = Number(document.body.dataset.surfaceAssetsLoaded ?? 0) + 1;
      document.body.dataset.surfaceAssetsLoaded = String(loaded);
    },
    undefined,
    () => {
      const failed = Number(document.body.dataset.surfaceAssetErrors ?? 0) + 1;
      document.body.dataset.surfaceAssetErrors = String(failed);
    },
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 4;
  textureCache.set(id, texture);
  return texture;
}

export function applySurfaceAsset(
  material: THREE.MeshStandardMaterial,
  id: SurfaceAssetId,
  scale: number,
  strength: number,
): void {
  const texture = surfaceTexture(id);
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uSurfaceAsset = { value: texture };
    shader.uniforms.uSurfaceScale = { value: scale };
    shader.uniforms.uSurfaceStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vAssetLocalPosition;\nvarying vec3 vAssetLocalNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vAssetLocalPosition = position;\n  vAssetLocalNormal = objectNormal;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uSurfaceAsset;
uniform float uSurfaceScale;
uniform float uSurfaceStrength;
varying vec3 vAssetLocalPosition;
varying vec3 vAssetLocalNormal;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  vec3 assetWeights = abs(normalize(vAssetLocalNormal));
  assetWeights /= max(assetWeights.x + assetWeights.y + assetWeights.z, 0.0001);
  float assetX = texture2D(uSurfaceAsset, vAssetLocalPosition.yz * uSurfaceScale).r;
  float assetY = texture2D(uSurfaceAsset, vAssetLocalPosition.xz * uSurfaceScale).r;
  float assetZ = texture2D(uSurfaceAsset, vAssetLocalPosition.xy * uSurfaceScale).r;
  float assetDetail = assetX * assetWeights.x + assetY * assetWeights.y + assetZ * assetWeights.z;
  diffuseColor.rgb *= 1.0 + (assetDetail - 0.875) * uSurfaceStrength;`,
      );
  };
  material.customProgramCacheKey = () => `${previousCacheKey.call(material)}|asset:${id}:${scale}:${strength}`;
}

export function shotAssetId(kind: WeaponId, suppressed: boolean): AudioAssetId {
  return suppressed ? 'shot-suppressed' : `shot-${kind}`;
}
