// 轻量静态资产表和材质细节注入。测试环境使用中性纹理，浏览器中异步替换为正式 PNG。
import * as THREE from 'three';
import type { WeaponId } from './types';

export type SurfaceAssetId =
  | 'plaster'
  | 'terrain'
  | 'wood'
  | 'metal'
  | 'fabric'
  | 'stone'
  | 'concrete'
  | 'roof'
  | 'foliage'
  | 'paintedMetal'
  | 'stonegateBrick';
export type FootstepSurface = 'grass' | 'dirt' | 'wood' | 'stone' | 'metal' | 'water';
export type AudioAssetId =
  | `shot-${Exclude<WeaponId, 'lmg'>}`
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
  | `movement-footstep-${FootstepSurface}-${'a' | 'b'}`
  | 'movement-splash'
  | 'action-door'
  | 'environment-wind'
  | 'environment-forest'
  | 'environment-coast'
  | 'environment-rain'
  | `shot-tail-${'indoor' | 'open' | 'forest'}`;

export const SURFACE_ASSET_URLS: Readonly<Record<SurfaceAssetId, string>> = Object.freeze({
  plaster: '/assets/textures/plaster-detail.png',
  terrain: '/assets/textures/terrain-detail-v2.png',
  wood: '/assets/textures/wood-detail.png',
  metal: '/assets/textures/metal-detail.png',
  fabric: '/assets/textures/fabric-detail.png',
  stone: '/assets/textures/stone-detail.png',
  concrete: '/assets/textures/concrete-detail.png',
  roof: '/assets/textures/roof-detail.png',
  foliage: '/assets/textures/foliage-detail.png',
  paintedMetal: '/assets/textures/painted-metal-detail.png',
  stonegateBrick: '/assets/textures/stonegate-brick-detail.png',
});

export interface SurfacePbrProfile {
  roughnessVariation: number;
  reliefContrast: number;
  bumpStrength: number;
  detailCenter: number;
}

// 颜色细节、微表面粗糙度使用同一套资产定义，避免视觉层和物理材质参数各自漂移。
export const SURFACE_PBR_PROFILES: Readonly<Record<SurfaceAssetId, SurfacePbrProfile>> = Object.freeze({
  plaster: { roughnessVariation: 0.1, reliefContrast: 0.18, bumpStrength: 0.2, detailCenter: 0.875 },
  terrain: { roughnessVariation: 0.12, reliefContrast: 0.2, bumpStrength: 0.16, detailCenter: 0.61 },
  wood: { roughnessVariation: 0.16, reliefContrast: 0.3, bumpStrength: 0.38, detailCenter: 0.875 },
  metal: { roughnessVariation: 0.22, reliefContrast: 0.2, bumpStrength: 0.18, detailCenter: 0.875 },
  fabric: { roughnessVariation: 0.12, reliefContrast: 0.22, bumpStrength: 0.24, detailCenter: 0.875 },
  stone: { roughnessVariation: 0.2, reliefContrast: 0.38, bumpStrength: 0.5, detailCenter: 0.875 },
  concrete: { roughnessVariation: 0.16, reliefContrast: 0.28, bumpStrength: 0.34, detailCenter: 0.875 },
  roof: { roughnessVariation: 0.19, reliefContrast: 0.34, bumpStrength: 0.46, detailCenter: 0.875 },
  foliage: { roughnessVariation: 0.13, reliefContrast: 0.2, bumpStrength: 0.22, detailCenter: 0.875 },
  paintedMetal: { roughnessVariation: 0.24, reliefContrast: 0.2, bumpStrength: 0.2, detailCenter: 0.875 },
  stonegateBrick: { roughnessVariation: 0.27, reliefContrast: 0.5, bumpStrength: 0.58, detailCenter: 0.875 },
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
  'movement-footstep-grass-a': '/assets/audio/movement-footstep-grass-a.wav',
  'movement-footstep-grass-b': '/assets/audio/movement-footstep-grass-b.wav',
  'movement-footstep-dirt-a': '/assets/audio/movement-footstep-dirt-a.wav',
  'movement-footstep-dirt-b': '/assets/audio/movement-footstep-dirt-b.wav',
  'movement-footstep-wood-a': '/assets/audio/movement-footstep-wood-a.wav',
  'movement-footstep-wood-b': '/assets/audio/movement-footstep-wood-b.wav',
  'movement-footstep-stone-a': '/assets/audio/movement-footstep-stone-a.wav',
  'movement-footstep-stone-b': '/assets/audio/movement-footstep-stone-b.wav',
  'movement-footstep-metal-a': '/assets/audio/movement-footstep-metal-a.wav',
  'movement-footstep-metal-b': '/assets/audio/movement-footstep-metal-b.wav',
  'movement-footstep-water-a': '/assets/audio/movement-footstep-water-a.wav',
  'movement-footstep-water-b': '/assets/audio/movement-footstep-water-b.wav',
  'movement-splash': '/assets/audio/movement-splash.wav',
  'action-door': '/assets/audio/action-door.wav',
  'environment-wind': '/assets/audio/environment-wind.wav',
  'environment-forest': '/assets/audio/environment-forest.wav',
  'environment-coast': '/assets/audio/environment-coast.wav',
  'environment-rain': '/assets/audio/environment-rain.wav',
  'shot-tail-indoor': '/assets/audio/shot-tail-indoor.wav',
  'shot-tail-open': '/assets/audio/shot-tail-open.wav',
  'shot-tail-forest': '/assets/audio/shot-tail-forest.wav',
});

export const FOOTSTEP_ASSET_IDS: Readonly<
  Record<FootstepSurface, readonly [AudioAssetId, AudioAssetId]>
> = Object.freeze({
  grass: ['movement-footstep-grass-a', 'movement-footstep-grass-b'],
  dirt: ['movement-footstep-dirt-a', 'movement-footstep-dirt-b'],
  wood: ['movement-footstep-wood-a', 'movement-footstep-wood-b'],
  stone: ['movement-footstep-stone-a', 'movement-footstep-stone-b'],
  metal: ['movement-footstep-metal-a', 'movement-footstep-metal-b'],
  water: ['movement-footstep-water-a', 'movement-footstep-water-b'],
});

const textureCache = new Map<SurfaceAssetId, THREE.Texture>();
const surfaceEnvironmentUniforms = {
  wetness: { value: 0 },
  cloudiness: { value: 0.18 },
  daylight: { value: 1 },
  rain: { value: 0 },
  warmth: { value: 0.54 },
};

export interface SurfaceEnvironmentState {
  wetness: number;
  cloudiness: number;
  daylight: number;
  rain: number;
  warmth: number;
}

export function setSurfaceEnvironment(
  wetness: number,
  cloudiness: number,
  daylight: number,
  rain = 0,
  warmth = 0.54,
): void {
  surfaceEnvironmentUniforms.wetness.value = THREE.MathUtils.clamp(wetness, 0, 1);
  surfaceEnvironmentUniforms.cloudiness.value = THREE.MathUtils.clamp(cloudiness, 0, 1);
  surfaceEnvironmentUniforms.daylight.value = THREE.MathUtils.clamp(daylight, 0, 1);
  surfaceEnvironmentUniforms.rain.value = THREE.MathUtils.clamp(rain, 0, 1);
  surfaceEnvironmentUniforms.warmth.value = THREE.MathUtils.clamp(warmth, 0, 1);
}

export function surfaceEnvironmentState(): SurfaceEnvironmentState {
  return {
    wetness: surfaceEnvironmentUniforms.wetness.value,
    cloudiness: surfaceEnvironmentUniforms.cloudiness.value,
    daylight: surfaceEnvironmentUniforms.daylight.value,
    rain: surfaceEnvironmentUniforms.rain.value,
    warmth: surfaceEnvironmentUniforms.warmth.value,
  };
}

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
  texture.anisotropy = 8;
  textureCache.set(id, texture);
  return texture;
}

export function applySurfaceAsset(
  material: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial,
  id: SurfaceAssetId,
  scale: number,
  strength: number,
  worldSpace = false,
): void {
  const texture = surfaceTexture(id);
  const pbr = SURFACE_PBR_PROFILES[id];
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  const assetPosition = worldSpace ? 'vAssetWorldPosition' : 'vAssetLocalPosition';
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uSurfaceAsset = { value: texture };
    shader.uniforms.uSurfaceScale = { value: scale };
    shader.uniforms.uSurfaceStrength = { value: strength };
    shader.uniforms.uSurfaceRoughnessVariation = { value: pbr.roughnessVariation };
    shader.uniforms.uSurfaceReliefContrast = { value: pbr.reliefContrast };
    shader.uniforms.uSurfaceBumpStrength = { value: pbr.bumpStrength };
    shader.uniforms.uSurfaceDetailCenter = { value: pbr.detailCenter };
    shader.uniforms.uAssetWetness = surfaceEnvironmentUniforms.wetness;
    shader.uniforms.uAssetCloudiness = surfaceEnvironmentUniforms.cloudiness;
    shader.uniforms.uAssetDaylight = surfaceEnvironmentUniforms.daylight;
    shader.uniforms.uAssetRain = surfaceEnvironmentUniforms.rain;
    shader.uniforms.uAssetWarmth = surfaceEnvironmentUniforms.warmth;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vAssetLocalPosition;\nvarying vec3 vAssetLocalNormal;\nvarying vec3 vAssetWorldPosition;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vAssetLocalPosition = position;\n  vAssetLocalNormal = objectNormal;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n  vAssetWorldPosition = worldPosition.xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uSurfaceAsset;
uniform float uSurfaceScale;
uniform float uSurfaceStrength;
uniform float uSurfaceRoughnessVariation;
uniform float uSurfaceReliefContrast;
uniform float uSurfaceBumpStrength;
uniform float uSurfaceDetailCenter;
uniform float uAssetWetness;
uniform float uAssetCloudiness;
uniform float uAssetDaylight;
uniform float uAssetRain;
uniform float uAssetWarmth;
varying vec3 vAssetLocalPosition;
varying vec3 vAssetLocalNormal;
varying vec3 vAssetWorldPosition;

float surfaceAssetDetail(vec3 samplePosition, vec3 sampleWeights) {
  float sampleX = texture2D(uSurfaceAsset, samplePosition.yz * uSurfaceScale).r;
  float sampleY = texture2D(uSurfaceAsset, samplePosition.xz * uSurfaceScale).r;
  float sampleZ = texture2D(uSurfaceAsset, samplePosition.xy * uSurfaceScale).r;
  return sampleX * sampleWeights.x + sampleY * sampleWeights.y + sampleZ * sampleWeights.z;
}

vec3 perturbSurfaceNormal(vec3 surfPosition, vec3 surfNormal, vec2 heightDerivative, float facing) {
  vec3 sigmaX = normalize(dFdx(surfPosition));
  vec3 sigmaY = normalize(dFdy(surfPosition));
  vec3 r1 = cross(sigmaY, surfNormal);
  vec3 r2 = cross(surfNormal, sigmaX);
  float determinant = dot(sigmaX, r1) * facing;
  vec3 gradient = sign(determinant) * (heightDerivative.x * r1 + heightDerivative.y * r2);
  return normalize(abs(determinant) * surfNormal - gradient);
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  vec3 assetNormalWeights = abs(normalize(vAssetLocalNormal));
  assetNormalWeights /= max(assetNormalWeights.x + assetNormalWeights.y + assetNormalWeights.z, 0.0001);
  float assetBumpHeight = surfaceAssetDetail(${assetPosition}, assetNormalWeights);
  vec2 assetHeightDerivative = vec2(dFdx(assetBumpHeight), dFdy(assetBumpHeight)) * uSurfaceBumpStrength;
  normal = perturbSurfaceNormal(-vViewPosition, normal, assetHeightDerivative, faceDirection);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  vec3 assetWeights = abs(normalize(vAssetLocalNormal));
  assetWeights /= max(assetWeights.x + assetWeights.y + assetWeights.z, 0.0001);
  float assetDetail = surfaceAssetDetail(${assetPosition}, assetWeights);
  float assetRelief = (assetDetail - uSurfaceDetailCenter) * uSurfaceReliefContrast;
  diffuseColor.rgb *= 1.0 + (assetDetail - uSurfaceDetailCenter) * uSurfaceStrength + assetRelief * 0.12;
  float assetWetNoise = sin(vAssetWorldPosition.x * 0.63 + vAssetWorldPosition.z * 0.37)
    * cos(vAssetWorldPosition.z * 0.51 - vAssetWorldPosition.y * 0.43) * 0.5 + 0.5;
  float assetUpward = max(normalize(vAssetLocalNormal).y, 0.0);
  float assetWetPatch = smoothstep(0.3, 0.78, assetWetNoise);
  float assetWet = uAssetWetness * mix(0.42, 0.92, assetUpward) * mix(0.74, 1.0, assetWetPatch);
  diffuseColor.rgb *= 1.0 - assetWet * mix(0.1, 0.2, uAssetCloudiness);
  diffuseColor.rgb *= mix(0.96, 1.0, uAssetDaylight);
  vec3 assetCool = vec3(0.965, 0.985, 1.035);
  vec3 assetWarm = vec3(1.035, 1.005, 0.955);
  vec3 assetTemperature = mix(assetCool, assetWarm, uAssetWarmth);
  diffuseColor.rgb *= mix(vec3(1.0), assetTemperature, 0.11 + (1.0 - uAssetDaylight) * 0.035);
  diffuseColor.rgb = mix(diffuseColor.rgb, dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) * vec3(1.0), uAssetRain * 0.025);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = clamp(
    roughnessFactor + (uSurfaceDetailCenter - assetDetail) * uSurfaceRoughnessVariation,
    0.18,
    1.0
  );
  roughnessFactor = mix(roughnessFactor, max(0.28, roughnessFactor * 0.58), assetWet * 0.82);`,
      );
  };
  material.customProgramCacheKey = () => `${previousCacheKey.call(material)}|asset-pbr-v5:${id}:${scale}:${strength}:${worldSpace ? 'world' : 'local'}`;
}

export function shotAssetId(kind: WeaponId, suppressed: boolean): AudioAssetId {
  if (suppressed) return 'shot-suppressed';
  return kind === 'lmg' ? 'shot-rifle' : `shot-${kind}`;
}
