// 世界: 程序化高度场地形 + 植被/岩石实例化 + 真房屋村庄 + 碰撞与解析射线
import * as THREE from 'three';
import { Noise2D, fbm } from './noise';
import { Buildings, Destructible } from './buildings';
import { EnvironmentSystem, type EnvironmentSnapshot } from './environment';
import { Sky } from './sky';
import type { Collider, DestructibleLike, SurfaceKind } from './types';
import { clamp, mulberry32, smoothstep } from './utils';
import { TACTICAL_ROUTES, type TacticalCoverKind } from './tactics';
import { SpatialPointGrid } from './spatialgrid';
import {
  MAP_CONTENT_SITES,
  mapContentSiteAt,
  type MapContentKind,
  type ResolvedMapContentSite,
} from './mapcontent';
import { regionAt, regionById, type RegionId } from './regions';
import { applySurfaceAsset, type FootstepSurface, type SurfaceAssetId } from './assets';
import { AssetUsageRegistry, SURFACE_MATERIAL_PRESETS } from './assetcatalog';
import {
  makeBroadleafCrownGeometry, makeColumnarPineCanopyGeometry, makeDistantRidgeGeometry,
  makeFernGeometry, makePineCanopyGeometry, makeWildflowerGeometry, makeWindshapedCrownGeometry,
  naturalDetailBudget, shorelineSuitability, terrainSurfaceWeights,
} from './nature';

type CylinderCollider = Extract<Collider, { kind: 'cyl' }>;
type BoxCollider = Extract<Collider, { kind: 'aabb' }>;

export const WORLD_SIZE = 700;
export const WORLD_HALF = 350;
export const WATER_Y = 0.9;
const ROAD_WATER_DECK_Y = WATER_Y + 0.72;
const MAIN_BRIDGE_XS = [-50, 170] as const;
const MAIN_BRIDGE_HALF_LENGTH = 14;
const MAIN_BRIDGE_HALF_WIDTH = 2.7;
export const SUN_SHADOW_MAP_SIZE = 2048;
export const CHARACTER_COLLISION_HEIGHT = 1.7;
export const PLATFORM_TOP_SNAP_TOLERANCE = 0.12;
const CEILING_CONTACT_GAP = 0.025;

export function characterOverlapsColliderHeight(feetY: number, minY: number, maxY: number): boolean {
  return feetY < maxY - 0.02 && feetY + CHARACTER_COLLISION_HEIGHT > minY;
}

// 河流中心线: z ≈ +80, 正弦蜿蜒 ±22
export function riverZAt(x: number): number {
  return 80 + 22 * Math.sin(x * 0.012 + 1.3);
}

function insideMainBridgeDeck(x: number, z: number, padding = 0): boolean {
  return MAIN_BRIDGE_XS.some((bridgeX) => (
    Math.abs(x - bridgeX) <= MAIN_BRIDGE_HALF_WIDTH + padding &&
    Math.abs(z - riverZAt(bridgeX)) <= MAIN_BRIDGE_HALF_LENGTH + padding
  ));
}

const GRID = 192; // 更细地形网格让山脊、河岸和道路交界保持连续轮廓
const CELL = WORLD_SIZE / GRID;
const COLLISION_GRID_CELL = 20;
const COLLISION_QUERY_PADDING = 3;

export interface StaticHit {
  t: number;
  kind: SurfaceKind;
  destruct?: DestructibleLike; // 命中可破坏物(门/窗)时带出
}

export interface Platform {
  minX: number; minZ: number; maxX: number; maxZ: number; top: number;
}

export type ScenicKind = 'lookout' | 'windmill' | 'ruins' | 'dock' | 'church';
export type TreeVisualKind = 'pine' | 'columnar' | 'broadleaf' | 'windshaped';

export interface ScenicSite {
  kind: ScenicKind;
  x: number;
  z: number;
  r: number;
}

export interface MapLootSpot {
  x: number;
  y: number;
  z: number;
  premium: boolean;
  region: RegionId;
  siteId: string;
}

export const ROAD_PATHS: readonly (readonly [number, number])[][] = [
  [[-92, -96], [-66, -72], [-58, -20], [-52, 36], [-50, 66], [-50, 112], [-44, 164], [-40, 246]],
  [[-142, -26], [-98, -23], [-58, -20], [-8, -18], [42, -12], [98, -18], [152, -31], [178, -38], [194, -43]],
  [[178, -38], [194, -82], [203, -140], [205, -209]],
  [[-84, -20], [-136, -7], [-181, 9], [-228, 20]],
  [[-58, -20], [-46, -68], [-30, -112], [-16, -158], [-10, -170], [0, -180], [10, -190], [10, -200], [20, -200]],
  [[178, -38], [171, 18], [170, 64], [170, 112], [134, 160], [70, 190], [-40, 200]],
];

const DESIGNED_ROAD_TERMINI = [
  { x: 194, z: -43, fromX: 178, fromZ: -38, style: 'concrete' },
  { x: 205, z: -209, fromX: 203, fromZ: -140, style: 'harbor' },
  { x: 20, z: -200, fromX: 10, fromZ: -200, style: 'forest' },
] as const;

// 供建筑规划和地图审计共用的道路占地判定。道路主体之外再传入 clearance，
// 即可保证建筑墙体、门阶和道路路肩之间留有明确净距。
export function roadIntersectsRect(
  minX: number, minZ: number, maxX: number, maxZ: number, clearance = 0,
): boolean {
  const x0 = minX - clearance;
  const z0 = minZ - clearance;
  const x1 = maxX + clearance;
  const z1 = maxZ + clearance;
  for (const path of ROAD_PATHS) {
    for (let index = 0; index < path.length - 1; index++) {
      const a = path[index] as readonly [number, number];
      const b = path[index + 1] as readonly [number, number];
      let near = 0;
      let far = 1;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      let separated = false;
      for (const [p, q] of [
        [-dx, a[0] - x0], [dx, x1 - a[0]],
        [-dz, a[1] - z0], [dz, z1 - a[1]],
      ] as const) {
        if (Math.abs(p) < 0.000001) {
          if (q < 0) separated = true;
          continue;
        }
        const ratio = q / p;
        if (p < 0) near = Math.max(near, ratio);
        else far = Math.min(far, ratio);
        if (near > far) separated = true;
      }
      if (!separated && near <= far) return true;
    }
  }
  return false;
}

export class World {
  readonly colliders: Collider[] = [];
  readonly cyls: Extract<Collider, { kind: 'cyl' }>[] = [];
  readonly boatPts: { x: number; z: number }[] = []; // 搁浅渔船(野外战利品锚点)
  readonly aabbs: Extract<Collider, { kind: 'aabb' }>[] = [];
  readonly platforms: Platform[] = []; // 楼梯踏步等"可站立但无碰撞体"平台
  readonly buildings = new Buildings();
  readonly bushes: { x: number; z: number; r: number }[] = []; // 灌木足迹(隐蔽判定)
  readonly naturalRocks: { x: number; z: number; r: number }[] = []; // 自然岩石足迹(穿模审计)
  readonly farmFenceColliders: BoxCollider[] = []; // 与可见短围栏逐段对应, 保留真实缺口
  readonly treeVisualSamples: { kind: TreeVisualKind; x: number; z: number }[] = []; // 实机视觉巡检锚点
  readonly environment: EnvironmentSystem;
  readonly tacticalRoutes = TACTICAL_ROUTES;
  readonly mapSites: ResolvedMapContentSite[] = [];
  readonly mapLootSpots: MapLootSpot[] = [];
  readonly assetUsage = new AssetUsageRegistry();
  tacticalCoverCount = 0;
  environmentDetailInstanceCount = 0;
  naturalGroundDetailCount = 0;
  groundMicroDetailCount = 0;
  naturalStoryPropCount = 0;
  humanDetailPropCount = 0;
  regionalIdentityDetailCount = 0;
  churchGardenPlanterCount = 0;
  farmFurrowCount = 0;
  farmFenceRailCount = 0;
  shorelineDetailCount = 0;
  distantLandformCount = 0;
  verticalSliceDetailCount = 0;
  treeCount = 0;
  treeVariantCount = 0;
  tacticalRockCount = 0;
  halfBushCount = 0;
  grassPatchCount = 0;
  churchDetailCount = 0;
  plazaDetailCount = 0;
  fountainDetailCount = 0;
  religiousCrossCount = 0;
  churchBreakableGlassCount = 0;
  roadTerminusCount = 0;
  roadWaterCrossingCount = 0;
  roadWaterCrossingSegmentCount = 0;
  readonly roadWaterCrossingPositions: Array<{ x: number; z: number }> = [];
  forestFacilityDetailCount = 0;
  readonly cityPlanterPositions: Array<{ x: number; z: number }> = [];
  readonly streetBarrelPositions: Array<{ x: number; z: number }> = [];
  maxTerrainH = 24;

  private heights = new Float32Array((GRID + 1) * (GRID + 1));
  private sun: THREE.DirectionalLight;
  private sky: Sky;
  private timeU = { value: 0 };   // 共享时间 uniform(水波/植被摇摆)
  private camU = { value: new THREE.Vector3() }; // 共享相机 uniform(草距离消退)
  private elapsed = 0;
  private scenicSites: ScenicSite[] = [];
  private shadowAnchor = new THREE.Vector3();
  private readonly cylinderGrid = new SpatialPointGrid<CylinderCollider>(
    -WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF, COLLISION_GRID_CELL,
  );
  private readonly aabbGrid = new SpatialPointGrid<BoxCollider>(
    -WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF, COLLISION_GRID_CELL,
  );
  private readonly platformGrid = new SpatialPointGrid<Platform>(
    -WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF, COLLISION_GRID_CELL,
  );
  private readonly rayCylinderCandidates: CylinderCollider[] = [];
  private readonly rayBoxCandidates: BoxCollider[] = [];

  get landmarks(): readonly ScenicSite[] {
    return this.scenicSites;
  }

  mapSiteAt(x: number, z: number): ResolvedMapContentSite | null {
    return mapContentSiteAt(this.mapSites, x, z);
  }

  constructor(scene: THREE.Scene) {
    const n1 = new Noise2D(1337);
    const n2 = new Noise2D(9001);
    const rawH = (x: number, z: number): number => {
      const d = Math.sqrt(x * x + z * z);
      const mask = smoothstep(360, 242, d); // 岛屿边缘下沉入海
      const base = fbm(n1, x * 0.0062, z * 0.0062, 4) * 12.5;
      const detail = fbm(n2, x * 0.021, z * 0.021, 2) * 2.2;
      let h = (base + detail + 7.0) * mask - 3.4;
      // 西部山地抬升: 滚丘 +8~12m, 平滑融入基础起伏
      const hd = Math.hypot(x + 220, z - 20);
      if (hd < 140) {
        const f = 1 - hd / 140;
        h += 11 * f * f * (0.65 + 0.7 * (fbm(n2, x * 0.03 + 3, z * 0.03 - 5, 2) * 0.5 + 0.5));
      }
      // 河流下切: z≈80 正弦蜿蜒, 河床没入水下(后于抬升, 先于一马平川)
      const rd = Math.abs(z - riverZAt(x));
      if (rd < 14) {
        const t = smoothstep(13, 5, rd); // 0 岸 → 1 河心
        h = h * (1 - t) + -1.6 * t;
      }
      return h;
    };

    // 填充高度栅格
    for (let iz = 0; iz <= GRID; iz++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = -WORLD_HALF + ix * CELL;
        const z = -WORLD_HALF + iz * CELL;
        this.heights[iz * (GRID + 1) + ix] = rawH(x, z);
      }
    }

    // 村庄规划 + 地基平整(必须在生成地形几何体之前)
    this.buildings.plan(this);
    this.gradeRoadTerrain();
    this.buildings.flattenTerrain(this);
    // 教堂与广场必须在地形网格生成前完成统一整地。此前广场按坡面最高点抬升，
    // 而教堂仍留在低处，广场地基因此直接封死了正门。
    this.prepareScenicSites();
    this.flattenChurchTerrain();
    let maxH = -100;
    for (let i = 0; i < this.heights.length; i++) {
      const h = this.heights[i] as number;
      if (h > maxH) maxH = h;
    }
    this.maxTerrainH = maxH + 1;

    // 地形网格 + 顶点色
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, GRID, GRID);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const cSand = new THREE.Color(0xd7c18a);
    const cSandWet = new THREE.Color(0x8f8972);
    const cGrassA = new THREE.Color(0x507f40);
    const cGrassB = new THREE.Color(0x76a34f);
    const cForest = new THREE.Color(0x456b47);
    const cDry = new THREE.Color(0x9a925b);
    const cRock = new THREE.Color(0x92938c);
    const cRoadBed = new THREE.Color(0x948267);
    const tmpC = new THREE.Color();
    const grassC = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.getHeight(x, z);
      pos.setY(i, h);
      const sx = (this.getHeight(x + CELL, z) - this.getHeight(x - CELL, z)) / (2 * CELL);
      const sz = (this.getHeight(x, z + CELL) - this.getHeight(x, z - CELL)) / (2 * CELL);
      const slope = Math.sqrt(sx * sx + sz * sz);
      const vary = n2.noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
      grassC.copy(cGrassA).lerp(cGrassB, vary);
      const pn = fbm(n1, x * 0.013 + 7, z * 0.013 - 3, 3);
      const forestBias = smoothstep(-118, -250, z) * (0.72 + vary * 0.28);
      const dryBias = smoothstep(0.08, 0.48, pn) * (1 - forestBias * 0.75);
      const surface = terrainSurfaceWeights(
        h, slope, WATER_Y, Math.abs(z - riverZAt(x)), forestBias, dryBias,
      );
      tmpC.setRGB(
        cSandWet.r * surface.wetSand + cSand.r * surface.sand + grassC.r * surface.meadow +
          cForest.r * surface.forest + cDry.r * surface.dryGrass + cRock.r * surface.rock,
        cSandWet.g * surface.wetSand + cSand.g * surface.sand + grassC.g * surface.meadow +
          cForest.g * surface.forest + cDry.g * surface.dryGrass + cRock.g * surface.rock,
        cSandWet.b * surface.wetSand + cSand.b * surface.sand + grassC.b * surface.meadow +
          cForest.b * surface.forest + cDry.b * surface.dryGrass + cRock.b * surface.rock,
      );
      // 路面下方同步铺一层土色路基。即使远距离深度精度下降或道路三角边缘露出，
      // 看到的也会是同色路肩而不是突兀的绿色草地碎片。
      if (h >= WATER_Y + 0.18) {
        const roadBed = 1 - smoothstep(3.4, 3.78, this.roadDistanceAt(x, z));
        if (roadBed > 0) tmpC.lerp(cRoadBed, roadBed * 0.96);
      }
      // 逐顶点确定性抖动, 打散色带
      const jh = Math.sin(i * 12.9898) * 43758.5453;
      const j = 1 + (jh - Math.floor(jh) - 0.5) * 0.05;
      colors[i * 3] = tmpC.r * j;
      colors[i * 3 + 1] = tmpC.g * j;
      colors[i * 3 + 2] = tmpC.b * j;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
    });
    const terrainWetU = { value: 0 };
    const terrainCloudU = { value: 0.18 };
    const terrainTimeU = this.timeU;
    terrainMat.userData.surfaceUniforms = {
      wetness: terrainWetU,
      cloudiness: terrainCloudU,
    };
    terrainMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = terrainTimeU;
      shader.uniforms.uWetness = terrainWetU;
      shader.uniforms.uCloudiness = terrainCloudU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorld;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vTerrainWorld = worldPosition.xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uTime;
uniform float uWetness;
uniform float uCloudiness;
varying vec3 vTerrainWorld;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  // 小尺度颜色起伏打散大色块，大尺度缓慢云影让晴天和阴雨天拥有不同地表层次。
  float terrainFine = sin(vTerrainWorld.x * 1.73 + sin(vTerrainWorld.z * 0.91))
    * cos(vTerrainWorld.z * 2.11 - vTerrainWorld.x * 0.47) * 0.5 + 0.5;
  float cloudWave = sin(vTerrainWorld.x * 0.012 + uTime * 0.018)
    + cos(vTerrainWorld.z * 0.015 - uTime * 0.014)
    + sin((vTerrainWorld.x + vTerrainWorld.z) * 0.007 + uTime * 0.009);
  float cloudMask = smoothstep(0.12, 1.3, cloudWave);
  float wetNoise = sin(vTerrainWorld.x * 0.43 + vTerrainWorld.z * 0.19)
    * cos(vTerrainWorld.z * 0.37 - vTerrainWorld.x * 0.11) * 0.5 + 0.5;
  float wetPatch = smoothstep(0.36, 0.82, wetNoise);
  float terrainMacro = sin(vTerrainWorld.x * 0.038 + sin(vTerrainWorld.z * 0.017) * 1.7)
    * cos(vTerrainWorld.z * 0.031 - vTerrainWorld.x * 0.009) * 0.5 + 0.5;
  float erosionGrain = smoothstep(0.84, 0.98,
    sin(vTerrainWorld.x * 0.19 + vTerrainWorld.z * 0.07) * 0.5 + 0.5);
  diffuseColor.rgb *= 0.955 + terrainFine * 0.055 + terrainMacro * 0.035;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.9, 0.91, 0.86), erosionGrain * 0.09);
  diffuseColor.rgb *= 1.0 - uCloudiness * cloudMask * 0.085;
  diffuseColor.rgb *= 1.0 - uWetness * wetPatch * 0.1;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.54, uWetness * wetPatch * 0.62);`,
        );
    };
    terrainMat.customProgramCacheKey = () => 'terrain-biome-surface-weather-v2';
    applySurfaceAsset(terrainMat, 'terrain', 0.065, 0.72);
    const terrain = new THREE.Mesh(geo, terrainMat);
    terrain.receiveShadow = true;
    scene.add(terrain);

    // 水面(高光 + 顶点波浪 + 法线微扰)
    const waterMat = new THREE.MeshPhongMaterial({
      color: 0x2c7898,
      specular: 0xbde8ef,
      shininess: 110,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
    });
    const timeU = this.timeU;
    const rainU = { value: 0 };
    waterMat.userData.rainUniform = rainU;
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.uniforms.uRain = rainU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uRain;\nvarying vec2 vWaterPos;')
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
  objectNormal = normalize(objectNormal + vec3(
    0.026 * cos(position.x * 0.05 + uTime * 0.8),
    0.026 * sin(position.y * 0.07 + uTime * 0.6),
    0.0));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  vWaterPos = position.xy;
  // 只向下波动(峰值 ≤ 0): 波峰永不越过水线, 避免在略高于水面的浅滩上"涨"出蓝色假水面
  transformed.z += (sin(position.x * 0.08 + uTime * 1.2) + cos(position.y * 0.06 + uTime * 0.9)) * 0.022 - 0.045;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uRain;\nvarying vec2 vWaterPos;')
        .replace(
          '#include <dithering_fragment>',
          `float waterBand = sin(vWaterPos.x * 0.11 + uTime * 0.9) * cos(vWaterPos.y * 0.085 - uTime * 0.72);
  float crossBand = sin((vWaterPos.x + vWaterPos.y) * 0.058 - uTime * 0.54)
    * cos((vWaterPos.x - vWaterPos.y) * 0.072 + uTime * 0.68);
  vec2 rainGrid = floor(vWaterPos * 0.19);
  vec2 rainCell = fract(vWaterPos * 0.19) - 0.5;
  float rainSeed = fract(sin(dot(rainGrid, vec2(12.9898, 78.233))) * 43758.5453);
  float rainRipple = smoothstep(0.15, 0.0, abs(length(rainCell) - fract(uTime * 0.72 + rainSeed) * 0.15));
  float waterFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
  float riverCenter = 80.0 + 22.0 * sin(vWaterPos.x * 0.012 + 1.3);
  float riverEdge = 1.0 - smoothstep(0.0, 5.5, abs(abs(vWaterPos.y - riverCenter) - 11.0));
  float coastEdge = 1.0 - smoothstep(0.0, 44.0, abs(length(vWaterPos) - 270.0));
  float shallowWater = clamp(max(riverEdge, coastEdge * 0.72), 0.0, 1.0);
  float foamTrace = smoothstep(0.68, 0.94, waterBand * 0.5 + crossBand * 0.5) * shallowWater;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.22, 0.53, 0.57), shallowWater * 0.16);
  gl_FragColor.rgb += vec3(0.035, 0.075, 0.085) * smoothstep(0.6, 0.98, waterBand);
  gl_FragColor.rgb += vec3(0.025, 0.055, 0.072) * smoothstep(0.7, 0.98, crossBand);
  gl_FragColor.rgb += vec3(0.065, 0.105, 0.125) * waterFresnel * 0.55;
  gl_FragColor.rgb += vec3(0.08, 0.11, 0.13) * rainRipple * uRain * 0.55;
  gl_FragColor.rgb += vec3(0.16, 0.2, 0.19) * foamTrace * 0.32;
  #include <dithering_fragment>`,
        );
    };
    waterMat.customProgramCacheKey = () => 'water-depth-foam-rain-v5';
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800, 72, 72), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_Y;
    scene.add(water);

    // 天空 / 雾 / 光照(雾色与天穹地平线一致; 金色暖阳)
    const fog = new THREE.Fog(0xd9d9c9, 175, 665);
    scene.fog = fog;
    const hemi = new THREE.HemisphereLight(0xddebf8, 0x68704d, 0.92);
    scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffddb0, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE);
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 280;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 2;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.sky = new Sky(scene);
    this.environment = new EnvironmentSystem(scene, this.sky, this.sun, hemi, fog, terrainMat, waterMat);

    this.buildStatics(scene);
    for (const platform of this.platforms) {
      this.platformGrid.insert(platform, platform.minX, platform.minZ, platform.maxX, platform.maxZ);
    }
  }

  // 把矩形内地形压平到 h, 边缘 margin 内平滑过渡(作用于高度栅格)
  flattenRect(minX: number, minZ: number, maxX: number, maxZ: number, h: number, margin: number): void {
    const W = GRID + 1;
    for (let iz = 0; iz <= GRID; iz++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = -WORLD_HALF + ix * CELL;
        const z = -WORLD_HALF + iz * CELL;
        if (x < minX - margin || x > maxX + margin || z < minZ - margin || z > maxZ + margin) continue;
        const dx = Math.max(minX - x, 0, x - maxX);
        const dz = Math.max(minZ - z, 0, z - maxZ);
        const dist = Math.hypot(dx, dz);
        const idx = iz * W + ix;
        if (dist <= 0.001) {
          this.heights[idx] = h;
        } else {
          const t = smoothstep(0, margin, dist);
          this.heights[idx] = h + ((this.heights[idx] as number) - h) * t;
        }
      }
    }
  }

  // 道路先在高度场上整形，再生成地形和路面。中心车道沿控制点做线性缓坡，
  // 两侧逐渐混回自然地形，避免道路沿噪声地表起伏成碎折面。
  private gradeRoadTerrain(): void {
    const original = this.heights.slice();
    const width = GRID + 1;
    const sample = (x: number, z: number): number => {
      const gx = clamp((x + WORLD_HALF) / CELL, 0, GRID - 0.0001);
      const gz = clamp((z + WORLD_HALF) / CELL, 0, GRID - 0.0001);
      const ix = gx | 0;
      const iz = gz | 0;
      const fx = gx - ix;
      const fz = gz - iz;
      const h00 = original[iz * width + ix] as number;
      const h10 = original[iz * width + ix + 1] as number;
      const h01 = original[(iz + 1) * width + ix] as number;
      const h11 = original[(iz + 1) * width + ix + 1] as number;
      return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
    };
    const segments = ROAD_PATHS.flatMap((path) => path.slice(0, -1).map((a, index) => {
      const b = path[index + 1] as readonly [number, number];
      return { a, b, ah: sample(a[0], a[1]), bh: sample(b[0], b[1]) };
    }));
    const coreRadius = 3.75;
    const blendRadius = 7.25;
    for (let iz = 0; iz <= GRID; iz++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = -WORLD_HALF + ix * CELL;
        const z = -WORLD_HALF + iz * CELL;
        const index = iz * width + ix;
        const current = original[index] as number;
        if (current < WATER_Y + 0.18) continue;
        let nearest = Infinity;
        let target = current;
        for (const segment of segments) {
          const vx = segment.b[0] - segment.a[0];
          const vz = segment.b[1] - segment.a[1];
          const len2 = vx * vx + vz * vz;
          const t = clamp(((x - segment.a[0]) * vx + (z - segment.a[1]) * vz) / len2, 0, 1);
          const px = segment.a[0] + vx * t;
          const pz = segment.a[1] + vz * t;
          const distance = Math.hypot(x - px, z - pz);
          if (distance >= nearest) continue;
          nearest = distance;
          target = segment.ah + (segment.bh - segment.ah) * t;
        }
        if (nearest >= blendRadius || target < WATER_Y + 0.18) continue;
        const blend = nearest <= coreRadius
          ? 1
          : 1 - smoothstep(coreRadius, blendRadius, nearest);
        this.heights[index] = current + (target - current) * blend;
      }
    }
  }

  // 双线性插值地形高度
  getHeight(x: number, z: number): number {
    const gx = clamp((x + WORLD_HALF) / CELL, 0, GRID - 0.0001);
    const gz = clamp((z + WORLD_HALF) / CELL, 0, GRID - 0.0001);
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const W = GRID + 1;
    const h00 = this.heights[iz * W + ix] as number;
    const h10 = this.heights[iz * W + ix + 1] as number;
    const h01 = this.heights[(iz + 1) * W + ix] as number;
    const h11 = this.heights[(iz + 1) * W + ix + 1] as number;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  private slopeAt(x: number, z: number): number {
    const sx = (this.getHeight(x + 2, z) - this.getHeight(x - 2, z)) / 4;
    const sz = (this.getHeight(x, z + 2) - this.getHeight(x, z - 2)) / 4;
    return Math.sqrt(sx * sx + sz * sz);
  }

  addCollider(c: Collider): void {
    this.colliders.push(c);
    if (c.kind === 'cyl') {
      this.cyls.push(c);
      this.cylinderGrid.insert(
        c,
        c.x - c.r,
        c.z - c.r,
        c.x + c.r,
        c.z + c.r,
        COLLISION_QUERY_PADDING,
      );
    } else {
      this.aabbs.push(c);
      this.aabbGrid.insert(c, c.minX, c.minZ, c.maxX, c.maxZ, COLLISION_QUERY_PADDING);
    }
  }

  removeCollider(c: Collider): boolean {
    const colliderIndex = this.colliders.indexOf(c);
    if (colliderIndex < 0) return false;
    this.colliders.splice(colliderIndex, 1);
    if (c.kind === 'cyl') {
      const cylinderIndex = this.cyls.indexOf(c);
      if (cylinderIndex >= 0) this.cyls.splice(cylinderIndex, 1);
      this.cylinderGrid.remove(c);
    } else {
      const boxIndex = this.aabbs.indexOf(c);
      if (boxIndex >= 0) this.aabbs.splice(boxIndex, 1);
      this.aabbGrid.remove(c);
    }
    return true;
  }

  addPlatform(platform: Platform): void {
    this.platforms.push(platform);
    this.platformGrid.insert(platform, platform.minX, platform.minZ, platform.maxX, platform.maxZ);
  }

  removePlatform(platform: Platform): boolean {
    const index = this.platforms.indexOf(platform);
    if (index < 0) return false;
    this.platforms.splice(index, 1);
    this.platformGrid.remove(platform);
    return true;
  }

  // 点是否落在任一房屋地块内(含 margin)
  inPlot(x: number, z: number, margin: number): boolean {
    for (const p of this.buildings.plots) {
      if (x > p.minX - margin && x < p.maxX + margin && z > p.minZ - margin && z < p.maxZ + margin) return true;
    }
    return false;
  }

  // 点是否落在任一灌木足迹内(隐蔽判定, 线性扫描 ~300 项成本可忽略)
  inBush(x: number, z: number): boolean {
    for (const b of this.bushes) {
      const dx = x - b.x;
      const dz = z - b.z;
      if (dx * dx + dz * dz < b.r * b.r) return true;
    }
    return false;
  }

  private buildStatics(scene: THREE.Scene): void {
    this.assetUsage.clear();
    const rng = mulberry32(424242);
    const naturalBudget = naturalDetailBudget(navigator.hardwareConcurrency);
    const m4 = new THREE.Matrix4();
    const q0 = new THREE.Quaternion();
    const vPos = new THREE.Vector3();
    const vScale = new THREE.Vector3();

    // ---- 房屋村庄(先生成, 树木岩石随后避开) ----
    this.buildings.build(scene, this);
    this.addRoadNetwork(scene);
    this.addRoadTermini(scene);
    this.assetUsage.add('map.infrastructure.road', ROAD_PATHS.reduce((total, path) => total + Math.max(0, path.length - 1), 0));
    this.addDistantLandforms(scene);

    // ---- 树木(四种树冠轮廓, 北境密林加密, 草原保留疏林层次) ----
    const treeCap = 600;
    const upY = new THREE.Vector3(0, 1, 0);
    const trunkMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true,
      emissive: 0x70472b, emissiveIntensity: 0.5,
    });
    applySurfaceAsset(trunkMat, 'wood', 3.6, 0.58);
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.34, 3.4, 10, 2),
      trunkMat,
      treeCap * 2, // 两段收分树干
    );
    const canopyMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, flatShading: false, vertexColors: true,
      emissive: 0x173d20, emissiveIntensity: 0.22,
    });
    const broadMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, flatShading: false, vertexColors: true,
      emissive: 0x23491f, emissiveIntensity: 0.24,
    });
    applySurfaceAsset(canopyMat, 'foliage', 4.8, 0.52);
    applySurfaceAsset(broadMat, 'foliage', 4.2, 0.56);
    const canopyMesh = new THREE.InstancedMesh(makePineCanopyGeometry(), canopyMat, treeCap);
    const columnarMesh = new THREE.InstancedMesh(makeColumnarPineCanopyGeometry(), canopyMat, treeCap);
    const broadMesh = new THREE.InstancedMesh(makeBroadleafCrownGeometry(), broadMat, treeCap);
    const windMesh = new THREE.InstancedMesh(makeWindshapedCrownGeometry(), broadMat, treeCap);
    // 枝丫残桩(小斜枝)
    const branchMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.04, 0.085, 0.88, 7),
      new THREE.MeshLambertMaterial({ color: 0x765136, emissive: 0x4a301e, emissiveIntensity: 0.42 }),
      treeCap * 3,
    );
    const rootGeometry = new THREE.CapsuleGeometry(0.062, 0.74, 2, 7);
    rootGeometry.rotateX(Math.PI * 0.5);
    const rootMesh = new THREE.InstancedMesh(
      rootGeometry,
      new THREE.MeshLambertMaterial({ color: 0x65452d, emissive: 0x382416, emissiveIntensity: 0.3 }),
      treeCap * 3,
    );
    this.addSway(canopyMat, 0.09, -2.0, 2.5);
    this.addSway(broadMat, 0.09, -1.5, 2.0);
    // 树干位于闭合树冠内部时不投射阴影, 避免阴影贴图穿到树冠正面形成黑色矩形.
    trunkMesh.castShadow = false;
    canopyMesh.castShadow = true;
    columnarMesh.castShadow = true;
    broadMesh.castShadow = true;
    windMesh.castShadow = true;
    branchMesh.castShadow = false;
    rootMesh.castShadow = true;
    rootMesh.receiveShadow = true;
    const placedPts: number[] = [];
    const canopyC = new THREE.Color();
    let pineCount = 0;
    let columnarCount = 0;
    let broadCount = 0;
    let windCount = 0;
    let treeCount = 0;
    const tryTree = (x: number, z: number): boolean => {
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.8 || h > 15.5 || this.slopeAt(x, z) > 0.66) return false;
      if (this.inPlot(x, z, 2.5) || this.inScenicSite(x, z, 2) || this.nearRoad(x, z, 2.5)) return false;
      for (let i = 0; i < placedPts.length; i += 2) {
        const dx = x - (placedPts[i] as number);
        const dz = z - (placedPts[i + 1] as number);
        if (dx * dx + dz * dz < 8.4) return false;
      }
      placedPts.push(x, z);
      const s = 0.8 + rng() * 0.55;
      q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
      const treeKind = rng();
      let visualKind: TreeVisualKind;
      if (treeKind < 0.58) {
        // 松树: 双段树干 + 多团闭合枝叶
        vPos.set(x, h + 1.4 * s, z);
        vScale.set(s, s * 0.82, s);
        m4.compose(vPos, q0, vScale);
        trunkMesh.setMatrixAt(treeCount * 2, m4);
        canopyC.setRGB(0.58 + rng() * 0.08, 0.39 + rng() * 0.06, 0.23 + rng() * 0.04);
        trunkMesh.setColorAt(treeCount * 2, canopyC);
        // 上段细干(伸入树冠)
        vPos.set(x, h + 2.72 * s, z);
        vScale.set(s * 0.58, s * 0.34, s * 0.58);
        m4.compose(vPos, q0, vScale);
        trunkMesh.setMatrixAt(treeCount * 2 + 1, m4);
        trunkMesh.setColorAt(treeCount * 2 + 1, canopyC);
        // 单个松冠几何内部已经包含四层枝盘，缩短整体高度并露出真实树干比例。
        const columnar = treeKind >= 0.38;
        visualKind = columnar ? 'columnar' : 'pine';
        vPos.set(x, h, z);
        vScale.set(
          s * (columnar ? 1.92 : 2.02),
          s * (columnar ? 7.45 : 6.75),
          s * (columnar ? 1.92 : 2.02),
        );
        m4.compose(vPos, q0, vScale);
        const pineMesh = columnar ? columnarMesh : canopyMesh;
        const pineIndex = columnar ? columnarCount : pineCount;
        pineMesh.setMatrixAt(pineIndex, m4);
        const pineTone = 0.88 + rng() * 0.17;
        canopyC.setHex(columnar ? 0x225d40 : 0x34763a).multiplyScalar(pineTone);
        pineMesh.setColorAt(pineIndex, canopyC);
        if (columnar) columnarCount++;
        else pineCount++;
      } else {
        // 阔叶: 双段树干 + 合并式五团块面树冠
        const st = s * 0.75;
        vPos.set(x, h + 1.7 * st, z);
        vScale.set(s, st, s);
        m4.compose(vPos, q0, vScale);
        trunkMesh.setMatrixAt(treeCount * 2, m4);
        canopyC.setRGB(0.55 + rng() * 0.08, 0.37 + rng() * 0.05, 0.22 + rng() * 0.04);
        trunkMesh.setColorAt(treeCount * 2, canopyC);
        vPos.set(x, h + 3.9 * st, z);
        vScale.set(s * 0.6, st * 0.55, s * 0.6);
        m4.compose(vPos, q0, vScale);
        trunkMesh.setMatrixAt(treeCount * 2 + 1, m4);
        trunkMesh.setColorAt(treeCount * 2 + 1, canopyC);
        const windshaped = treeKind >= 0.86;
        visualKind = windshaped ? 'windshaped' : 'broadleaf';
        const cs = s * (windshaped ? 1.05 : 1.15);
        const broadTone = 0.9 + rng() * 0.2;
        canopyC.setHex(windshaped ? 0x708535 : 0x467d3b).multiplyScalar(broadTone);
        vPos.set(x, h + 3.4 * st + 0.78 * cs, z);
        vScale.set(cs, cs, cs);
        m4.compose(vPos, q0, vScale);
        const leafMesh = windshaped ? windMesh : broadMesh;
        const leafIndex = windshaped ? windCount : broadCount;
        leafMesh.setMatrixAt(leafIndex, m4);
        leafMesh.setColorAt(leafIndex, canopyC);
        if (windshaped) windCount++;
        else broadCount++;
      }
      this.treeVisualSamples.push({ kind: visualKind, x, z });
      // 三组中下段枝干连接树干和树冠，近景不会只剩一根直柱。
      for (let bi = 0; bi < 3; bi++) {
        const ba = rng() * Math.PI * 2;
        q0.setFromEuler(new THREE.Euler(0.5 + rng() * 0.4, ba, 0));
        vPos.set(x + Math.sin(ba) * 0.3 * s, h + (1.9 + bi * 0.9) * s, z + Math.cos(ba) * 0.3 * s);
        vScale.set(s, s, s);
        m4.compose(vPos, q0, vScale);
        branchMesh.setMatrixAt(treeCount * 3 + bi, m4);
      }
      // 三向根系贴住地面，消除树干像插在地表上的感觉。
      for (let ri = 0; ri < 3; ri++) {
        const ra = rng() * 0.45 + ri * Math.PI * 2 / 3;
        q0.setFromEuler(new THREE.Euler(0, ra, 0.08));
        vPos.set(x + Math.sin(ra) * 0.4 * s, h + 0.075 * s, z + Math.cos(ra) * 0.4 * s);
        vScale.set(s * (0.8 + rng() * 0.25), s, s * (0.8 + rng() * 0.35));
        m4.compose(vPos, q0, vScale);
        rootMesh.setMatrixAt(treeCount * 3 + ri, m4);
      }
      treeCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 0.42 * s, y0: h - 0.5, y1: h + 3.4 * s, tag: 'tree' });
      return true;
    };
    // 先撒密林加密树(z<-150 带状), 再全图散布
    for (let t = 0; t < 2200 && treeCount < 170; t++) {
      tryTree((rng() * 2 - 1) * 320, -160 - rng() * 170);
    }
    for (let t = 0; t < 6200 && treeCount < treeCap; t++) {
      tryTree((rng() * 2 - 1) * 330, (rng() * 2 - 1) * 330);
    }
    trunkMesh.count = treeCount * 2;
    canopyMesh.count = pineCount;
    columnarMesh.count = columnarCount;
    broadMesh.count = broadCount;
    windMesh.count = windCount;
    branchMesh.count = treeCount * 3;
    rootMesh.count = treeCount * 3;
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    columnarMesh.instanceMatrix.needsUpdate = true;
    broadMesh.instanceMatrix.needsUpdate = true;
    windMesh.instanceMatrix.needsUpdate = true;
    branchMesh.instanceMatrix.needsUpdate = true;
    rootMesh.instanceMatrix.needsUpdate = true;
    if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    if (columnarMesh.instanceColor) columnarMesh.instanceColor.needsUpdate = true;
    if (broadMesh.instanceColor) broadMesh.instanceColor.needsUpdate = true;
    if (windMesh.instanceColor) windMesh.instanceColor.needsUpdate = true;
    trunkMesh.computeBoundingSphere();
    canopyMesh.computeBoundingSphere();
    columnarMesh.computeBoundingSphere();
    broadMesh.computeBoundingSphere();
    windMesh.computeBoundingSphere();
    branchMesh.computeBoundingSphere();
    rootMesh.computeBoundingSphere();
    scene.add(trunkMesh);
    scene.add(canopyMesh);
    scene.add(columnarMesh);
    scene.add(broadMesh);
    scene.add(windMesh);
    scene.add(branchMesh);
    scene.add(rootMesh);
    this.treeCount = treeCount;
    this.treeVariantCount = [pineCount, columnarCount, broadCount, windCount].filter((count) => count > 0).length;
    this.environmentDetailInstanceCount += rootMesh.count + branchMesh.count + treeCount;
    this.assetUsage.add('map.nature.tree.pine', pineCount + columnarCount);
    this.assetUsage.add('map.nature.tree.broadleaf', broadCount + windCount);

    // ---- 岩石(西部山地加密 + 全图稳定生成半身以上战术巨石) ----
    const rockCap = 300;
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x8f8f8b,
      roughness: 0.97,
      metalness: 0,
      flatShading: true,
    });
    applySurfaceAsset(rockMat, 'stone', 1.8, 0.72);
    const rockMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), rockMat, rockCap);
    const rockMesh2 = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, rockCap);
    const rockAccentMat = new THREE.MeshStandardMaterial({ color: 0x68774f, roughness: 1, flatShading: true });
    const rockAccentMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockAccentMat, rockCap);
    const screeMesh = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x777a74, roughness: 1, flatShading: true }),
      rockCap * naturalBudget.screePerRock,
    );
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    rockMesh2.castShadow = true;
    rockMesh2.receiveShadow = true;
    rockAccentMesh.receiveShadow = true;
    let rockCount = 0;
    let rockCount2 = 0;
    let screeCount = 0;
    let tacticalRockCount = 0;
    const tacticalRockPts: number[] = [];
    const tryRock = (x: number, z: number, tactical = false): boolean => {
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.3 || h > 15) return false;
      const s = tactical ? 1.75 + rng() * 0.95 : 0.7 + rng() * 1.7;
      const clearance = tactical ? 3.4 : 2.5;
      if (this.inPlot(x, z, clearance) || this.inScenicSite(x, z, tactical ? 2.4 : 1.5) ||
        this.nearRoad(x, z, tactical ? 2.4 : 0.8)) return false;
      if (!this.pointFree(x, z, Math.max(0.72, s), WATER_Y + 0.25, 16)) return false;
      if (tactical) {
        for (let i = 0; i < tacticalRockPts.length; i += 2) {
          const dx = x - (tacticalRockPts[i] as number);
          const dz = z - (tacticalRockPts[i + 1] as number);
          if (dx * dx + dz * dz < 64) return false;
        }
      }
      const sy = tactical ? 1.35 + rng() * 0.65 : s * (0.55 + rng() * 0.4);
      vPos.set(x, h + sy * 0.25, z);
      vScale.set(s * (0.8 + rng() * 0.5), sy, s * (0.8 + rng() * 0.5));
      q0.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4));
      m4.compose(vPos, q0, vScale);
      const g = 0.82 + rng() * 0.3;
      canopyC.setRGB(0.56 * g, 0.56 * g, 0.55 * g);
      if ((rockCount + rockCount2) % 2 === 0) {
        rockMesh.setMatrixAt(rockCount, m4);
        rockMesh.setColorAt(rockCount, canopyC);
        rockCount++;
      } else {
        rockMesh2.setMatrixAt(rockCount2, m4);
        rockMesh2.setColorAt(rockCount2, canopyC);
        rockCount2++;
      }
      // 扁平苔藓斑覆盖在向上的岩面，打破整块单色石头。
      vPos.set(x + (rng() - 0.5) * s * 0.18, h + sy * 0.72, z + (rng() - 0.5) * s * 0.18);
      vScale.set(s * (0.28 + rng() * 0.16), sy * 0.035, s * (0.24 + rng() * 0.14));
      q0.setFromEuler(new THREE.Euler(0, rng() * Math.PI * 2, 0));
      m4.compose(vPos, q0, vScale);
      rockAccentMesh.setMatrixAt(rockCount + rockCount2 - 1, m4);
      // 主岩周围生成同地质色系碎石, 让大石与坡地之间形成自然尺度过渡.
      for (let si = 0; si < naturalBudget.screePerRock; si++) {
        const angle = rng() * Math.PI * 2;
        const distance = s * (0.8 + rng() * 1.35);
        const sx = x + Math.cos(angle) * distance;
        const sz = z + Math.sin(angle) * distance;
        const sh = this.getHeight(sx, sz);
        const ss = 0.12 + rng() * 0.24;
        vPos.set(sx, sh + ss * 0.2, sz);
        vScale.set(ss * (1.1 + rng()), ss * (0.35 + rng() * 0.3), ss * (0.9 + rng() * 0.8));
        q0.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4));
        m4.compose(vPos, q0, vScale);
        screeMesh.setMatrixAt(screeCount++, m4);
      }
      this.addCollider({ kind: 'cyl', x, z, r: s * 0.92, y0: h - 1, y1: h + sy * 0.95, tag: 'rock' });
      this.naturalRocks.push({ x, z, r: s * 0.92 });
      if (tactical) {
        tacticalRockPts.push(x, z);
        tacticalRockCount++;
      }
      return true;
    };
    // 山地加密岩
    for (let t = 0; t < 1100 && rockCount + rockCount2 < 90; t++) {
      tryRock(-220 + (rng() * 2 - 1) * 120, 20 + (rng() * 2 - 1) * 120);
    }
    // 开阔区保底布置可挡住上半身的巨石, 兼顾交火推进和载具绕行空间.
    for (let t = 0; t < 5000 && tacticalRockCount < 72 && rockCount + rockCount2 < rockCap; t++) {
      tryRock((rng() * 2 - 1) * 325, (rng() * 2 - 1) * 325, true);
    }
    for (let t = 0; t < 3600 && rockCount + rockCount2 < rockCap; t++) {
      tryRock((rng() * 2 - 1) * 330, (rng() * 2 - 1) * 330);
    }
    rockMesh.count = rockCount;
    rockMesh2.count = rockCount2;
    rockMesh.instanceMatrix.needsUpdate = true;
    rockMesh2.instanceMatrix.needsUpdate = true;
    rockAccentMesh.count = rockCount + rockCount2;
    screeMesh.count = screeCount;
    rockAccentMesh.instanceMatrix.needsUpdate = true;
    screeMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    if (rockMesh2.instanceColor) rockMesh2.instanceColor.needsUpdate = true;
    rockMesh.computeBoundingSphere();
    rockMesh2.computeBoundingSphere();
    rockAccentMesh.computeBoundingSphere();
    screeMesh.computeBoundingSphere();
    scene.add(rockMesh);
    scene.add(rockMesh2);
    scene.add(rockAccentMesh);
    scene.add(screeMesh);
    this.environmentDetailInstanceCount += rockAccentMesh.count + screeMesh.count;
    this.naturalGroundDetailCount += screeMesh.count;
    this.tacticalRockCount = tacticalRockCount;
    this.assetUsage.add('map.nature.rock', rockCount + rockCount2);

    // ---- 灌木丛(无碰撞体: 子弹/移动均可穿过, 供隐蔽判定; 密林加密) ----
    const bushCap = 680;
    const bushGeo = new THREE.IcosahedronGeometry(1, 1);
    const BUSH_COLORS = [0x2f5c2a, 0x3f7a33, 0x5c6e2e, 0x8a9438];
    const bushMeshes: THREE.InstancedMesh[] = [];
    for (let layer = 0; layer < 4; layer++) {
      const bm = new THREE.MeshLambertMaterial({ color: 0xffffff });
      this.addSway(bm, 0.07, -1.0, 1.2, true, false, 180, 200);
      const mesh = new THREE.InstancedMesh(bushGeo, bm, bushCap);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      bushMeshes.push(mesh);
      scene.add(mesh);
    }
    const bushStemMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.035, 0.055, 0.9, 5),
      new THREE.MeshLambertMaterial({ color: 0x51432a }),
      bushCap * 3,
    );
    bushStemMesh.castShadow = true;
    scene.add(bushStemMesh);
    const bushPts: number[] = [];
    let bushCount = 0;
    const tryBush = (x: number, z: number): boolean => {
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.5 || h > 15.8 || this.slopeAt(x, z) > 0.58) return false;
      if (this.inPlot(x, z, 2.5) || this.inScenicSite(x, z, 1.2) || this.nearRoad(x, z, 1.2)) return false;
      const s = 0.72 + rng() * 0.5; // 半身遮蔽高度, 保持无碰撞可穿行
      if (!this.pointFree(x, z, s, WATER_Y + 0.25, 16)) return false;
      for (let i = 0; i < bushPts.length; i += 2) {
        const dx = x - (bushPts[i] as number);
        const dz = z - (bushPts[i + 1] as number);
        if (dx * dx + dz * dz < 8.2) return false;
      }
      bushPts.push(x, z);
      const colorIdx = Math.floor(rng() * BUSH_COLORS.length);
      const q2 = new THREE.Quaternion().setFromAxisAngle(upY, rng() * Math.PI * 2);
      for (let layer = 0; layer < 4; layer++) {
        const ls = s * (layer === 0 ? 1 : layer === 1 ? 0.76 : layer === 2 ? 0.62 : 0.48);
        const lx = x + (layer === 1 ? 0.38 * s : layer === 2 ? -0.34 * s : layer === 3 ? 0.04 * s : 0);
        const lz = z + (layer === 1 ? 0.22 * s : layer === 2 ? -0.2 * s : layer === 3 ? -0.4 * s : 0);
        const ly = h + (layer === 0 ? 0.48 : layer === 1 ? 0.6 : layer === 2 ? 0.72 : 0.84) * s;
        vPos.set(lx, ly, lz);
        vScale.set(ls, ls * 0.75, ls);
        m4.compose(vPos, q2, vScale);
        const mesh = bushMeshes[layer] as THREE.InstancedMesh;
        mesh.setMatrixAt(bushCount, m4);
        canopyC.setHex(BUSH_COLORS[colorIdx] as number).multiplyScalar(0.85 + rng() * 0.3);
        mesh.setColorAt(bushCount, canopyC);
      }
      for (let stem = 0; stem < 3; stem++) {
        const sa = rng() * Math.PI * 2;
        q0.setFromEuler(new THREE.Euler(stem === 0 ? 0.14 : -0.18, sa, 0));
        vPos.set(x + Math.sin(sa) * 0.12 * s, h + 0.38 * s, z + Math.cos(sa) * 0.12 * s);
        vScale.set(s, s, s);
        m4.compose(vPos, q0, vScale);
        bushStemMesh.setMatrixAt(bushCount * 3 + stem, m4);
      }
      this.bushes.push({ x, z, r: s * 1.5 });
      bushCount++;
      return true;
    };
    // 密林加密灌木(z<-150)
    for (let t = 0; t < 1800 && bushCount < 180; t++) {
      tryBush((rng() * 2 - 1) * 320, -160 - rng() * 170);
    }
    for (let t = 0; t < bushCap * 8 && bushCount < bushCap; t++) {
      tryBush((rng() * 2 - 1) * 330, (rng() * 2 - 1) * 330);
    }
    for (const mesh of bushMeshes) {
      mesh.count = bushCount;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    bushStemMesh.count = bushCount * 3;
    bushStemMesh.instanceMatrix.needsUpdate = true;
    bushStemMesh.computeBoundingSphere();
    this.halfBushCount = bushCount;
    this.environmentDetailInstanceCount += bushStemMesh.count + bushCount * bushMeshes.length;
    this.naturalGroundDetailCount += bushCount * bushMeshes.length;
    this.assetUsage.add('map.nature.bush', bushCount);

    // ---- 草丛(纯装饰: 无碰撞体, 不挡子弹/视线) ----
    const grassCap = naturalBudget.grass;
    const grassGeo = makeGrassGeo();
    const grassMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.addSway(grassMat, 0.06, 0.0, 0.55, true, true);
    const forestGrassCap = 1600;
    const grassMesh = new THREE.InstancedMesh(grassGeo, grassMat, grassCap + forestGrassCap);
    grassMesh.receiveShadow = true;
    const cG1 = new THREE.Color(0x5e9440); // 与地形草地同管线(sRGB→线性)
    const cG2 = new THREE.Color(0xa8ad5e);
    let grassCount = 0;
    for (let t = 0; t < grassCap * 4 && grassCount < grassCap; t++) {
      // 按簇散布: 每簇 8-14 丛, 形成连续草坪和自然疏密边缘.
      const cx = (rng() * 2 - 1) * 330;
      const cz = (rng() * 2 - 1) * 330;
      const ch = this.getHeight(cx, cz);
      if (ch < WATER_Y + 0.4 || ch > 16.2 || this.slopeAt(cx, cz) > 0.64) continue;
      if (this.inPlot(cx, cz, 1.5) || this.inScenicSite(cx, cz, 0.4) || this.nearRoad(cx, cz, 0.25)) continue;
      const n = 8 + Math.floor(rng() * 7);
      for (let k = 0; k < n && grassCount < grassCap; k++) {
        const x = cx + (rng() * 2 - 1) * 3.4;
        const z = cz + (rng() * 2 - 1) * 3.4;
        const h = this.getHeight(x, z);
        if (h < WATER_Y + 0.4 || h > 16.2 || this.slopeAt(x, z) > 0.64) continue;
        if (this.inPlot(x, z, 1.5) || this.inScenicSite(x, z, 0.4) || this.nearRoad(x, z, 0.25)) continue;
        const tallPatch = rng() > 0.78;
        const s = tallPatch ? 0.92 + rng() * 0.38 : 0.52 + rng() * 0.42;
        vPos.set(x, h - 0.02, z);
        vScale.set(s, s, s);
        q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
        m4.compose(vPos, q0, vScale);
        grassMesh.setMatrixAt(grassCount, m4);
        const gy = rng();
        canopyC.copy(cG1).lerp(cG2, gy * gy); // 绿→干黄, 偏绿居多
        grassMesh.setColorAt(grassCount, canopyC);
        grassCount++;
      }
    }
    grassMesh.count = grassCount;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    grassMesh.computeBoundingSphere();
    scene.add(grassMesh);

    // 密林下植被加密草(z<-150 带状, 下植被感)
    let forestGrass = 0;
    for (let t = 0; t < 9000 && forestGrass < forestGrassCap; t++) {
      const x = (rng() * 2 - 1) * 320;
      const z = -160 - rng() * 170;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.4 || h > 16.2 || this.slopeAt(x, z) > 0.64) continue;
      if (this.inPlot(x, z, 1.5) || this.inScenicSite(x, z, 0.4) || this.nearRoad(x, z, 0.25)) continue;
      const s = 0.68 + rng() * 0.5;
      vPos.set(x, h - 0.02, z);
      vScale.set(s, s, s);
      q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
      m4.compose(vPos, q0, vScale);
      grassMesh.setMatrixAt(grassCount + forestGrass, m4);
      canopyC.copy(cG1).lerp(cG2, rng() * rng());
      grassMesh.setColorAt(grassCount + forestGrass, canopyC);
      forestGrass++;
    }
    grassMesh.count = grassCount + forestGrass;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    this.grassPatchCount = grassMesh.count;
    this.naturalGroundDetailCount += grassMesh.count;
    this.environmentDetailInstanceCount += grassMesh.count;
    this.assetUsage.add('map.nature.grass', grassMesh.count);

    this.addGroundEcology(scene);
    this.addNaturalStoryProps(scene);

    // ---- 农田作物行(南部农场, 黄绿短苗, 纯装饰) ----
    const cropGeo = makeGrassGeo();
    const cropMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.addSway(cropMat, 0.06, 0.0, 0.55, true, true);
    const cropCap = 1500;
    const cropMesh = new THREE.InstancedMesh(cropGeo, cropMat, cropCap);
    cropMesh.receiveShadow = true;
    const cropC = new THREE.Color();
    let cropCount = 0;
    for (let rz = -18; rz <= 18 && cropCount < cropCap; rz += 2.4) {
      for (let rx = -26; rx <= 26 && cropCount < cropCap; rx += 0.95) {
        const x = -40 + rx + (rng() * 2 - 1) * 0.2;
        const z = 195 + rz + (rng() * 2 - 1) * 0.2;
        const h = this.getHeight(x, z);
        if (h < WATER_Y + 0.4 || h > 12 || this.slopeAt(x, z) > 0.5) continue;
        if (this.inPlot(x, z, 1.2)) continue;
        const s = 0.6 + rng() * 0.3;
        vPos.set(x, h - 0.02, z);
        vScale.set(s, s * 1.15, s);
        q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
        m4.compose(vPos, q0, vScale);
        cropMesh.setMatrixAt(cropCount, m4);
        cropC.setHex(0x8fa540).lerp(new THREE.Color(0xb5b048), rng());
        cropMesh.setColorAt(cropCount, cropC);
        cropCount++;
      }
    }
    cropMesh.count = cropCount;
    cropMesh.instanceMatrix.needsUpdate = true;
    if (cropMesh.instanceColor) cropMesh.instanceColor.needsUpdate = true;
    cropMesh.computeBoundingSphere();
    scene.add(cropMesh);
    this.assetUsage.add('map.nature.crop', cropCount);

    // ---- 干草捆(农场掩体, 圆柱碰撞) + 捆扎带 ----
    const baleMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.05, 1.05, 1.5, 10),
      new THREE.MeshLambertMaterial({ color: 0xc2a54e }),
      14,
    );
    const strapMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.26, 0.16, 2.26),
      new THREE.MeshLambertMaterial({ color: 0x7a6434 }),
      28,
    );
    baleMesh.castShadow = true;
    baleMesh.receiveShadow = true;
    strapMesh.castShadow = true;
    let baleCount = 0;
    for (let t = 0; t < 300 && baleCount < 12; t++) {
      const x = -40 + (rng() * 2 - 1) * 85;
      const z = 200 + (rng() * 2 - 1) * 85;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.4 || h > 12 || this.slopeAt(x, z) > 0.5) continue;
      if (this.inPlot(x, z, 1.5)) continue;
      if (!this.pointFree(x, z, 1.12, WATER_Y + 0.25, 16)) continue;
      if (this.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r + 1.12)) continue;
      const ba = rng() * Math.PI;
      vPos.set(x, h + 1.02, z);
      vScale.set(1, 1, 1);
      q0.setFromEuler(new THREE.Euler(Math.PI / 2, 0, ba));
      m4.compose(vPos, q0, vScale);
      baleMesh.setMatrixAt(baleCount, m4);
      // 两道捆扎带(沿卧捆轴向 ±0.45)
      const axX = -Math.sin(ba);
      const axZ = Math.cos(ba);
      for (let si = 0; si < 2; si++) {
        vPos.set(x + axX * (si === 0 ? -0.45 : 0.45), h + 1.02, z + axZ * (si === 0 ? -0.45 : 0.45));
        m4.compose(vPos, q0, vScale);
        strapMesh.setMatrixAt(baleCount * 2 + si, m4);
      }
      baleCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 1.05, y0: h - 0.2, y1: h + 1.4, tag: 'rock' });
    }
    baleMesh.count = baleCount;
    strapMesh.count = baleCount * 2;
    baleMesh.instanceMatrix.needsUpdate = true;
    strapMesh.instanceMatrix.needsUpdate = true;
    scene.add(baleMesh);
    scene.add(strapMesh);
    this.assetUsage.add('map.tactical.farm', baleCount);

    // ---- 渔村小船(搁浅, 装饰+圆碰撞; 船体+翘头+舱包+座椅+桅杆) ----
    const boatMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x7a5c38 }),
      18,
    );
    boatMesh.castShadow = true;
    let boatCount = 0;
    for (let t = 0; t < 200 && boatCount < 3; t++) {
      const x = 200 + (rng() * 2 - 1) * 40;
      const z = -222 + (rng() * 2 - 1) * 25;
      const h = this.getHeight(x, z);
      if (h < WATER_Y - 0.1 || h > WATER_Y + 1.2) continue; // 搁浅带
      if (this.inPlot(x, z, 2)) continue;
      const rotY = rng() * Math.PI * 2;
      q0.setFromAxisAngle(upY, rotY);
      const fx = Math.sin(rotY);
      const fz = Math.cos(rotY);
      const bi = boatCount * 6;
      // 船体(拉长) + 翘头 + 舱包
      vPos.set(x, h + 0.3, z);
      vScale.set(3.2, 0.62, 1.15);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(bi, m4);
      boatMesh.setColorAt(bi, canopyC.setRGB(0.48, 0.36, 0.22));
      vPos.set(x + fx * 1.8, h + 0.48, z + fz * 1.8);
      vScale.set(0.8, 0.5, 0.9);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(bi + 1, m4);
      boatMesh.setColorAt(bi + 1, canopyC.setRGB(0.45, 0.33, 0.2));
      vPos.set(x, h + 0.62, z);
      vScale.set(0.5, 0.35, 0.6);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(bi + 2, m4);
      boatMesh.setColorAt(bi + 2, canopyC.setRGB(0.4, 0.3, 0.18));
      // 横坐板 ×2(沿船向错开)
      for (let si = 0; si < 2; si++) {
        vPos.set(x + fx * (si === 0 ? -0.7 : 0.4), h + 0.52, z + fz * (si === 0 ? -0.7 : 0.4));
        vScale.set(0.85, 0.08, 0.28);
        m4.compose(vPos, q0, vScale);
        boatMesh.setMatrixAt(bi + 3 + si, m4);
        boatMesh.setColorAt(bi + 3 + si, canopyC.setRGB(0.55, 0.42, 0.26));
      }
      // 小桅杆
      vPos.set(x + fx * 1.1, h + 1.15, z + fz * 1.1);
      vScale.set(0.09, 1.5, 0.09);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(bi + 5, m4);
      boatMesh.setColorAt(bi + 5, canopyC.setRGB(0.35, 0.26, 0.16));
      boatCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 1.7, y0: h - 0.3, y1: h + 0.9, tag: 'rock' });
      this.boatPts.push({ x, z });
    }
    boatMesh.count = boatCount * 6;
    boatMesh.instanceMatrix.needsUpdate = true;
    if (boatMesh.instanceColor) boatMesh.instanceColor.needsUpdate = true;
    scene.add(boatMesh);
    this.assetUsage.add('map.tactical.harbor', boatCount);

    // ---- 地标与场景道具(观景台/风车/山地遗迹/码头/教堂广场/围栏/电杆/沿岸芦苇) ----
    this.addScenicLandmarks(scene);
    this.addEnvironmentProps(scene);
    this.addRegionalIdentityProps(scene);
    this.addRegionalTacticalProps(scene);
    this.addTacticalRouteLanes(scene);
    this.addFinalMapContent(scene);
    this.addShoreDetails(scene);
    this.assetUsage.add('map.nature.shore', this.shorelineDetailCount);
    for (const site of this.scenicSites) {
      if (site.kind === 'lookout') this.assetUsage.add('map.landmark.lookout');
      else if (site.kind === 'windmill') this.assetUsage.add('map.landmark.windmill');
      else if (site.kind === 'ruins') this.assetUsage.add('map.landmark.ruins');
      else if (site.kind === 'dock') this.assetUsage.add('map.landmark.dock');
      else {
        this.assetUsage.add('map.landmark.church');
        this.assetUsage.add('map.landmark.plaza');
      }
    }
    this.assetUsage.add('map.landmark.region-site', this.mapSites.length);
    this.assetUsage.add('map.tactical.cover', this.tacticalCoverCount);

    // ---- 双桥(木板面+护栏+桥墩, 可走平台) ----
    this.addBridge(scene, -50);
    this.addBridge(scene, 170);
    this.assetUsage.add('map.infrastructure.bridge', 2);
    this.addRoadWaterCrossings(scene);
  }

  private prepareScenicSites(): void {
    const specs: { kind: ScenicKind; x: number; z: number; r: number; shore?: boolean }[] = [
      { kind: 'lookout', x: 18, z: -118, r: 12 },
      { kind: 'windmill', x: -108, z: 205, r: 10 },
      { kind: 'ruins', x: -242, z: 28, r: 13 },
      { kind: 'dock', x: 222, z: -232, r: 8, shore: true },
      { kind: 'church', x: 4, z: 28, r: 25 },
    ];
    this.scenicSites.length = 0;
    for (const spec of specs) {
      let found: ScenicSite | null = null;
      for (let i = 0; i < (spec.kind === 'church' ? 420 : 180); i++) {
        const dist = i === 0 ? 0 : 2.8 * Math.sqrt(i);
        const a = i * 2.399963;
        const x = spec.x + Math.cos(a) * dist;
        const z = spec.z + Math.sin(a) * dist;
        const h = this.getHeight(x, z);
        if (spec.kind === 'church' && regionAt(x, z)?.id !== 'stonegate') continue;
        const heightOk = spec.shore
          ? h > WATER_Y - 0.05 && h < WATER_Y + 1.35
          : h > WATER_Y + 0.8 && h < (spec.kind === 'ruins' ? 18 : 13.5);
        if (!heightOk || this.inPlot(x, z, spec.r + 1.5)) continue;
        const slopeLimit = spec.kind === 'ruins' ? 0.72 : spec.kind === 'church' ? 0.34 : 0.48;
        if (!spec.shore && this.slopeAt(x, z) > slopeLimit) continue;
        if (this.scenicSites.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + spec.r + 8)) continue;
        found = { kind: spec.kind, x, z, r: spec.r };
        break;
      }
      if (found) this.scenicSites.push(found);
    }
  }

  private flattenChurchTerrain(): void {
    const church = this.scenicSites.find((site) => site.kind === 'church');
    if (!church) return;
    const samples = [
      this.getHeight(church.x, church.z - 5),
      this.getHeight(church.x - 7, church.z - 5),
      this.getHeight(church.x + 7, church.z - 5),
      this.getHeight(church.x, church.z + 14),
      this.getHeight(church.x - 10, church.z + 14),
      this.getHeight(church.x + 10, church.z + 14),
    ].sort((a, b) => a - b);
    const target = ((samples[2] as number) + (samples[3] as number)) * 0.5;
    const gradeCenterZ = church.z + 4.5;
    const halfWidth = 15;
    const halfDepth = 20;
    const blendDistance = 8;
    for (let iz = 0; iz <= GRID; iz++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = -WORLD_HALF + ix * CELL;
        const z = -WORLD_HALF + iz * CELL;
        const outsideX = Math.max(0, Math.abs(x - church.x) - halfWidth);
        const outsideZ = Math.max(0, Math.abs(z - gradeCenterZ) - halfDepth);
        const outsideDistance = Math.hypot(outsideX, outsideZ);
        if (outsideDistance >= blendDistance) continue;
        const blend = 1 - smoothstep(0, blendDistance, outsideDistance);
        const index = iz * (GRID + 1) + ix;
        const current = this.heights[index] as number;
        this.heights[index] = current + (target - current) * blend;
      }
    }
  }

  private inScenicSite(x: number, z: number, margin: number): boolean {
    for (const s of this.scenicSites) {
      const r = s.r + margin;
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  private roadDistanceAt(x: number, z: number): number {
    let nearest = Number.POSITIVE_INFINITY;
    for (const path of ROAD_PATHS) {
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i] as readonly [number, number];
        const b = path[i + 1] as readonly [number, number];
        const vx = b[0] - a[0];
        const vz = b[1] - a[1];
        const len2 = vx * vx + vz * vz;
        const t = clamp(((x - a[0]) * vx + (z - a[1]) * vz) / len2, 0, 1);
        const dx = x - (a[0] + vx * t);
        const dz = z - (a[1] + vz * t);
        nearest = Math.min(nearest, Math.hypot(dx, dz));
      }
    }
    return nearest;
  }

  private nearRoad(x: number, z: number, margin: number): boolean {
    return this.roadDistanceAt(x, z) < 2.5 + margin;
  }

  private addRoadNetwork(scene: THREE.Scene): void {
    const makeLayer = (width: number, lift: number, color: number, name: string): THREE.Mesh => {
      const vertices: number[] = [];
      const halfWidth = width * 0.5;

      // 道路控制点既是转弯圆角，也是多条路线的接缝。旧实现把每个线段单独铺成四边形，
      // 相邻线段使用不同法向后会在弯道留下三角缝，多条路线交汇时还会互相叠面。
      const patchCenters: Array<readonly [number, number]> = [];
      const addPatchCenter = (x: number, z: number): void => {
        if (patchCenters.some(([px, pz]) => Math.hypot(px - x, pz - z) < 0.2)) return;
        patchCenters.push([x, z]);
      };
      for (const path of ROAD_PATHS) {
        for (const [x, z] of path) addPatchCenter(x, z);
      }

      // 补齐没有共用控制点但几何上相交的道路，避免今后调整路线后再次出现十字口裸地。
      const segments = ROAD_PATHS.flatMap((path) => path.slice(0, -1).map((a, index) => ({
        a,
        b: path[index + 1] as readonly [number, number],
      })));
      for (let i = 0; i < segments.length; i++) {
        const first = segments[i] as typeof segments[number];
        const rX = first.b[0] - first.a[0];
        const rZ = first.b[1] - first.a[1];
        for (let j = i + 1; j < segments.length; j++) {
          const second = segments[j] as typeof segments[number];
          const sX = second.b[0] - second.a[0];
          const sZ = second.b[1] - second.a[1];
          const denominator = rX * sZ - rZ * sX;
          if (Math.abs(denominator) < 0.000001) continue;
          const qX = second.a[0] - first.a[0];
          const qZ = second.a[1] - first.a[1];
          const t = (qX * sZ - qZ * sX) / denominator;
          const u = (qX * rZ - qZ * rX) / denominator;
          if (t < -0.0001 || t > 1.0001 || u < -0.0001 || u > 1.0001) continue;
          addPatchCenter(first.a[0] + rX * t, first.a[1] + rZ * t);
        }
      }

      for (const path of ROAD_PATHS) {
        const samples: Array<readonly [number, number]> = [];
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i] as readonly [number, number];
          const b = path[i + 1] as readonly [number, number];
          const dx = b[0] - a[0];
          const dz = b[1] - a[1];
          const len = Math.hypot(dx, dz);
          const steps = Math.max(1, Math.ceil(len / 3.5));
          if (i === 0) samples.push(a);
          for (let s = 1; s <= steps; s++) samples.push([
            a[0] + dx * (s / steps),
            a[1] + dz * (s / steps),
          ]);
        }

        const roadSurfaceHeight = (x: number, z: number): number => {
          const terrainHeight = this.getHeight(x, z);
          return terrainHeight < WATER_Y + 0.18 ? ROAD_WATER_DECK_Y : terrainHeight;
        };
        for (let i = 0; i < samples.length - 1; i++) {
          const sampleA = samples[i] as readonly [number, number];
          const sampleB = samples[i + 1] as readonly [number, number];
          const midX = (sampleA[0] + sampleB[0]) * 0.5;
          const midZ = (sampleA[1] + sampleB[1]) * 0.5;
          // 主桥自身已经提供完整桥面。普通道路若继续在水面上铺设，会从木桥下方穿过，
          // 并在桥头与桥面形成两套错位路面。
          if (insideMainBridgeDeck(midX, midZ, 0.55)) continue;
          // 每个短路段独立计算左右边缘，避免急弯处平均切线把四边形折反。
          // 控制点和交叉点由下方圆角补片封口，因此不会留下草地三角缝。
          const tangentX = sampleB[0] - sampleA[0];
          const tangentZ = sampleB[1] - sampleA[1];
          const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
          const offsetX = (-tangentZ / tangentLength) * halfWidth;
          const offsetZ = (tangentX / tangentLength) * halfWidth;
          const aLeft = [
            sampleA[0] + offsetX,
            roadSurfaceHeight(sampleA[0] + offsetX, sampleA[1] + offsetZ) + lift,
            sampleA[1] + offsetZ,
          ] as const;
          const aRight = [
            sampleA[0] - offsetX,
            roadSurfaceHeight(sampleA[0] - offsetX, sampleA[1] - offsetZ) + lift,
            sampleA[1] - offsetZ,
          ] as const;
          const bLeft = [
            sampleB[0] + offsetX,
            roadSurfaceHeight(sampleB[0] + offsetX, sampleB[1] + offsetZ) + lift,
            sampleB[1] + offsetZ,
          ] as const;
          const bRight = [
            sampleB[0] - offsetX,
            roadSurfaceHeight(sampleB[0] - offsetX, sampleB[1] - offsetZ) + lift,
            sampleB[1] - offsetZ,
          ] as const;
          vertices.push(
            ...aLeft, ...bRight, ...aRight,
            ...aLeft, ...bLeft, ...bRight,
          );
        }
      }

      // 以轻微抬高的圆形补片统一封住转弯、端点和交叉口。补片跟随地形逐点采样，
      // 不会在坡地退化成悬空的大平面。
      const patchSegments = 18;
      const patchRadius = halfWidth * 1.22;
      const renderedPatchCenters: Array<readonly [number, number]> = [];
      for (const [centerX, centerZ] of patchCenters) {
        // 位于主桥跨度内的道路节点由桥面和桥头坡台接管，不能再叠加圆形路口补片。
        if (insideMainBridgeDeck(centerX, centerZ, 0.55)) continue;
        const centerTerrain = this.getHeight(centerX, centerZ);
        const centerBase = centerTerrain < WATER_Y + 0.18 ? ROAD_WATER_DECK_Y : centerTerrain;
        const centerY = centerBase + lift + 0.006;
        renderedPatchCenters.push([centerX, centerZ]);
        for (let segment = 0; segment < patchSegments; segment++) {
          const a = (segment / patchSegments) * Math.PI * 2;
          const b = ((segment + 1) / patchSegments) * Math.PI * 2;
          const ax = centerX + Math.cos(a) * patchRadius;
          const az = centerZ + Math.sin(a) * patchRadius;
          const bx = centerX + Math.cos(b) * patchRadius;
          const bz = centerZ + Math.sin(b) * patchRadius;
          const ah = this.getHeight(ax, az);
          const bh = this.getHeight(bx, bz);
          vertices.push(
            centerX, centerY, centerZ,
            bx, (bh < WATER_Y + 0.18 ? ROAD_WATER_DECK_Y : bh) + lift + 0.006, bz,
            ax, (ah < WATER_Y + 0.18 ? ROAD_WATER_DECK_Y : ah) + lift + 0.006, az,
          );
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      // 道路由大量贴坡短三角组成，逐三角计算法线会让同色路面出现明显的深浅拼布。
      // 统一使用向上法线保留材质光照，同时消除俯视和顺光下的碎三角色块。
      const normals = new Float32Array(vertices.length);
      for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      const mat = new THREE.MeshBasicMaterial({
        color,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.receiveShadow = true;
      mesh.renderOrder = 0;
      mesh.userData.roadPatchCenters = renderedPatchCenters;
      mesh.userData.roadPatchSegments = patchSegments;
      mesh.userData.roadSurfaceLift = lift;
      return mesh;
    };
    // 单层路面消除旧版宽窄两层重叠后在弯道形成的平行细线。贴地偏移控制在两厘米内，
    // 角色脚底与物理地形一致，不再看起来陷入路面。
    scene.add(makeLayer(7.2, 0.032, 0x948267, 'road-track-surface'));
  }

  private addRoadTermini(scene: THREE.Scene): void {
    const group = new THREE.Group();
    group.name = 'road-termini';
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8f918b, roughness: 0.94 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x765437, roughness: 0.97 });
    const signWood = new THREE.MeshStandardMaterial({
      color: 0xa57845,
      emissive: 0x2e1809,
      emissiveIntensity: 0.42,
      roughness: 0.9,
    });
    const metal = new THREE.MeshStandardMaterial({ color: 0x4e585b, roughness: 0.68, metalness: 0.28 });
    const reflector = new THREE.MeshStandardMaterial({
      color: 0xf0c65f,
      emissive: 0x8a4d12,
      emissiveIntensity: 0.7,
      roughness: 0.42,
    });
    applySurfaceAsset(concrete, 'concrete', 2.4, 0.68);
    applySurfaceAsset(wood, 'wood', 3.0, 0.76);
    applySurfaceAsset(signWood, 'wood', 3.0, 0.66);
    applySurfaceAsset(metal, 'paintedMetal', 3.2, 0.72);

    const addBox = (
      x: number, y: number, z: number, w: number, h: number, d: number,
      material: THREE.Material, yaw: number, collide = false,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y + h * 0.5, z);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (collide) {
        const cw = Math.abs(Math.cos(yaw)) * w + Math.abs(Math.sin(yaw)) * d;
        const cd = Math.abs(Math.sin(yaw)) * w + Math.abs(Math.cos(yaw)) * d;
        this.addCollider({
          kind: 'aabb', minX: x - cw * 0.5, minY: y, minZ: z - cd * 0.5,
          maxX: x + cw * 0.5, maxY: y + h, maxZ: z + cd * 0.5, tag: 'wall',
        });
      }
      return mesh;
    };

    this.roadTerminusCount = 0;
    for (const terminus of DESIGNED_ROAD_TERMINI) {
      const dx = terminus.x - terminus.fromX;
      const dz = terminus.z - terminus.fromZ;
      const length = Math.hypot(dx, dz) || 1;
      const forwardX = dx / length;
      const forwardZ = dz / length;
      const sideX = -forwardZ;
      const sideZ = forwardX;
      const barrierX = terminus.x - forwardX * 0.65;
      const barrierZ = terminus.z - forwardZ * 0.65;
      const ground = this.getHeight(barrierX, barrierZ);
      const yaw = Math.atan2(-sideZ, sideX);
      const barrierMat = terminus.style === 'forest' ? wood : concrete;

      // 横向实体路障明确告诉玩家这里是回车场/断路口，而不是可以继续驶入水里的道路。
      addBox(barrierX, ground + 0.04, barrierZ, 4.8, 0.72, 0.46, barrierMat, yaw, true);
      for (const side of [-1, 1] as const) {
        const px = barrierX + sideX * side * 1.78;
        const pz = barrierZ + sideZ * side * 1.78;
        const py = this.getHeight(px, pz);
        addBox(px, py + 0.72, pz, 0.24, 0.22, 0.12, reflector, yaw, false);
        addBox(px, py, pz, 0.14, 0.84, 0.14, metal, 0, false);
      }

      // 林场使用原木方向牌，港区和竞技场使用金属警示牌，形成可读的区域差异。
      const signX = barrierX + sideX * 2.65 - forwardX * 1.1;
      const signZ = barrierZ + sideZ * 2.65 - forwardZ * 1.1;
      const signY = this.getHeight(signX, signZ);
      addBox(signX, signY, signZ, 0.13, 1.7, 0.13, terminus.style === 'forest' ? signWood : metal, 0, false);
      addBox(
        signX, signY + 1.3, signZ, 1.35, 0.52, 0.12,
        terminus.style === 'forest' ? signWood : reflector, yaw, false,
      );
      this.roadTerminusCount++;
    }
    scene.add(group);
    this.environmentDetailInstanceCount += this.roadTerminusCount * 8;
    this.assetUsage.add('map.infrastructure.road', this.roadTerminusCount);
  }

  private addScenicLandmarks(scene: THREE.Scene): void {
    for (const site of this.scenicSites) {
      if (site.kind === 'lookout') this.addLookout(scene, site);
      else if (site.kind === 'windmill') this.addWindmill(scene, site);
      else if (site.kind === 'ruins') this.addRuins(scene, site);
      else if (site.kind === 'dock') this.addDock(scene, site);
      else this.addChurchPlaza(scene, site);
    }
  }

  private addLookout(scene: THREE.Scene, site: ScenicSite): void {
    const h = this.getHeight(site.x, site.z);
    const wood = new THREE.MeshStandardMaterial({ color: 0x654a30, roughness: 0.92 });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x3d3025, roughness: 0.95 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x526143, roughness: 0.88 });
    const g = new THREE.Group();
    g.position.set(site.x, h, site.z);
    const box = (w: number, hh: number, d: number, x: number, y: number, z: number, mat = wood): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const deckTop = 5.6;
    for (const [x, z] of [[-2.35, -2.35], [2.35, -2.35], [-2.35, 2.35], [2.35, 2.35]] as const) {
      const footY = this.getHeight(site.x + x, site.z + z) - h;
      const legH = Math.max(0.7, deckTop - footY);
      const leg = box(0.34, legH, 0.34, x, footY + legH / 2, z, woodDark);
      leg.rotation.z = x > 0 ? -0.035 : 0.035;
      this.addCollider({ kind: 'cyl', x: site.x + x, z: site.z + z, r: 0.3, y0: h + footY, y1: h + deckTop, tag: 'rock' });
    }
    box(5.8, 0.28, 5.8, 0, 5.55, 0);
    // 北侧护栏完整保留，南侧中央为楼梯入口留出 1.8m 缺口。
    box(5.8, 0.12, 0.12, 0, 6.4, -2.7, woodDark);
    for (const x of [-2.7, 0, 2.7]) box(0.12, 0.9, 0.12, x, 6.0, -2.7, woodDark);
    for (const [x, w] of [[-1.9, 2], [1.9, 2]] as const) box(w, 0.12, 0.12, x, 6.4, 2.7, woodDark);
    for (const x of [-2.7, -0.9, 0.9, 2.7]) box(0.12, 0.9, 0.12, x, 6.0, 2.7, woodDark);
    for (const x of [-2.7, 2.7]) {
      box(0.12, 0.12, 5.4, x, 6.4, 0, woodDark);
      for (const z of [-1.5, 1.5]) box(0.12, 0.9, 0.12, x, 6.0, z, woodDark);
    }
    // 开放式细栏杆使用连续窄碰撞面，南侧中央保留与可见楼梯一致的入口缺口。
    const railY0 = h + deckTop;
    const railY1 = railY0 + 0.9;
    this.addCollider({ kind: 'aabb', minX: site.x - 2.9, minY: railY0, minZ: site.z - 2.82, maxX: site.x + 2.9, maxY: railY1, maxZ: site.z - 2.58, tag: 'wall' });
    this.addCollider({ kind: 'aabb', minX: site.x - 2.9, minY: railY0, minZ: site.z + 2.58, maxX: site.x - 0.9, maxY: railY1, maxZ: site.z + 2.82, tag: 'wall' });
    this.addCollider({ kind: 'aabb', minX: site.x + 0.9, minY: railY0, minZ: site.z + 2.58, maxX: site.x + 2.9, maxY: railY1, maxZ: site.z + 2.82, tag: 'wall' });
    this.addCollider({ kind: 'aabb', minX: site.x - 2.82, minY: railY0, minZ: site.z - 2.7, maxX: site.x - 2.58, maxY: railY1, maxZ: site.z + 2.7, tag: 'wall' });
    this.addCollider({ kind: 'aabb', minX: site.x + 2.58, minY: railY0, minZ: site.z - 2.7, maxX: site.x + 2.82, maxY: railY1, maxZ: site.z + 2.7, tag: 'wall' });
    for (const x of [-2.45, 2.45]) box(0.22, 2.6, 0.22, x, 7.0, 0, woodDark);
    for (const z of [-2.45, 2.45]) box(0.22, 2.6, 0.22, 0, 7.0, z, woodDark);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.3, 1.35, 4), roofMat);
    roof.position.y = 8.42;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);
    this.addCollider({ kind: 'aabb', minX: site.x - 2.9, minY: h + 5.32, minZ: site.z - 2.9, maxX: site.x + 2.9, maxY: h + 5.6, maxZ: site.z + 2.9, tag: 'floor' });
    this.platforms.push({ minX: site.x - 2.9, minZ: site.z - 2.9, maxX: site.x + 2.9, maxZ: site.z + 2.9, top: h + deckTop });
    // 楼梯从南侧地面连续抬升到平台边缘，最上一级与楼板重叠，避免悬空或钻入亭底。
    const stairOuterZ = 8.4;
    const stairInnerZ = 2.72;
    const stairBottomGround = this.getHeight(site.x, site.z + stairOuterZ - 0.2) - h;
    const stairBottomTop = stairBottomGround + 0.22;
    const stairCount = Math.max(15, Math.ceil((deckTop - stairBottomTop) / 0.38) + 1);
    const stairRun = (stairOuterZ - stairInnerZ) / stairCount;
    for (let i = 0; i < stairCount; i++) {
      const zFar = stairOuterZ - i * stairRun;
      const zNear = stairOuterZ - (i + 1) * stairRun;
      const top = stairBottomTop + (deckTop - stairBottomTop) * (i / (stairCount - 1));
      const z = (zFar + zNear) / 2;
      box(1.65, 0.2, zFar - zNear + 0.04, 0, top - 0.1, z);
      this.platforms.push({
        minX: site.x - 0.825, minZ: site.z + zNear,
        maxX: site.x + 0.825, maxZ: site.z + zFar, top: h + top,
      });
    }
    scene.add(g);
  }

  private addWindmill(scene: THREE.Scene, site: ScenicSite): void {
    const h = this.getHeight(site.x, site.z);
    const plaster = new THREE.MeshStandardMaterial({ color: 0xd2c6a3, roughness: 0.95 });
    const timber = new THREE.MeshStandardMaterial({ color: 0x59402b, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x884a35, roughness: 0.88 });
    const g = new THREE.Group();
    g.position.set(site.x, h, site.z);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.15, 3.05, 6.3, 10), plaster);
    tower.position.y = 3.15;
    tower.castShadow = true;
    tower.receiveShadow = true;
    g.add(tower);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.55, 1.9, 10), roofMat);
    roof.position.y = 7.05;
    roof.castShadow = true;
    g.add(roof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.9, 0.12), timber);
    door.position.set(0, 1.02, 2.72);
    g.add(door);
    const rotor = new THREE.Group();
    rotor.position.set(0, 5.7, 2.25);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.55, 10), timber);
    hub.rotation.x = Math.PI / 2;
    hub.castShadow = true;
    rotor.add(hub);
    for (let i = 0; i < 6; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = (i / 6) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 3.5, 0.12), timber);
      blade.position.y = 1.9;
      blade.castShadow = true;
      pivot.add(blade);
      rotor.add(pivot);
    }
    rotor.rotation.z = 0.18;
    g.add(rotor);
    scene.add(g);
    this.addCollider({ kind: 'cyl', x: site.x, z: site.z, r: 2.7, y0: h - 0.4, y1: h + 6.5, tag: 'rock' });
  }

  private addRuins(scene: THREE.Scene, site: ScenicSite): void {
    const h = this.getHeight(site.x, site.z);
    const stone = new THREE.MeshStandardMaterial({ color: 0x77766e, roughness: 1, flatShading: true });
    const stoneDark = new THREE.MeshStandardMaterial({ color: 0x575b56, roughness: 1, flatShading: true });
    const g = new THREE.Group();
    const addWall = (x: number, z: number, w: number, hh: number, d: number, mat = stone): void => {
      const y = this.getHeight(site.x + x, site.z + z);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d, Math.max(1, Math.floor(w / 2)), 1, 1), mat);
      mesh.position.set(site.x + x, y + hh * 0.5, site.z + z);
      mesh.rotation.y = (x * 0.07 + z * 0.11) * 0.03;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      this.addCollider({
        kind: 'aabb', minX: mesh.position.x - w * 0.5, minY: y, minZ: mesh.position.z - d * 0.5,
        maxX: mesh.position.x + w * 0.5, maxY: y + hh, maxZ: mesh.position.z + d * 0.5, tag: 'wall',
      });
    };
    addWall(0, -5, 10, 2.4, 0.8);
    addWall(-5, 0, 0.8, 4.1, 10, stoneDark);
    addWall(3.2, 4.6, 4.4, 1.55, 0.8);
    addWall(5, -2.8, 0.8, 2.9, 4.2);
    for (const [x, z, s] of [[-2.4, -1.8, 0.8], [1.5, 1.2, 1.1], [4.7, 3.8, 0.65], [-5.2, 5.1, 0.72]] as const) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), stoneDark);
      rock.position.set(site.x + x, h + s * 0.45, site.z + z);
      rock.rotation.set(x * 0.2, z * 0.3, x * 0.1);
      rock.castShadow = true;
      g.add(rock);
    }
    const ember = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 5), new THREE.MeshBasicMaterial({ color: 0xff7a32 }));
    ember.scale.set(1.5, 0.5, 1.5);
    ember.position.set(site.x + 0.7, h + 0.18, site.z + 0.2);
    g.add(ember);
    scene.add(g);
  }

  private addDock(scene: THREE.Scene, site: ScenicSite): void {
    const h = this.getHeight(site.x, site.z);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    let dir: readonly [number, number] = dirs[0];
    let low = Infinity;
    for (const d of dirs) {
      const dh = this.getHeight(site.x + d[0] * 18, site.z + d[1] * 18);
      if (dh < low) { low = dh; dir = d; }
    }
    const wood = new THREE.MeshStandardMaterial({ color: 0x765434, roughness: 0.95 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x463526, roughness: 1 });
    const deckY = Math.max(WATER_Y + 0.58, h + 0.08);
    const alongX = dir[0] !== 0;
    for (let i = 0; i < 13; i++) {
      const cx = site.x + dir[0] * (i * 1.4);
      const cz = site.z + dir[1] * (i * 1.4);
      const plank = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 1.32 : 3.4, 0.18, alongX ? 3.4 : 1.32), wood);
      plank.position.set(cx, deckY - 0.09, cz);
      plank.castShadow = true;
      plank.receiveShadow = true;
      scene.add(plank);
      this.platforms.push({
        minX: cx - (alongX ? 0.66 : 1.7), minZ: cz - (alongX ? 1.7 : 0.66),
        maxX: cx + (alongX ? 0.66 : 1.7), maxZ: cz + (alongX ? 1.7 : 0.66), top: deckY,
      });
      if (i % 4 === 0) {
        for (const side of [-1, 1]) {
          const px = cx + (alongX ? 0 : side * 1.5);
          const pz = cz + (alongX ? side * 1.5 : 0);
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.5, 6), edge);
          post.position.set(px, deckY - 0.7, pz);
          post.castShadow = true;
          scene.add(post);
        }
      }
    }
    const endX = site.x + dir[0] * 17;
    const endZ = site.z + dir[1] * 17;
    for (const side of [-1, 1]) {
      const cx = endX + (alongX ? 0 : side * 1.15);
      const cz = endZ + (alongX ? side * 1.15 : 0);
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.9), edge);
      crate.position.set(cx, deckY + 0.4, cz);
      crate.castShadow = true;
      scene.add(crate);
    }
  }

  private churchFloorTop(site: ScenicSite): number {
    const centerZ = site.z - 5;
    let highest = -Infinity;
    for (let ix = 0; ix <= 6; ix++) {
      for (let iz = 0; iz <= 9; iz++) {
        const x = site.x - 6.4 + ix / 6 * 12.8;
        const z = centerZ - 9.5 + iz / 9 * 19;
        highest = Math.max(highest, this.getHeight(x, z));
      }
    }
    return highest + 0.22;
  }

  private churchPlazaTop(site: ScenicSite): number {
    const centerZ = site.z + 14;
    return Math.max(
      this.getHeight(site.x, centerZ),
      this.getHeight(site.x - 13.5, centerZ - 9), this.getHeight(site.x + 13.5, centerZ - 9),
      this.getHeight(site.x - 13.5, centerZ + 9), this.getHeight(site.x + 13.5, centerZ + 9),
    ) + 0.12;
  }

  // 可进入的教堂和石铺广场共用一个地标安全区. 教堂提供室内近战路线, 广场提供开阔视线和环形掩体.
  private addChurchPlaza(scene: THREE.Scene, site: ScenicSite): void {
    this.churchBreakableGlassCount = 0;
    const plazaTop = this.churchPlazaTop(site);
    // 广场所在坡面明显高于教堂后侧地形时，教堂必须跟随入口广场抬升。
    // 否则广场地基的北侧立面会从门外顶进门洞，形成一整块无法通行的墙。
    const floorTop = Math.max(this.churchFloorTop(site), plazaTop + 0.08);
    const centerZ = site.z - 5;
    const foundationGround = Math.min(
      this.getHeight(site.x - 6.4, centerZ - 9.5),
      this.getHeight(site.x + 6.4, centerZ - 9.5),
      this.getHeight(site.x - 6.4, centerZ + 9.5),
      this.getHeight(site.x + 6.4, centerZ + 9.5),
    ) - 0.18;
    const plaster = new THREE.MeshStandardMaterial({ color: 0xd4c9ad, roughness: 0.92 });
    const stone = new THREE.MeshStandardMaterial({ color: 0x85827a, roughness: 0.97, flatShading: true });
    const trim = new THREE.MeshStandardMaterial({ color: 0x685f53, roughness: 0.95 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x5c3d27, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x71463d, roughness: 0.86 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x272a27, roughness: 0.82 });
    const planterStone = new THREE.MeshStandardMaterial({
      color: 0xd1bea0,
      emissive: 0xa58e6c,
      emissiveIntensity: 0.48,
      roughness: 0.96,
    });
    const planterTrim = new THREE.MeshStandardMaterial({
      color: 0xf0dfb9,
      emissive: 0xc5a875,
      emissiveIntensity: 0.48,
      roughness: 0.92,
    });
    const planterInset = new THREE.MeshStandardMaterial({
      color: 0x9f896a,
      emissive: 0x6f5c43,
      emissiveIntensity: 0.42,
      roughness: 0.94,
    });
    const hedgeMaterials = [0xaed98c, 0xc0e6a0].map((hedgeColor) => new THREE.MeshStandardMaterial({
      color: hedgeColor,
      emissive: hedgeColor,
      emissiveIntensity: 0.48,
      roughness: 0.94,
    }));
    const planterFlowerMaterials = [0xf4c95d, 0xe67f72, 0x91a9e7].map((flowerColor) => (
      new THREE.MeshStandardMaterial({
        color: flowerColor,
        emissive: flowerColor,
        emissiveIntensity: 0.42,
        roughness: 0.78,
      })
    ));
    const glass = new THREE.MeshStandardMaterial({
      color: 0x6aa1a8, emissive: 0x315d66, emissiveIntensity: 0.72,
      transparent: true, opacity: 0.72, roughness: 0.18, metalness: 0.08,
    });
    applySurfaceAsset(plaster, 'stonegateBrick', 1.6, 0.72);
    applySurfaceAsset(stone, 'stone', 2.1, 0.82);
    applySurfaceAsset(wood, 'wood', 3.1, 0.72);
    applySurfaceAsset(roofMat, 'roof', 2.3, 0.84);
    const church = new THREE.Group();
    let churchParts = 0;
    const box = (
      w: number, h: number, d: number,
      x: number, y: number, z: number,
      material: THREE.Material,
      collide = false,
      tag: 'wall' | 'floor' | 'roof' = 'wall',
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      church.add(mesh);
      churchParts++;
      if (collide) {
        this.addCollider({
          kind: 'aabb', minX: x - w / 2, minY: y - h / 2, minZ: z - d / 2,
          maxX: x + w / 2, maxY: y + h / 2, maxZ: z + d / 2, tag,
        });
      }
      return mesh;
    };
    const breakableGlass = (
      w: number, h: number, d: number,
      x: number, y: number, z: number,
    ): THREE.Mesh => {
      const mesh = box(w, h, d, x, y, z, glass);
      mesh.name = 'church-breakable-glass';
      const collider: BoxCollider = {
        kind: 'aabb',
        minX: x - w / 2, minY: y - h / 2, minZ: z - d / 2,
        maxX: x + w / 2, maxY: y + h / 2, maxZ: z + d / 2,
        tag: 'window',
      };
      const destructible = new Destructible('window', 30, mesh, collider, x, y, z);
      destructible.vaultable = true;
      collider.destruct = destructible;
      this.addCollider(collider);
      this.buildings.destructibles.push(destructible);
      this.churchBreakableGlassCount++;
      return mesh;
    };

    const foundationHeight = floorTop - foundationGround;
    box(13.2, foundationHeight, 19.4, site.x, foundationGround + foundationHeight / 2, centerZ, stone, true, 'floor');
    this.platforms.push({
      minX: site.x - 6.6, minZ: centerZ - 9.7,
      maxX: site.x + 6.6, maxZ: centerZ + 9.7, top: floorTop,
    });

    // 后墙中央保留真实玻璃窗洞，不能用整墙覆盖玻璃；四段墙体完整围出 2.8m 宽洞口。
    box(4.9, 5.4, 0.42, site.x - 3.85, floorTop + 2.7, centerZ - 9.2, plaster, true);
    box(4.9, 5.4, 0.42, site.x + 3.85, floorTop + 2.7, centerZ - 9.2, plaster, true);
    box(2.8, 1.0, 0.42, site.x, floorTop + 0.5, centerZ - 9.2, plaster, true);
    box(2.8, 2.0, 0.42, site.x, floorTop + 4.4, centerZ - 9.2, plaster, true);
    // 正立面南侧中央保留 2.4m 宽入口, 钟楼悬于入口上方.
    box(5.05, 5.4, 0.42, site.x - 3.78, floorTop + 2.7, centerZ + 9.2, plaster, true);
    box(5.05, 5.4, 0.42, site.x + 3.78, floorTop + 2.7, centerZ + 9.2, plaster, true);
    box(2.5, 1.45, 0.42, site.x, floorTop + 4.68, centerZ + 9.2, plaster, true);
    // 两侧墙由矮墙, 高窗带和承重柱组成, 窗洞真实透光但无法直接翻越.
    for (const side of [-1, 1]) {
      const x = site.x + side * 6.1;
      box(0.42, 1.18, 18.4, x, floorTop + 0.59, centerZ, plaster, true);
      box(0.42, 1.55, 18.4, x, floorTop + 4.63, centerZ, plaster, true);
      for (const zOffset of [-9.2, -5.8, -2.3, 1.2, 4.7, 8.2]) {
        box(0.48, 3.45, 0.48, x, floorTop + 2.9, centerZ + zOffset, trim, true);
      }
      for (const zOffset of [-7.5, -4.05, -0.55, 2.95, 6.45]) {
        const pane = breakableGlass(
          0.08, 2.45, 2.42, x - side * 0.23, floorTop + 2.405, centerZ + zOffset,
        );
        // 教堂窗格随玻璃一起碎裂，破坏后不会留下一根视觉上穿过角色的竖条。
        const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.11, 2.55, 0.1), trim);
        mullion.position.x = -side * 0.05;
        mullion.castShadow = true;
        pane.add(mullion);
        churchParts++;
      }
    }

    // 双坡屋顶保留高挑中殿轮廓. 屋脊下方用薄碰撞层封闭射线和落点.
    for (const side of [-1, 1]) {
      const panel = box(7.25, 0.34, 19.5, site.x + side * 2.92, floorTop + 6.35, centerZ, roofMat);
      panel.rotation.z = side * -0.55;
    }
    box(12.5, 0.22, 18.8, site.x, floorTop + 5.48, centerZ, roofMat, true, 'roof');
    box(0.24, 0.28, 19.6, site.x, floorTop + 8.05, centerZ, trim);

    // 钟楼, 百叶钟窗, 四坡尖顶和十字架构成远距离可识别剪影.
    box(3.9, 4.3, 3.9, site.x, floorTop + 7.58, centerZ + 7.7, plaster, true);
    for (const [dx, dz, w, d] of [[0, 1.98, 1.25, 0.08], [0, -1.98, 1.25, 0.08], [1.98, 0, 0.08, 1.25], [-1.98, 0, 0.08, 1.25]] as const) {
      box(w, 1.45, d, site.x + dx, floorTop + 8.1, centerZ + 7.7 + dz, dark);
    }
    const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(3.0, 3.3, 4), roofMat);
    towerRoof.position.set(site.x, floorTop + 11.38, centerZ + 7.7);
    towerRoof.rotation.y = Math.PI / 4;
    towerRoof.castShadow = true;
    church.add(towerRoof);
    churchParts++;
    box(0.3, 3.0, 0.3, site.x, floorTop + 14.0, centerZ + 7.7, trim);
    box(1.9, 0.3, 0.3, site.x, floorTop + 14.45, centerZ + 7.7, trim);
    this.religiousCrossCount = 1;

    // 入口石阶按实际地面逐级衔接地基, 避免悬空和无法进入.
    const entranceGround = plazaTop;
    const stepCount = 3;
    for (let i = 0; i < stepCount; i++) {
      const top = entranceGround + (floorTop - entranceGround) * ((i + 1) / stepCount);
      const z = centerZ + 11.0 - i * 0.72;
      const stepHeight = Math.max(0.18, top - entranceGround + 0.04);
      box(3.5 + i * 0.25, stepHeight, 0.82, site.x, top - stepHeight / 2, z, stone);
      this.platforms.push({
        minX: site.x - (3.5 + i * 0.25) / 2, minZ: z - 0.41,
        maxX: site.x + (3.5 + i * 0.25) / 2, maxZ: z + 0.41, top,
      });
    }

    // 室内长椅留出 2m 中央通道, 椅背形成低矮战术掩体.
    for (const zOffset of [-6.8, -4.3, -1.8, 0.7, 3.2]) {
      for (const side of [-1, 1]) {
        const x = site.x + side * 3.05;
        box(3.1, 0.48, 0.68, x, floorTop + 0.38, centerZ + zOffset, wood, true);
        box(3.1, 0.72, 0.14, x, floorTop + 0.76, centerZ + zOffset - 0.28, wood);
      }
    }
    // 后窗下方祭台靠内摆放，既保留室内陈设和掩体，也为窗前助跑与落地留下净空。
    box(4.6, 0.92, 0.58, site.x, floorTop + 0.46, centerZ - 7.55, stone, true);
    breakableGlass(2.8, 2.4, 0.18, site.x, floorTop + 2.2, centerZ - 8.94);
    const warmLight = new THREE.PointLight(0xffc982, 2.3, 13, 2);
    warmLight.position.set(site.x, floorTop + 4.4, centerZ - 2.5);
    church.add(warmLight);
    scene.add(church);

    // 广场石铺面逐顶点贴地, 既保持连续图案又不会在缓坡上悬浮.
    const plazaCenterZ = site.z + 14;
    const plazaBase = Math.min(
      this.getHeight(site.x - 13.5, plazaCenterZ - 9), this.getHeight(site.x + 13.5, plazaCenterZ - 9),
      this.getHeight(site.x - 13.5, plazaCenterZ + 9), this.getHeight(site.x + 13.5, plazaCenterZ + 9),
    ) - 0.2;
    const plazaFoundation = new THREE.Mesh(
      new THREE.BoxGeometry(27, plazaTop - plazaBase, 18), stone,
    );
    plazaFoundation.position.set(site.x, plazaBase + (plazaTop - plazaBase) / 2, plazaCenterZ);
    plazaFoundation.castShadow = true;
    plazaFoundation.receiveShadow = true;
    scene.add(plazaFoundation);
    this.addCollider({
      kind: 'aabb', minX: site.x - 13.5, minY: plazaBase, minZ: plazaCenterZ - 9,
      maxX: site.x + 13.5, maxY: plazaTop, maxZ: plazaCenterZ + 9, tag: 'floor',
    });
    this.platforms.push({
      minX: site.x - 13.5, minZ: plazaCenterZ - 9,
      maxX: site.x + 13.5, maxZ: plazaCenterZ + 9, top: plazaTop,
    });
    const plazaGeo = new THREE.PlaneGeometry(27, 18, 18, 12);
    plazaGeo.rotateX(-Math.PI / 2);
    const plazaPos = plazaGeo.attributes.position as THREE.BufferAttribute;
    const plazaColors = new Float32Array(plazaPos.count * 3);
    const tileColor = new THREE.Color();
    for (let i = 0; i < plazaPos.count; i++) {
      const lx = plazaPos.getX(i);
      const lz = plazaPos.getZ(i);
      plazaPos.setY(i, plazaTop + 0.042);
      const checker = (Math.floor((lx + 13.5) / 1.5) + Math.floor((lz + 9) / 1.5)) & 1;
      tileColor.setHex(checker ? 0x88847b : 0x9b968a).multiplyScalar(0.94 + (i % 5) * 0.015);
      plazaColors[i * 3] = tileColor.r;
      plazaColors[i * 3 + 1] = tileColor.g;
      plazaColors[i * 3 + 2] = tileColor.b;
    }
    plazaGeo.setAttribute('color', new THREE.BufferAttribute(plazaColors, 3));
    plazaGeo.computeVertexNormals();
    const plazaMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.96 });
    applySurfaceAsset(plazaMat, 'stone', 1.45, 0.78);
    const plaza = new THREE.Mesh(plazaGeo, plazaMat);
    plaza.position.set(site.x, 0, plazaCenterZ);
    plaza.receiveShadow = true;
    scene.add(plaza);
    let plazaParts = 2;

    const fountainGround = plazaTop;
    let fountainParts = 0;
    const basin = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.3, 8, 24), stone);
    basin.rotation.x = Math.PI / 2;
    basin.position.set(site.x, fountainGround + 0.34, plazaCenterZ);
    basin.castShadow = true;
    basin.receiveShadow = true;
    scene.add(basin);
    fountainParts++;
    const fountainWater = new THREE.MeshStandardMaterial({
      color: 0x69b7ca, emissive: 0x285c68, emissiveIntensity: 0.46,
      transparent: true, opacity: 0.74, roughness: 0.12, metalness: 0.04,
      depthWrite: false,
    });
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(1.95, 24),
      fountainWater,
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(site.x, fountainGround + 0.36, plazaCenterZ);
    scene.add(water);
    fountainParts++;
    const fountainColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.58, 2.3, 10), stone);
    fountainColumn.position.set(site.x, fountainGround + 1.2, plazaCenterZ);
    fountainColumn.castShadow = true;
    scene.add(fountainColumn);
    fountainParts++;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.65, 0.24, 12), stone);
    bowl.position.set(site.x, fountainGround + 2.15, plazaCenterZ);
    bowl.castShadow = true;
    scene.add(bowl);
    fountainParts++;
    const upperWater = new THREE.Mesh(new THREE.CircleGeometry(0.9, 18), fountainWater);
    upperWater.rotation.x = -Math.PI / 2;
    upperWater.position.set(site.x, fountainGround + 2.29, plazaCenterZ);
    scene.add(upperWater);
    fountainParts++;
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 7), stone);
    finial.position.set(site.x, fountainGround + 2.58, plazaCenterZ);
    finial.castShadow = true;
    scene.add(finial);
    fountainParts++;

    // 六组平滑分段水线从上层水钵落入主池，共用一套几何和材质，强化喷泉辨识度但不增加碰撞。
    const jetGeometry = new THREE.CylinderGeometry(0.035, 0.055, 1, 6);
    const up = new THREE.Vector3(0, 1, 0);
    const jetFrom = new THREE.Vector3();
    const jetTo = new THREE.Vector3();
    const jetDelta = new THREE.Vector3();
    for (let direction = 0; direction < 6; direction++) {
      const angle = direction / 6 * Math.PI * 2;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const points: THREE.Vector3[] = [];
      for (let point = 0; point <= 5; point++) {
        const t = point / 5;
        const radius = 0.36 + 1.36 * t;
        const y = 2.31 - 1.76 * t + Math.sin(Math.PI * t) * 1.25;
        points.push(new THREE.Vector3(
          site.x + dx * radius, fountainGround + y, plazaCenterZ + dz * radius,
        ));
      }
      for (let segment = 0; segment < points.length - 1; segment++) {
        jetFrom.copy(points[segment] as THREE.Vector3);
        jetTo.copy(points[segment + 1] as THREE.Vector3);
        jetDelta.subVectors(jetTo, jetFrom);
        const jet = new THREE.Mesh(jetGeometry, fountainWater);
        jet.position.copy(jetFrom).add(jetTo).multiplyScalar(0.5);
        jet.scale.y = jetDelta.length();
        jet.quaternion.setFromUnitVectors(up, jetDelta.normalize());
        jet.renderOrder = 3;
        scene.add(jet);
        fountainParts++;
      }
    }
    const crownJet = new THREE.Mesh(jetGeometry, fountainWater);
    crownJet.position.set(site.x, fountainGround + 3.02, plazaCenterZ);
    crownJet.scale.y = 1.35;
    scene.add(crownJet);
    fountainParts++;
    const crownSpray = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), fountainWater);
    crownSpray.scale.set(1.5, 0.62, 1.5);
    crownSpray.position.set(site.x, fountainGround + 3.72, plazaCenterZ);
    scene.add(crownSpray);
    fountainParts++;
    const splashRing = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.055, 6, 28), fountainWater);
    splashRing.rotation.x = Math.PI / 2;
    splashRing.position.set(site.x, fountainGround + 0.43, plazaCenterZ);
    scene.add(splashRing);
    fountainParts++;
    plazaParts += fountainParts;
    this.fountainDetailCount = fountainParts;
    this.addCollider({ kind: 'cyl', x: site.x, z: plazaCenterZ, r: 2.3, y0: fountainGround, y1: fountainGround + 2.35, tag: 'rock' });
    this.tacticalCoverCount++;

    // 广场边缘的长椅, 花坛和路灯组织空间, 中央仍保留清晰通行环线.
    const plazaBox = (
      x: number, z: number, w: number, h: number, d: number,
      material: THREE.Material, collide = false,
    ): THREE.Mesh => {
      const ground = plazaTop;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, ground + h / 2 + 0.05, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      plazaParts++;
      if (collide) {
        this.addCollider({
          kind: 'aabb', minX: x - w / 2, minY: ground, minZ: z - d / 2,
          maxX: x + w / 2, maxY: ground + h, maxZ: z + d / 2, tag: 'wall',
        });
        this.tacticalCoverCount++;
      }
      return mesh;
    };
    for (const side of [-1, 1]) {
      for (const zOffset of [-5.8, 5.8]) {
        plazaBox(site.x + side * 8.5, plazaCenterZ + zOffset, 3.8, 0.48, 0.72, wood, true);
        plazaBox(site.x + side * 8.5, plazaCenterZ + zOffset - 0.3, 3.8, 0.72, 0.14, wood);
      }
      const planterBase = plazaBox(site.x + side * 10.8, plazaCenterZ, 2.8, 1.02, 2.8, planterStone, true);
      planterBase.name = 'church-plaza-planter-base';
      const planterCap = plazaBox(site.x + side * 10.8, plazaCenterZ, 3.02, 0.2, 3.02, planterTrim);
      planterCap.name = 'church-plaza-planter-cap';
      planterCap.position.y = plazaTop + 1.03;
      for (const [dx, dz, width, depth] of [
        [0, -1.415, 1.72, 0.055], [0, 1.415, 1.72, 0.055],
        [-1.415, 0, 0.055, 1.72], [1.415, 0, 0.055, 1.72],
      ] as const) {
        const inset = new THREE.Mesh(new THREE.BoxGeometry(width, 0.42, depth), planterInset);
        inset.name = 'church-plaza-planter-inset';
        inset.position.set(site.x + side * 10.8 + dx, plazaTop + 0.54, plazaCenterZ + dz);
        inset.castShadow = true;
        scene.add(inset);
        plazaParts++;
      }
      for (const zOffset of [-0.62, 0, 0.62]) {
        const hedge = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.68, 1),
          zOffset === 0 ? hedgeMaterials[0] : hedgeMaterials[1],
        );
        hedge.name = 'church-plaza-planter-hedge';
        hedge.scale.set(1.12, 0.78 + Math.abs(zOffset) * 0.12, 0.92);
        hedge.position.set(site.x + side * 10.8, plazaTop + 1.14, plazaCenterZ + zOffset);
        hedge.castShadow = true;
        scene.add(hedge);
        plazaParts++;
        const flower = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.2, 1),
          planterFlowerMaterials[zOffset < 0 ? 0 : zOffset > 0 ? 2 : 1],
        );
        flower.name = 'church-plaza-planter-flower';
        flower.position.set(
          site.x + side * 10.8 + side * (zOffset === 0 ? 0.18 : -0.08),
          plazaTop + 1.75 - Math.abs(zOffset) * 0.08,
          plazaCenterZ + zOffset,
        );
        flower.castShadow = true;
        scene.add(flower);
        plazaParts++;
      }
    }
    for (const [dx, dz] of [[-11.5, -7], [11.5, -7], [-11.5, 7], [11.5, 7]] as const) {
      const x = site.x + dx;
      const z = plazaCenterZ + dz;
      const ground = plazaTop;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 4.5, 7), dark);
      post.position.set(x, ground + 2.25, z);
      post.castShadow = true;
      scene.add(post);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), glass);
      lamp.position.set(x, ground + 4.55, z);
      scene.add(lamp);
      plazaParts += 2;
      this.addCollider({ kind: 'cyl', x, z, r: 0.18, y0: ground, y1: ground + 4.5, tag: 'rock' });
    }
    // 南侧宽阶梯将地形连续抬升到广场平台, 两侧保留车辆绕行空间.
    const plazaEntryZ = plazaCenterZ + 10.4;
    const plazaEntryGround = this.getHeight(site.x, plazaEntryZ + 1.4);
    for (let i = 0; i < 5; i++) {
      const top = plazaEntryGround + (plazaTop - plazaEntryGround) * ((i + 1) / 5);
      const z = plazaEntryZ + 1.05 - i * 0.55;
      const stepHeight = Math.max(0.18, top - plazaEntryGround + 0.04);
      const step = new THREE.Mesh(new THREE.BoxGeometry(6.6 + i * 0.35, stepHeight, 0.7), stone);
      step.position.set(site.x, top - stepHeight / 2, z);
      step.castShadow = true;
      step.receiveShadow = true;
      scene.add(step);
      this.platforms.push({
        minX: site.x - (6.6 + i * 0.35) / 2, minZ: z - 0.35,
        maxX: site.x + (6.6 + i * 0.35) / 2, maxZ: z + 0.35, top,
      });
      plazaParts++;
    }
    this.churchDetailCount = churchParts;
    this.plazaDetailCount = plazaParts;
    this.environmentDetailInstanceCount += churchParts + plazaParts;
  }

  private addEnvironmentProps(scene: THREE.Scene): void {
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.17, 7.2, 7);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x4c3928, roughness: 0.95 });
    const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, 90);
    const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, 0.14, 0.16), poleMat, 90);
    const poleGroups: THREE.Vector3[][] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    let count = 0;
    for (let pi = 0; pi < Math.min(3, ROAD_PATHS.length); pi++) {
      const path = ROAD_PATHS[pi] as readonly (readonly [number, number])[];
      const group: THREE.Vector3[] = [];
      for (let i = 0; i < path.length - 1 && count < 90; i++) {
        const a = path[i] as readonly [number, number];
        const b = path[i + 1] as readonly [number, number];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        const ox = (-dz / len) * 5.1;
        const oz = (dx / len) * 5.1;
        for (let d = i === 0 ? 10 : 24; d < len - 4 && count < 90; d += 29) {
          const x = a[0] + (dx / len) * d + ox;
          const z = a[1] + (dz / len) * d + oz;
          const h = this.getHeight(x, z);
          if (h < WATER_Y + 0.3 || h > 14 || this.inPlot(x, z, 1.2) || this.inScenicSite(x, z, 0.5)) continue;
          const p = new THREE.Vector3(x, h + 3.6, z);
          m.compose(p, q, s);
          poleMesh.setMatrixAt(count, m);
          p.y = h + 7.05;
          m.compose(p, q, s);
          armMesh.setMatrixAt(count, m);
          group.push(new THREE.Vector3(x, h + 6.92, z));
          this.addCollider({ kind: 'cyl', x, z, r: 0.2, y0: h, y1: h + 7.2, tag: 'rock' });
          count++;
        }
      }
      poleGroups.push(group);
    }
    poleMesh.count = count;
    armMesh.count = count;
    poleMesh.instanceMatrix.needsUpdate = true;
    armMesh.instanceMatrix.needsUpdate = true;
    poleMesh.castShadow = true;
    armMesh.castShadow = true;
    scene.add(poleMesh, armMesh);
    const wires: number[] = [];
    for (const group of poleGroups) {
      for (let i = 0; i < group.length - 1; i++) {
        const a = group[i] as THREE.Vector3;
        const b = group[i + 1] as THREE.Vector3;
        if (a.distanceTo(b) > 45) continue;
        for (const side of [-0.9, 0, 0.9]) {
          wires.push(a.x + side, a.y, a.z, b.x + side, b.y, b.z);
        }
      }
    }
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    scene.add(new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x302d29, transparent: true, opacity: 0.72 })));

    // 农场外圈木围栏, 用实例化保留大范围细节而不增加 draw call。
    const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x795b3c, roughness: 0.96 });
    applySurfaceAsset(fenceMaterial, 'wood', 3.2, 0.7);
    const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 1.25, 0.16), fenceMaterial, 110);
    const railMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 0.12), fenceMaterial, 660);
    postMesh.name = 'farm-fence-posts';
    railMesh.name = 'farm-fence-rails';
    const fenceEdges = [
      [-122, 126, 40, 126], [40, 126, 40, 282], [40, 282, -122, 282], [-122, 282, -122, 126],
    ] as const;
    let postCount = 0;
    let railCount = 0;
    q.identity();
    s.set(1, 1, 1);
    const railAxis = new THREE.Vector3(1, 0, 0);
    const railDelta = new THREE.Vector3();
    const railRotation = new THREE.Quaternion();
    for (const [x0, z0, x1, z1] of fenceEdges) {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const steps = Math.floor(len / 7);
      for (let i = 0; i <= steps && postCount < 110; i++) {
        const t = i / steps;
        const x = x0 + dx * t;
        const z = z0 + dz * t;
        const h = this.getHeight(x, z);
        if (h < WATER_Y + 0.3 || this.inPlot(x, z, 0.5) || this.inScenicSite(x, z, 0.35)) continue;
        m.compose(new THREE.Vector3(x, h + 0.625, z), q, s);
        postMesh.setMatrixAt(postCount++, m);
        if (i === steps || railCount + 6 > 660) continue;
        const nx = x0 + dx * ((i + 1) / steps);
        const nz = z0 + dz * ((i + 1) / steps);
        // 每跨拆成三段并按两端地表高度倾斜，避免长横杆在起伏地形上变成悬空黑板。
        const subdivisions = 3;
        for (let segment = 0; segment < subdivisions; segment++) {
          const st0 = segment / subdivisions;
          const st1 = (segment + 1) / subdivisions;
          const sx0 = x + (nx - x) * st0;
          const sz0 = z + (nz - z) * st0;
          const sx1 = x + (nx - x) * st1;
          const sz1 = z + (nz - z) * st1;
          const sh0 = this.getHeight(sx0, sz0);
          const sh1 = this.getHeight(sx1, sz1);
          const smx = (sx0 + sx1) * 0.5;
          const smz = (sz0 + sz1) * 0.5;
          if (
            sh0 < WATER_Y + 0.3 || sh1 < WATER_Y + 0.3 ||
            Math.abs(sh1 - sh0) > 0.9 || this.slopeAt(smx, smz) > 0.58 ||
            this.inPlot(smx, smz, 0.45) || this.inScenicSite(smx, smz, 0.3)
          ) continue;
          // 只给实际生成出来的短围栏增加阻挡，避免用一整圈隐形墙封死因水面、
          // 建筑或坡度而保留的通行缺口。碰撞体覆盖两根横杆之间的空间，角色不能钻入。
          const fenceCollider: BoxCollider = {
            kind: 'aabb',
            minX: Math.min(sx0, sx1) - 0.09,
            minY: Math.min(sh0, sh1) - 0.05,
            minZ: Math.min(sz0, sz1) - 0.09,
            maxX: Math.max(sx0, sx1) + 0.09,
            maxY: Math.max(sh0, sh1) + 1.12,
            maxZ: Math.max(sz0, sz1) + 0.09,
            tag: 'wall',
          };
          this.farmFenceColliders.push(fenceCollider);
          this.addCollider(fenceCollider);
          for (const ry of [0.48, 0.94]) {
            railDelta.set(sx1 - sx0, sh1 - sh0, sz1 - sz0);
            const railLength = railDelta.length();
            railRotation.setFromUnitVectors(railAxis, railDelta.normalize());
            m.compose(
              new THREE.Vector3(smx, (sh0 + sh1) * 0.5 + ry, smz),
              railRotation,
              new THREE.Vector3(railLength, 1, 1),
            );
            railMesh.setMatrixAt(railCount++, m);
          }
        }
      }
    }
    postMesh.count = postCount;
    railMesh.count = railCount;
    this.farmFenceRailCount = railCount;
    postMesh.instanceMatrix.needsUpdate = true;
    railMesh.instanceMatrix.needsUpdate = true;
    postMesh.castShadow = true;
    railMesh.castShadow = true;
    postMesh.receiveShadow = true;
    railMesh.receiveShadow = true;
    scene.add(postMesh, railMesh);

    const streetMetal = new THREE.MeshStandardMaterial({ color: 0x343b3d, roughness: 0.7, metalness: 0.3 });
    const lampGlow = new THREE.MeshStandardMaterial({
      color: 0xffe1a0, emissive: 0xffc76b, emissiveIntensity: 0.7, roughness: 0.42,
    });
    const lampPosts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.075, 0.11, 4.4, 8), streetMetal, 28);
    const lampHeads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.72, 0.18, 0.34), lampGlow, 28);
    let lampCount = 0;
    for (let pi = 0; pi < 2 && lampCount < 28; pi++) {
      const path = ROAD_PATHS[pi] as readonly (readonly [number, number])[];
      for (let i = 0; i < path.length - 1 && lampCount < 28; i++) {
        const a = path[i] as readonly [number, number];
        const b = path[i + 1] as readonly [number, number];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        for (let distance = 13; distance < len - 5 && lampCount < 28; distance += 21) {
          const side = lampCount % 2 === 0 ? 1 : -1;
          const x = a[0] + dx / len * distance - dz / len * 4.15 * side;
          const z = a[1] + dz / len * distance + dx / len * 4.15 * side;
          if (regionAt(x, z)?.id !== 'stonegate' || !this.pointFree(x, z, 0.2, WATER_Y + 0.3, 15)) continue;
          const h = this.getHeight(x, z);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(dz, dx));
          s.set(1, 1, 1);
          m.compose(new THREE.Vector3(x, h + 2.2, z), q, s);
          lampPosts.setMatrixAt(lampCount, m);
          m.compose(new THREE.Vector3(x, h + 4.36, z), q, s);
          lampHeads.setMatrixAt(lampCount, m);
          this.addCollider({ kind: 'cyl', x, z, r: 0.14, y0: h, y1: h + 4.5, tag: 'rock' });
          lampCount++;
        }
      }
    }
    lampPosts.count = lampCount;
    lampHeads.count = lampCount;
    lampPosts.instanceMatrix.needsUpdate = true;
    lampHeads.instanceMatrix.needsUpdate = true;
    lampPosts.castShadow = true;
    lampHeads.castShadow = true;
    lampPosts.computeBoundingSphere();
    lampHeads.computeBoundingSphere();
    scene.add(lampPosts, lampHeads);

    const signPosts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 2.1, 0.09), poleMat, 18);
    const signBoards = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.35, 0.62, 0.1),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: 0x4e4938,
        emissiveIntensity: 0.34,
        roughness: 0.76,
      }),
      18,
    );
    signBoards.name = 'road-sign-boards';
    const signColor = new THREE.Color();
    let signCount = 0;
    for (let pi = 0; pi < ROAD_PATHS.length && signCount < 18; pi++) {
      const path = ROAD_PATHS[pi] as readonly (readonly [number, number])[];
      for (let i = 1; i < path.length - 1 && signCount < 18; i += 2) {
        const [x0, z0] = path[i] as readonly [number, number];
        const [x1, z1] = path[i + 1] as readonly [number, number];
        const dx = x1 - x0;
        const dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        const x = x0 - dz / len * 4.8;
        const z = z0 + dx / len * 4.8;
        if (!this.pointFree(x, z, 0.18, WATER_Y + 0.3, 16) || this.inScenicSite(x, z, 1)) continue;
        const h = this.getHeight(x, z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(dz, dx));
        s.set(1, 1, 1);
        m.compose(new THREE.Vector3(x, h + 1.05, z), q, s);
        signPosts.setMatrixAt(signCount, m);
        m.compose(new THREE.Vector3(x, h + 1.78, z), q, s);
        signBoards.setMatrixAt(signCount, m);
        const region = regionAt(x, z);
        signColor.setHex(region?.color ?? 0x7d8d76);
        signBoards.setColorAt(signCount, signColor);
        this.addCollider({ kind: 'cyl', x, z, r: 0.12, y0: h, y1: h + 2.12, tag: 'rock' });
        signCount++;
      }
    }
    signPosts.count = signCount;
    signBoards.count = signCount;
    signPosts.instanceMatrix.needsUpdate = true;
    signBoards.instanceMatrix.needsUpdate = true;
    if (signBoards.instanceColor) signBoards.instanceColor.needsUpdate = true;
    signPosts.castShadow = true;
    signBoards.castShadow = true;
    signPosts.computeBoundingSphere();
    signBoards.computeBoundingSphere();
    scene.add(signPosts, signBoards);

    const furnitureRng = mulberry32(99521);
    const benchParts = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x76583a, roughness: 0.92 }),
      60,
    );
    let benchCount = 0;
    for (let t = 0; t < 240 && benchCount < 10; t++) {
      const x = -60 + (furnitureRng() * 2 - 1) * 78;
      const z = -20 + (furnitureRng() * 2 - 1) * 72;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.4 || this.inPlot(x, z, 2.1) || !this.pointFree(x, z, 1.25, WATER_Y + 0.3, 15)) continue;
      const yaw = furnitureRng() * Math.PI * 2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const base = benchCount * 6;
      const part = (index: number, ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): void => {
        const local = new THREE.Vector3(ox, oy, oz).applyQuaternion(q);
        m.compose(new THREE.Vector3(x + local.x, h + local.y, z + local.z), q, new THREE.Vector3(sx, sy, sz));
        benchParts.setMatrixAt(base + index, m);
      };
      part(0, 0, 0.62, 0, 1.7, 0.12, 0.48);
      part(1, 0, 1.05, 0.2, 1.7, 0.58, 0.1);
      part(2, -0.68, 0.3, -0.12, 0.1, 0.58, 0.1);
      part(3, 0.68, 0.3, -0.12, 0.1, 0.58, 0.1);
      part(4, -0.68, 0.3, 0.2, 0.1, 0.58, 0.1);
      part(5, 0.68, 0.3, 0.2, 0.1, 0.58, 0.1);
      this.addCollider({
        kind: 'aabb', minX: x - 1, minY: h, minZ: z - 1,
        maxX: x + 1, maxY: h + 1.4, maxZ: z + 1, tag: 'wall',
      });
      benchCount++;
    }
    benchParts.count = benchCount * 6;
    benchParts.instanceMatrix.needsUpdate = true;
    benchParts.castShadow = true;
    benchParts.computeBoundingSphere();
    scene.add(benchParts);

    const barrelCap = 46;
    const barrels = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.78, 10),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: 0x263b3c,
        emissiveIntensity: 0.38,
        roughness: 0.68,
        metalness: 0.18,
      }),
      barrelCap,
    );
    barrels.name = 'street-barrel-bodies';
    const barrelBands = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.37, 0.37, 0.055, 12),
      new THREE.MeshStandardMaterial({
        color: 0xaeb8b7,
        emissive: 0x3c4747,
        emissiveIntensity: 0.34,
        roughness: 0.5,
        metalness: 0.46,
      }),
      barrelCap * 3,
    );
    barrelBands.name = 'street-barrel-bands';
    let barrelCount = 0;
    let barrelBandCount = 0;
    this.streetBarrelPositions.length = 0;
    const settlements = [regionById('stonegate'), regionById('ironring'), regionById('tideharbor')];
    for (let t = 0; t < 800 && barrelCount < barrelCap; t++) {
      const region = settlements[Math.floor(furnitureRng() * settlements.length)] as (typeof settlements)[number];
      const x = region.x + (furnitureRng() * 2 - 1) * region.radius * 0.82;
      const z = region.z + (furnitureRng() * 2 - 1) * region.radius * 0.82;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.25 || h > 15 || this.inPlot(x, z, 1.2) || !this.pointFree(x, z, 0.42, WATER_Y + 0.2, 16)) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), furnitureRng() * Math.PI * 2);
      s.set(0.82 + furnitureRng() * 0.24, 0.88 + furnitureRng() * 0.2, 0.82 + furnitureRng() * 0.24);
      m.compose(new THREE.Vector3(x, h + 0.39 * s.y, z), q, s);
      barrels.setMatrixAt(barrelCount, m);
      signColor.setHex(barrelCount % 3 === 0 ? 0x82adba : barrelCount % 3 === 1 ? 0xb79b70 : 0x90aa87);
      barrels.setColorAt(barrelCount++, signColor);
      this.streetBarrelPositions.push({ x, z });
      for (const height of [0.07, 0.39, 0.73]) {
        m.compose(new THREE.Vector3(x, h + height * s.y, z), q, s);
        barrelBands.setMatrixAt(barrelBandCount++, m);
      }
      this.addCollider({ kind: 'cyl', x, z, r: 0.36, y0: h, y1: h + 0.86, tag: 'rock' });
    }
    barrels.count = barrelCount;
    barrelBands.count = barrelBandCount;
    barrels.instanceMatrix.needsUpdate = true;
    barrelBands.instanceMatrix.needsUpdate = true;
    if (barrels.instanceColor) barrels.instanceColor.needsUpdate = true;
    barrels.castShadow = true;
    barrelBands.castShadow = true;
    barrels.computeBoundingSphere();
    barrelBands.computeBoundingSphere();
    scene.add(barrels, barrelBands);

    this.humanDetailPropCount = lampCount * 2 + signCount * 2 + benchCount * 6 + barrelCount + barrelBandCount;
    this.environmentDetailInstanceCount += this.humanDetailPropCount;
    this.assetUsage.add('map.infrastructure.street-furniture', lampCount + signCount + benchCount + barrelCount);
  }

  private addRegionalIdentityProps(scene: THREE.Scene): void {
    const rng = mulberry32(44713);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const boxCap = 260;
    const cylinderCap = 180;
    const sphereCap = 260;
    const boxes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.9,
        emissive: 0x2a241d,
        emissiveIntensity: 0.14,
      }),
      boxCap,
    );
    const cylinders = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
      new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9 }),
      cylinderCap,
    );
    const spheres = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 9, 6),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.92,
        emissive: 0x334126,
        emissiveIntensity: 0.26,
      }),
      sphereCap,
    );
    boxes.name = 'regional-identity-boxes';
    spheres.name = 'regional-identity-spheres';
    // 城区花箱独立材质渲染。它们常位于桥头和楼影中，共用通用道具材质时会被压成黑色轮廓。
    const cityPlanterBases = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: 0x796348,
        emissiveIntensity: 0.5,
        roughness: 0.91,
      }),
      40,
    );
    const cityPlanterFoliage = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 10, 7),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: 0x385a2c,
        emissiveIntensity: 0.58,
        roughness: 0.93,
      }),
      100,
    );
    cityPlanterBases.name = 'city-planter-bases';
    cityPlanterFoliage.name = 'city-planter-foliage';
    const nets = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1, 6, 4),
      new THREE.MeshStandardMaterial({
        color: 0x8aa5a0, roughness: 0.96, transparent: true, opacity: 0.58,
        side: THREE.DoubleSide, wireframe: true,
      }),
      10,
    );
    const mushroomStems = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.68, 1, 8),
      new THREE.MeshLambertMaterial({
        color: 0xffffff, vertexColors: true, emissive: 0x705b45, emissiveIntensity: 0.48,
      }),
      86,
    );
    const mushroomCaps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 10, 6),
      new THREE.MeshLambertMaterial({
        color: 0xffffff, vertexColors: true, emissive: 0x6b301f, emissiveIntensity: 0.42,
      }),
      86,
    );
    // 农田浅沟使用贴地平面而不是细长实体盒。实体盒在坡地上只采样中心高度，
    // 两端会悬空并在远处显示成黑色木板。
    const furrowCap = 63;
    const furrowGeometry = new THREE.PlaneGeometry(1, 1);
    furrowGeometry.rotateX(-Math.PI / 2);
    const farmFurrows = new THREE.InstancedMesh(
      furrowGeometry,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 1,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.74,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      furrowCap,
    );
    farmFurrows.name = 'farm-soil-furrows';
    farmFurrows.renderOrder = 1;
    farmFurrows.castShadow = false;
    farmFurrows.receiveShadow = false;
    let boxCount = 0;
    let cylinderCount = 0;
    let sphereCount = 0;
    let cityPlanterBaseCount = 0;
    let cityPlanterFoliageCount = 0;
    let netCount = 0;
    const addBox = (
      x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number, yaw = 0,
    ): void => {
      if (boxCount >= boxCap) return;
      rotation.setFromAxisAngle(up, yaw);
      position.set(x, y, z);
      scale.set(sx, sy, sz);
      matrix.compose(position, rotation, scale);
      boxes.setMatrixAt(boxCount, matrix);
      boxes.setColorAt(boxCount++, color.setHex(hex));
    };
    const addCylinder = (
      x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number,
      yaw = 0, tiltZ = 0,
    ): void => {
      if (cylinderCount >= cylinderCap) return;
      rotation.setFromEuler(new THREE.Euler(0, yaw, tiltZ));
      position.set(x, y, z);
      scale.set(sx, sy, sz);
      matrix.compose(position, rotation, scale);
      cylinders.setMatrixAt(cylinderCount, matrix);
      cylinders.setColorAt(cylinderCount++, color.setHex(hex));
    };
    const addSphere = (
      x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number,
    ): void => {
      if (sphereCount >= sphereCap) return;
      rotation.identity();
      position.set(x, y, z);
      scale.set(sx, sy, sz);
      matrix.compose(position, rotation, scale);
      spheres.setMatrixAt(sphereCount, matrix);
      spheres.setColorAt(sphereCount++, color.setHex(hex));
    };
    const addCityPlanterBox = (
      x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number, yaw: number,
    ): void => {
      if (cityPlanterBaseCount >= cityPlanterBases.count) return;
      rotation.setFromAxisAngle(up, yaw);
      position.set(x, y, z);
      scale.set(sx, sy, sz);
      matrix.compose(position, rotation, scale);
      cityPlanterBases.setMatrixAt(cityPlanterBaseCount, matrix);
      cityPlanterBases.setColorAt(cityPlanterBaseCount++, color.setHex(hex));
    };
    const addCityPlanterSphere = (
      x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number,
    ): void => {
      if (cityPlanterFoliageCount >= cityPlanterFoliage.count) return;
      rotation.identity();
      position.set(x, y, z);
      scale.set(sx, sy, sz);
      matrix.compose(position, rotation, scale);
      cityPlanterFoliage.setMatrixAt(cityPlanterFoliageCount, matrix);
      cityPlanterFoliage.setColorAt(cityPlanterFoliageCount++, color.setHex(hex));
    };
    const decorFree = (x: number, z: number, radius: number): boolean => (
      this.pointFree(x, z, radius, WATER_Y + 0.2, 16) &&
      !this.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r / 1.5 + radius)
    );

    // 雾松林场: 林下蘑菇簇与砍伐痕迹形成独有近景识别。
    const mistwood = regionById('mistwood');
    let mushroomClusters = 0;
    for (let t = 0; t < 1800 && mushroomClusters < 86; t++) {
      const x = mistwood.x + (rng() * 2 - 1) * mistwood.radius * 0.9;
      const z = mistwood.z + (rng() * 2 - 1) * mistwood.radius * 0.9;
      if (regionAt(x, z)?.id !== 'mistwood') continue;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.7 || h > 12 || this.slopeAt(x, z) > 0.46) continue;
      if (this.inPlot(x, z, 1.3) || this.nearRoad(x, z, 0.35)) continue;
      const size = 0.32 + rng() * 0.42;
      const capColor = rng() < 0.48 ? 0xb85d3d : rng() < 0.7 ? 0xd0a45a : 0x8b6a4a;
      rotation.setFromAxisAngle(up, rng() * Math.PI * 2);
      position.set(x, h + size * 0.24, z);
      scale.set(size * 0.16, size * 0.48, size * 0.16);
      matrix.compose(position, rotation, scale);
      mushroomStems.setMatrixAt(mushroomClusters, matrix);
      mushroomStems.setColorAt(mushroomClusters, color.setHex(0xd7c6a1));
      position.set(x, h + size * 0.53, z);
      scale.set(size * 0.48, size * 0.22, size * 0.48);
      matrix.compose(position, rotation, scale);
      mushroomCaps.setMatrixAt(mushroomClusters, matrix);
      mushroomCaps.setColorAt(mushroomClusters, color.setHex(capColor));
      mushroomClusters++;
    }

    // 丰禾农场: 贴坡浅土沟, 稻草人和手推木车。
    let farmChannels = 0;
    const furrowNormal = new THREE.Vector3();
    const furrowAlign = new THREE.Quaternion();
    for (let row = -4; row <= 4 && farmChannels < furrowCap; row++) {
      for (let segment = -5; segment <= 5 && farmChannels < furrowCap; segment++) {
        const x = -40 + row * 7.5;
        const z = 200 + segment * 5.5;
        const h = this.getHeight(x, z);
        if (
          h < WATER_Y + 0.35 || this.slopeAt(x, z) > 0.34 ||
          this.inPlot(x, z, 0.75) || this.inScenicSite(x, z, 0.4) || this.nearRoad(x, z, 0.25)
        ) continue;
        furrowNormal.set(
          this.getHeight(x - 0.7, z) - this.getHeight(x + 0.7, z),
          1.4,
          this.getHeight(x, z - 0.7) - this.getHeight(x, z + 0.7),
        ).normalize();
        furrowAlign.setFromUnitVectors(up, furrowNormal);
        position.set(x, h + 0.032, z);
        scale.set(0.46, 1, 4.75);
        matrix.compose(position, furrowAlign, scale);
        farmFurrows.setMatrixAt(farmChannels, matrix);
        farmFurrows.setColorAt(farmChannels, color.setHex(row % 2 === 0 ? 0x806a48 : 0x92764e));
        farmChannels++;
      }
    }
    let scarecrowCount = 0;
    for (const [x, z, yaw] of [[-70, 183, 0.2], [-11, 214, -0.3], [-72, 233, 0.15], [-17, 177, -0.2]] as const) {
      if (!decorFree(x, z, 0.45)) continue;
      const h = this.getHeight(x, z);
      addCylinder(x, h + 1.2, z, 0.1, 2.4, 0.1, 0x68503a, yaw);
      addBox(x, h + 1.55, z, 1.45, 0.09, 0.09, 0x80603d, yaw);
      addBox(x, h + 1.22, z, 0.58, 0.72, 0.28, 0xb8944f, yaw);
      addSphere(x, h + 2.15, z, 0.42, 0.5, 0.42, 0xcaa45f);
      scarecrowCount++;
    }
    let cartCount = 0;
    for (const [x, z, yaw] of [[-96, 166, 0.25], [-4, 238, -0.2], [-94, 250, 0.4]] as const) {
      if (!decorFree(x, z, 1.4)) continue;
      const h = this.getHeight(x, z);
      addBox(x, h + 0.68, z, 2.1, 0.55, 1.2, 0x7b5937, yaw);
      for (const side of [-1, 1]) {
        for (const end of [-0.68, 0.68]) {
          const wx = x + Math.cos(yaw) * end - Math.sin(yaw) * side * 0.72;
          const wz = z + Math.sin(yaw) * end + Math.cos(yaw) * side * 0.72;
          addCylinder(wx, h + 0.38, wz, 0.56, 0.18, 0.56, 0x332d27, yaw, Math.PI / 2);
        }
      }
      cartCount++;
    }

    // 潮汐渔港: 晾网架与岸线浮标。
    let netRackCount = 0;
    for (const [x, z, yaw] of [[180, -232, 0.25], [196, -244, -0.15], [218, -229, 0.35], [225, -207, -0.25], [188, -204, 0.1]] as const) {
      if (!decorFree(x, z, 1.7)) continue;
      const h = this.getHeight(x, z);
      const dx = Math.cos(yaw) * 1.45;
      const dz = Math.sin(yaw) * 1.45;
      addCylinder(x - dx, h + 1.35, z - dz, 0.12, 2.7, 0.12, 0x674c32);
      addCylinder(x + dx, h + 1.35, z + dz, 0.12, 2.7, 0.12, 0x674c32);
      addBox(x, h + 2.62, z, 3.15, 0.11, 0.11, 0x674c32, yaw);
      if (netCount < nets.count) {
        rotation.setFromAxisAngle(up, -yaw);
        position.set(x, h + 1.55, z);
        scale.set(2.7, 1.55, 1);
        matrix.compose(position, rotation, scale);
        nets.setMatrixAt(netCount++, matrix);
      }
      netRackCount++;
    }
    let buoyCount = 0;
    const harbor = regionById('tideharbor');
    for (let t = 0; t < 1800 && buoyCount < 32; t++) {
      const x = harbor.x + (rng() * 2 - 1) * harbor.radius * 0.72;
      const z = harbor.z + (rng() * 2 - 1) * harbor.radius * 0.72;
      const h = this.getHeight(x, z);
      if (Math.abs(h - WATER_Y) > 0.72 || this.inPlot(x, z, 0.6)) continue;
      const size = 0.22 + rng() * 0.18;
      addSphere(x, Math.max(WATER_Y + 0.08, h + size * 0.28), z, size, size * 1.18, size, buoyCount % 2 ? 0xd36d40 : 0xe2bd4c);
      buoyCount++;
    }

    // 磐石城: 明亮石盆、分层绿植和花簇替代无法辨识的暗色方盒。
    let cityPlanterCount = 0;
    this.cityPlanterPositions.length = 0;
    for (let t = 0; t < 700 && cityPlanterCount < 18; t++) {
      const x = -60 + (rng() * 2 - 1) * 78;
      const z = -20 + (rng() * 2 - 1) * 72;
      if (regionAt(x, z)?.id !== 'stonegate' || this.inPlot(x, z, 1.9) || !decorFree(x, z, 0.95)) continue;
      const h = this.getHeight(x, z);
      const yaw = rng() * Math.PI * 2;
      addCityPlanterBox(x, h + 0.24, z, 1.42, 0.48, 0.66, 0xc9b28a, yaw);
      addCityPlanterBox(x, h + 0.5, z, 1.28, 0.12, 0.54, 0xe0c99f, yaw);
      addCityPlanterSphere(x - Math.cos(yaw) * 0.32, h + 0.8, z - Math.sin(yaw) * 0.32, 0.72, 0.52, 0.68, 0x78a855);
      addCityPlanterSphere(x + Math.cos(yaw) * 0.32, h + 0.82, z + Math.sin(yaw) * 0.32, 0.66, 0.56, 0.64, 0x8bb961);
      for (let flower = -1; flower <= 1; flower++) {
        const offset = flower * 0.3;
        const flowerX = x + Math.cos(yaw) * offset;
        const flowerZ = z + Math.sin(yaw) * offset;
        const flowerColor = flower < 0 ? 0xd88771 : flower > 0 ? 0x8fa5d2 : 0xe2c45f;
        addCityPlanterSphere(flowerX, h + 1.12, flowerZ, 0.2, 0.24, 0.2, flowerColor);
      }
      this.cityPlanterPositions.push({ x, z });
      cityPlanterCount++;
    }

    // 教堂周边的小花池使用独立浅色材质和真实花株。
    // 旧实现复用通用 box/sphere 实例，背光时会变成“黑盒加三个黑球”，必须避免再次回退。
    const church = this.scenicSites.find((site) => site.kind === 'church');
    let churchBedCount = 0;
    let churchGardenPartCount = 0;
    this.churchGardenPlanterCount = 0;
    const gardenStone = new THREE.MeshStandardMaterial({
      color: 0xd9c8a6,
      emissive: 0x8f7b59,
      emissiveIntensity: 0.38,
      roughness: 0.96,
    });
    const gardenSoil = new THREE.MeshStandardMaterial({
      color: 0x76583a,
      emissive: 0x382719,
      emissiveIntensity: 0.22,
      roughness: 1,
    });
    const gardenStem = new THREE.MeshStandardMaterial({
      color: 0x5f8f49,
      emissive: 0x294622,
      emissiveIntensity: 0.32,
      roughness: 0.94,
    });
    const gardenPetals = [0xe89b86, 0xf0cf68, 0x9fb7e8, 0xe7b5ce].map((hex) => (
      new THREE.MeshStandardMaterial({
        color: hex,
        emissive: hex,
        emissiveIntensity: 0.3,
        roughness: 0.82,
      })
    ));
    applySurfaceAsset(gardenStone, 'stone', 2.8, 0.58);
    applySurfaceAsset(gardenSoil, 'terrain', 3.6, 0.46);
    if (church) {
      for (let i = 0; i < 10; i++) {
        const angle = i / 10 * Math.PI * 2;
        const x = church.x + Math.cos(angle) * 11.2;
        const z = church.z + Math.sin(angle) * 11.2;
        if (!decorFree(x, z, 0.72)) continue;
        const h = this.getHeight(x, z);
        const planter = new THREE.Group();
        planter.name = 'church-garden-planter';
        planter.position.set(x, h, z);
        planter.rotation.y = -angle;

        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.86, 0.3, 16), gardenStone);
        base.name = 'church-garden-planter-stone';
        base.position.y = 0.15;
        base.scale.z = 0.68;
        base.castShadow = true;
        base.receiveShadow = true;
        planter.add(base);

        const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.69, 0.69, 0.075, 16), gardenSoil);
        soil.name = 'church-garden-planter-soil';
        soil.position.y = 0.325;
        soil.scale.z = 0.66;
        soil.receiveShadow = true;
        planter.add(soil);

        for (let flower = 0; flower < 5; flower++) {
          const localX = (flower - 2) * 0.27;
          const localZ = flower % 2 === 0 ? -0.1 : 0.1;
          const stemHeight = 0.28 + (flower % 3) * 0.045;
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.025, stemHeight, 6), gardenStem);
          stem.name = 'church-garden-planter-stem';
          stem.position.set(localX, 0.35 + stemHeight / 2, localZ);
          stem.castShadow = true;
          planter.add(stem);

          const bloom = new THREE.Group();
          bloom.name = 'church-garden-planter-bloom';
          bloom.position.set(localX, 0.38 + stemHeight, localZ);
          for (let petal = 0; petal < 5; petal++) {
            const petalAngle = petal / 5 * Math.PI * 2;
            const petalMesh = new THREE.Mesh(
              new THREE.SphereGeometry(0.075, 7, 5),
              gardenPetals[(flower + i) % gardenPetals.length],
            );
            petalMesh.name = 'church-garden-planter-petal';
            petalMesh.position.set(Math.cos(petalAngle) * 0.07, 0, Math.sin(petalAngle) * 0.07);
            petalMesh.scale.set(1, 0.48, 0.72);
            petalMesh.castShadow = true;
            bloom.add(petalMesh);
          }
          const center = new THREE.Mesh(
            new THREE.SphereGeometry(0.045, 7, 5),
            gardenPetals[1],
          );
          center.name = 'church-garden-planter-center';
          center.position.y = 0.02;
          center.castShadow = true;
          bloom.add(center);
          planter.add(bloom);
        }
        scene.add(planter);
        churchGardenPartCount += 2 + 5 * 8;
        churchBedCount++;
      }
    }
    this.churchGardenPlanterCount = churchBedCount;

    boxes.count = boxCount;
    cylinders.count = cylinderCount;
    spheres.count = sphereCount;
    cityPlanterBases.count = cityPlanterBaseCount;
    cityPlanterFoliage.count = cityPlanterFoliageCount;
    nets.count = netCount;
    for (const mesh of [boxes, cylinders, spheres, cityPlanterBases, cityPlanterFoliage, nets]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = mesh !== nets;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    if (cylinders.instanceColor) cylinders.instanceColor.needsUpdate = true;
    if (spheres.instanceColor) spheres.instanceColor.needsUpdate = true;
    if (cityPlanterBases.instanceColor) cityPlanterBases.instanceColor.needsUpdate = true;
    if (cityPlanterFoliage.instanceColor) cityPlanterFoliage.instanceColor.needsUpdate = true;
    mushroomStems.count = mushroomClusters;
    mushroomCaps.count = mushroomClusters;
    mushroomStems.instanceMatrix.needsUpdate = true;
    mushroomCaps.instanceMatrix.needsUpdate = true;
    if (mushroomStems.instanceColor) mushroomStems.instanceColor.needsUpdate = true;
    if (mushroomCaps.instanceColor) mushroomCaps.instanceColor.needsUpdate = true;
    mushroomStems.computeBoundingSphere();
    mushroomCaps.computeBoundingSphere();
    mushroomStems.castShadow = true;
    mushroomCaps.castShadow = true;
    scene.add(mushroomStems, mushroomCaps);
    farmFurrows.count = farmChannels;
    this.farmFurrowCount = farmChannels;
    farmFurrows.instanceMatrix.needsUpdate = true;
    if (farmFurrows.instanceColor) farmFurrows.instanceColor.needsUpdate = true;
    farmFurrows.computeBoundingSphere();
    scene.add(farmFurrows);
    this.regionalIdentityDetailCount = boxCount + cylinderCount + sphereCount + cityPlanterBaseCount + cityPlanterFoliageCount + netCount + mushroomClusters * 2 + farmChannels + churchGardenPartCount;
    this.environmentDetailInstanceCount += this.regionalIdentityDetailCount;
    this.assetUsage.add(
      'map.landmark.regional-detail',
      mushroomClusters + farmChannels + scarecrowCount + cartCount + netRackCount + buoyCount + cityPlanterCount + churchBedCount,
    );
  }

  private addRegionalTacticalProps(scene: THREE.Scene): void {
    const mats = {
      concrete: new THREE.MeshStandardMaterial({ color: 0x777974, roughness: 0.95 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x806344, roughness: 0.94 }),
      hay: new THREE.MeshStandardMaterial({ color: 0xc6a84f, roughness: 1 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x58656a, roughness: 0.72, metalness: 0.22 }),
      sand: new THREE.MeshStandardMaterial({ color: 0x9b865b, roughness: 1 }),
    };
    applySurfaceAsset(mats.concrete, 'concrete', 2.4, 0.72);
    applySurfaceAsset(mats.wood, 'wood', 2.8, 0.78);
    applySurfaceAsset(mats.hay, 'foliage', 3.5, 0.62);
    applySurfaceAsset(mats.metal, 'paintedMetal', 3.1, 0.82);
    applySurfaceAsset(mats.sand, 'terrain', 2.2, 0.48);
    const box = (x: number, z: number, w: number, h: number, d: number, mat: THREE.Material, yaw = 0, block = true): void => {
      if (this.inPlot(x, z, Math.hypot(w, d) * 0.5 + 0.8)) return;
      const y = this.getHeight(x, z);
      if (y < WATER_Y + 0.12) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y + h / 2, z);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      if (block) {
        // 碰撞使用旋转后的保守 AABB，轻微放宽转角但不产生穿透。
        const cw = Math.abs(Math.cos(yaw)) * w + Math.abs(Math.sin(yaw)) * d;
        const cd = Math.abs(Math.sin(yaw)) * w + Math.abs(Math.cos(yaw)) * d;
        this.addCollider({ kind: 'aabb', minX: x - cw / 2, minY: y, minZ: z - cd / 2, maxX: x + cw / 2, maxY: y + h, maxZ: z + cd / 2, tag: 'wall' });
      }
    };
    // 磐石城: 混凝土路障和沙袋交错，形成可推进的街巷掩体。
    for (const [x, z, a] of [[-73, -8, 0.15], [-48, -38, -0.2], [-92, 12, 0.3], [-28, -3, -0.15]] as const) {
      box(x, z, 4.2, 0.9, 0.7, mats.concrete, a);
      box(x + 2.5, z + 1.2, 1.8, 0.65, 0.75, mats.sand, a + 0.25);
    }
    // 铁环竞技场: 场馆外围集装箱和拒马，适合绕侧与近距突击。
    for (const [x, z, a] of [[151, -60, 0], [208, -58, Math.PI / 2], [153, -14, 0.1], [211, -20, Math.PI / 2]] as const) {
      box(x, z, 5.4, 2.25, 2.15, mats.metal, a);
      box(x + Math.cos(a) * 3.7, z - Math.sin(a) * 3.7, 2.2, 0.8, 0.65, mats.concrete, a);
    }
    // 丰禾农场: 成组草垛和矮木栏，掩体高度支持蹲姿交火。
    for (const [x, z] of [[-82, 174], [-5, 176], [-76, 232], [-14, 246], [-102, 208]] as const) {
      box(x, z, 1.7, 1.25, 1.55, mats.hay, 0.2);
      box(x + 1.45, z + 0.55, 1.25, 0.9, 1.2, mats.hay, -0.15);
      box(x - 2.4, z - 0.8, 3.2, 0.8, 0.22, mats.wood, 0.1);
    }
    // 雾松林场: 原木堆和伐木箱，打断林下过长视线。
    for (const [x, z, a] of [[-34, -184, 0.4], [42, -218, -0.3], [-12, -256, 0.15], [66, -164, 0.8]] as const) {
      for (let i = 0; i < 3; i++) box(x, z + i * 0.48, 3.8, 0.42, 0.38, mats.wood, a);
      box(x + 2.8, z, 1.1, 0.95, 1.1, mats.wood, a);
    }
    // 鹰脊哨站: 岩灰胸墙与沙袋观察位，强调制高点防守。
    for (const [x, z, a] of [[-257, 15, 0.1], [-223, -12, -0.3], [-198, 39, 0.35], [-238, 58, -0.15]] as const) {
      box(x, z, 4.4, 0.95, 0.72, mats.concrete, a);
      box(x + 1.5, z + 1.1, 2.2, 0.62, 0.75, mats.sand, a + 0.45);
    }
    // 潮汐渔港: 防水货箱和鱼篓堆，沿岸形成短距离折线掩体。
    for (const [x, z, a] of [[176, -236, 0.25], [205, -250, -0.2], [232, -218, 0.4], [184, -198, -0.3]] as const) {
      box(x, z, 1.5, 1.2, 1.45, mats.wood, a);
      box(x + 1.3, z + 0.7, 1.05, 0.82, 1.0, mats.metal, -a);
    }
  }

  private addTacticalRouteLanes(scene: THREE.Scene): void {
    const mats: Record<TacticalCoverKind, THREE.MeshStandardMaterial> = {
      barrier: new THREE.MeshStandardMaterial({ color: 0x70736f, roughness: 0.96 }),
      crate: new THREE.MeshStandardMaterial({ color: 0x4f6066, roughness: 0.76, metalness: 0.2 }),
      hay: new THREE.MeshStandardMaterial({ color: 0xbfa24e, roughness: 1 }),
      logs: new THREE.MeshStandardMaterial({ color: 0x76593d, roughness: 0.98 }),
      breastwork: new THREE.MeshStandardMaterial({ color: 0x93815c, roughness: 1 }),
    };
    applySurfaceAsset(mats.barrier, 'concrete', 2.5, 0.7);
    applySurfaceAsset(mats.crate, 'paintedMetal', 3.1, 0.82);
    applySurfaceAsset(mats.hay, 'foliage', 3.5, 0.62);
    applySurfaceAsset(mats.logs, 'wood', 2.8, 0.82);
    applySurfaceAsset(mats.breastwork, 'terrain', 2.2, 0.5);
    const sizeOf = (kind: TacticalCoverKind, index: number): readonly [number, number, number] => {
      if (kind === 'crate') return index % 2 === 0 ? [1.65, 1.35, 1.55] : [2.5, 0.82, 0.72];
      if (kind === 'hay') return index % 2 === 0 ? [1.7, 1.25, 1.5] : [3.2, 0.78, 0.7];
      if (kind === 'logs') return [3.8, 0.82, 0.84];
      if (kind === 'breastwork') return [4.1, 0.82, 0.72];
      return [4.0, 0.86, 0.68];
    };
    for (const route of TACTICAL_ROUTES) {
      for (let i = 0; i < route.points.length; i++) {
        const point = route.points[i] as readonly [number, number];
        const prev = route.points[Math.max(0, i - 1)] as readonly [number, number];
        const next = route.points[Math.min(route.points.length - 1, i + 1)] as readonly [number, number];
        const [w, h, d] = sizeOf(route.cover, i);
        const yaw = Math.atan2(next[1] - prev[1], next[0] - prev[0]) + Math.PI / 2;
        const radius = Math.hypot(w, d) * 0.5;
        let x = point[0];
        let z = point[1];
        let y = this.getHeight(x, z);
        let placed = false;
        // 建筑和随机环境物可能占据设计节点, 在 6m 内做确定性螺旋偏移,
        // 保住掩体链密度的同时不把物件塞进房屋或树干。
        for (let attempt = 0; attempt < 19; attempt++) {
          const ring = attempt === 0 ? 0 : 2 + Math.floor((attempt - 1) / 6) * 2;
          const angle = attempt * 2.399963 + i * 0.71;
          const tx = point[0] + Math.cos(angle) * ring;
          const tz = point[1] + Math.sin(angle) * ring;
          const ty = this.getHeight(tx, tz);
          if (ty < WATER_Y + 0.2 || ty > 16 || this.slopeAt(tx, tz) > 0.7) continue;
          if (this.inPlot(tx, tz, radius + 0.45) || !this.pointFree(tx, tz, radius + 0.25, WATER_Y, 17)) continue;
          x = tx;
          z = tz;
          y = ty;
          placed = true;
          break;
        }
        if (!placed) continue;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[route.cover]);
        mesh.position.set(x, y + h / 2, z);
        mesh.rotation.y = yaw;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.tacticalRoute = route.id;
        scene.add(mesh);
        const cw = Math.abs(Math.cos(yaw)) * w + Math.abs(Math.sin(yaw)) * d;
        const cd = Math.abs(Math.sin(yaw)) * w + Math.abs(Math.cos(yaw)) * d;
        this.addCollider({
          kind: 'aabb',
          minX: x - cw / 2,
          minY: y,
          minZ: z - cd / 2,
          maxX: x + cw / 2,
          maxY: y + h,
          maxZ: z + cd / 2,
          tag: 'wall',
        });
        this.tacticalCoverCount++;
      }
    }
  }

  // 地图最终收口内容使用两组实例网格, 六区增加内容但只增加固定 draw call.
  private addFinalMapContent(scene: THREE.Scene): void {
    interface BoxInstance {
      x: number; y: number; z: number;
      w: number; h: number; d: number;
      yaw: number; color: number; surface: SurfaceAssetId;
    }
    interface CylinderInstance {
      x: number; y: number; z: number;
      diameter: number; length: number;
      axis: 'x' | 'y' | 'z'; color: number; surface: SurfaceAssetId;
    }
    const boxes: BoxInstance[] = [];
    const cylinders: CylinderInstance[] = [];
    this.mapSites.length = 0;
    this.mapLootSpots.length = 0;
    this.verticalSliceDetailCount = 0;
    this.forestFacilityDetailCount = 0;

    const addBox = (
      site: ResolvedMapContentSite,
      lx: number, lz: number,
      w: number, h: number, d: number,
      color: number, yaw = 0, block = true, lift = 0, surface: SurfaceAssetId = 'paintedMetal',
    ): void => {
      const x = site.resolvedX + lx;
      const z = site.resolvedZ + lz;
      const ground = this.getHeight(x, z);
      boxes.push({ x, y: ground + lift + h / 2, z, w, h, d, yaw, color, surface });
      if (!block) return;
      const cw = Math.abs(Math.cos(yaw)) * w + Math.abs(Math.sin(yaw)) * d;
      const cd = Math.abs(Math.sin(yaw)) * w + Math.abs(Math.cos(yaw)) * d;
      this.addCollider({
        kind: 'aabb', minX: x - cw / 2, minY: ground + lift, minZ: z - cd / 2,
        maxX: x + cw / 2, maxY: ground + lift + h, maxZ: z + cd / 2, tag: 'wall',
      });
    };
    const addCylinder = (
      site: ResolvedMapContentSite,
      lx: number, lz: number,
      diameter: number, length: number,
      color: number, axis: 'x' | 'y' | 'z' = 'y', block = false, lift = 0, surface: SurfaceAssetId = 'metal',
    ): void => {
      const x = site.resolvedX + lx;
      const z = site.resolvedZ + lz;
      const ground = this.getHeight(x, z);
      const visibleHeight = axis === 'y' ? length : diameter;
      cylinders.push({ x, y: ground + lift + visibleHeight / 2, z, diameter, length, axis, color, surface });
      if (block) {
        if (axis === 'y') {
          this.addCollider({
            kind: 'cyl', x, z, r: diameter / 2, y0: ground + lift, y1: ground + lift + length, tag: 'rock',
          });
        } else {
          const halfX = axis === 'x' ? length / 2 : diameter / 2;
          const halfZ = axis === 'z' ? length / 2 : diameter / 2;
          this.addCollider({
            kind: 'aabb', minX: x - halfX, minY: ground + lift, minZ: z - halfZ,
            maxX: x + halfX, maxY: ground + lift + diameter, maxZ: z + halfZ, tag: 'wall',
          });
        }
      }
    };

    for (const def of MAP_CONTENT_SITES) {
      const site = this.resolveMapContentSite(def);
      if (!site) continue;
      this.mapSites.push(site);
      this.verticalSliceDetailCount += this.buildMapContentKit(site, addBox, addCylinder);
      if (site.kind === 'market') {
        this.addStonegatePlazaSurface(scene, site);
        this.verticalSliceDetailCount += 1 + this.addStonegateMarketProps(scene, site);
      }
    }

    if (boxes.length > 0) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const color = new THREE.Color();
      for (const surface of [...new Set(boxes.map((item) => item.surface))]) {
        const items = boxes.filter((item) => item.surface === surface);
        const spec = SURFACE_MATERIAL_PRESETS[surface];
        const material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: spec.roughness,
          metalness: spec.metalness,
        });
        applySurfaceAsset(material, surface, spec.scale, spec.strength);
        const mesh = new THREE.InstancedMesh(geometry, material, items.length);
        for (let i = 0; i < items.length; i++) {
          const item = items[i] as BoxInstance;
          position.set(item.x, item.y, item.z);
          quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.yaw);
          scale.set(item.w, item.h, item.d);
          matrix.compose(position, quaternion, scale);
          mesh.setMatrixAt(i, matrix);
          mesh.setColorAt(i, color.setHex(item.color));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        scene.add(mesh);
      }
    }

    if (cylinders.length > 0) {
      const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const color = new THREE.Color();
      for (const surface of [...new Set(cylinders.map((item) => item.surface))]) {
        const items = cylinders.filter((item) => item.surface === surface);
        const spec = SURFACE_MATERIAL_PRESETS[surface];
        const material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: spec.roughness,
          metalness: spec.metalness,
        });
        applySurfaceAsset(material, surface, spec.scale, spec.strength);
        const mesh = new THREE.InstancedMesh(geometry, material, items.length);
        for (let i = 0; i < items.length; i++) {
          const item = items[i] as CylinderInstance;
          position.set(item.x, item.y, item.z);
          quaternion.identity();
          if (item.axis === 'x') quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
          else if (item.axis === 'z') quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
          scale.set(item.diameter, item.length, item.diameter);
          matrix.compose(position, quaternion, scale);
          mesh.setMatrixAt(i, matrix);
          mesh.setColorAt(i, color.setHex(item.color));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        scene.add(mesh);
      }
    }

    for (const site of this.mapSites) this.addMapContentLootSpots(site);
    this.addScenicLootSpots();
  }

  private resolveMapContentSite(def: (typeof MAP_CONTENT_SITES)[number]): ResolvedMapContentSite | null {
    const maxAttempts = def.kind === 'lumber' ? 360 : 180;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ring = attempt === 0 ? 0 : 3.5 + Math.floor((attempt - 1) / 10) * 3;
      const angle = attempt * 2.399963;
      const x = def.x + Math.cos(angle) * ring;
      const z = def.z + Math.sin(angle) * ring;
      if (regionAt(x, z)?.id !== def.region) continue;
      if (this.inPlot(x, z, 5.2) || this.inScenicSite(x, z, 3.5)) continue;
      // 木场的构筑物跨度较大, 但只需保证中心活动区不与树石重叠.
      // 外圈单独做十二向地形探测, 避免大半径碰撞检查被林区植被误判为无可用场地.
      const footprintRadius = def.kind === 'lumber' ? 7.2 : 4.8;
      const collisionClearance = 4.8;
      if (this.slopeAt(x, z) > 0.42 || !this.pointFree(x, z, collisionClearance, WATER_Y + 0.35, 16)) continue;
      let footprintOnLand = true;
      for (let probe = 0; probe < 12; probe++) {
        const angle = probe / 12 * Math.PI * 2;
        const px = x + Math.cos(angle) * footprintRadius;
        const pz = z + Math.sin(angle) * footprintRadius;
        if (this.getHeight(px, pz) < WATER_Y + 0.55 || this.slopeAt(px, pz) > 0.55) {
          footprintOnLand = false;
          break;
        }
      }
      if (!footprintOnLand) continue;
      return { ...def, resolvedX: x, resolvedZ: z };
    }
    return null;
  }

  // 连续细分网格逐顶点贴合地形, 旧城石铺地不会在缓坡上悬空或形成巨型台阶.
  private addStonegatePlazaSurface(scene: THREE.Scene, site: ResolvedMapContentSite): void {
    const width = 13.6;
    const depth = 11.2;
    const geometry = new THREE.PlaneGeometry(width, depth, 17, 14);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(positions.count * 3);
    const base = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const localX = positions.getX(i);
      const localZ = positions.getZ(i);
      positions.setY(i, this.getHeight(site.resolvedX + localX, site.resolvedZ + localZ) + 0.035);
      const checker = (Math.floor((localX + width / 2) / 1.7) + Math.floor((localZ + depth / 2) / 1.4)) & 1;
      base.setHex(checker === 0 ? 0x8c8981 : 0x817f78);
      const wear = 0.94 + (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.08;
      colors[i * 3] = base.r * wear;
      colors[i * 3 + 1] = base.g * wear;
      colors[i * 3 + 2] = base.b * wear;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    applySurfaceAsset(material, 'stone', 1.35, 0.78);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(site.resolvedX, 0, site.resolvedZ);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // 旧城市场使用少量实例化的非盒体道具，补齐布袋、果蔬、木桶、藤篮和彩旗的轮廓语言。
  private addStonegateMarketProps(scene: THREE.Scene, site: ResolvedMapContentSite): number {
    interface PropTransform {
      x: number; z: number; lift: number;
      sx: number; sy: number; sz: number;
      yaw?: number; color?: number;
    }
    const addInstances = (
      geometry: THREE.BufferGeometry,
      material: THREE.MeshStandardMaterial,
      transforms: readonly PropTransform[],
    ): void => {
      const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const color = new THREE.Color();
      for (let i = 0; i < transforms.length; i++) {
        const prop = transforms[i] as PropTransform;
        const x = site.resolvedX + prop.x;
        const z = site.resolvedZ + prop.z;
        position.set(x, this.getHeight(x, z) + prop.lift, z);
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.yaw ?? 0);
        scale.set(prop.sx, prop.sy, prop.sz);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
        if (prop.color !== undefined) mesh.setColorAt(i, color.setHex(prop.color));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    };

    const wood = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const fabric = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 });
    const produce = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x4d5658, roughness: 0.58, metalness: 0.22 });
    applySurfaceAsset(wood, 'wood', 3.1, 0.78);
    applySurfaceAsset(fabric, 'fabric', 4.0, 0.7);
    applySurfaceAsset(produce, 'foliage', 4.6, 0.48);
    applySurfaceAsset(metal, 'metal', 3.5, 0.55);

    const barrels: PropTransform[] = [
      { x: -4.2, z: -2.65, lift: 0.42, sx: 0.82, sy: 1.05, sz: 0.82, yaw: 0.08, color: 0x76523a },
      { x: -3.55, z: -2.82, lift: 0.38, sx: 0.7, sy: 0.94, sz: 0.7, yaw: -0.12, color: 0x624531 },
      { x: 4.05, z: 2.08, lift: 0.4, sx: 0.76, sy: 1, sz: 0.76, color: 0x815b3c },
    ];
    addInstances(new THREE.CylinderGeometry(0.42, 0.46, 0.8, 12, 2), wood, barrels);

    const sacks: PropTransform[] = [
      { x: -1.95, z: 0.72, lift: 1.12, sx: 0.52, sy: 0.68, sz: 0.46, yaw: 0.18, color: 0xbda579 },
      { x: -2.52, z: 0.65, lift: 1.08, sx: 0.46, sy: 0.6, sz: 0.42, yaw: -0.22, color: 0xc7ae7b },
      { x: 2.05, z: 0.78, lift: 1.1, sx: 0.5, sy: 0.64, sz: 0.44, yaw: 0.3, color: 0xa99a77 },
      { x: 2.65, z: 0.68, lift: 1.08, sx: 0.44, sy: 0.57, sz: 0.4, yaw: -0.16, color: 0xc1aa83 },
      { x: 4.72, z: -1.0, lift: 0.34, sx: 0.56, sy: 0.7, sz: 0.5, yaw: 0.2, color: 0xbca477 },
    ];
    addInstances(new THREE.SphereGeometry(0.5, 10, 7), fabric, sacks);

    const baskets: PropTransform[] = [
      { x: -3.1, z: 1.12, lift: 0.98, sx: 0.68, sy: 0.62, sz: 0.68, color: 0x9a7047 },
      { x: 3.15, z: 1.1, lift: 0.98, sx: 0.66, sy: 0.58, sz: 0.66, color: 0xa77a4d },
      { x: 4.55, z: 1.52, lift: 0.2, sx: 0.72, sy: 0.55, sz: 0.72, yaw: 0.15, color: 0x8e6745 },
    ];
    addInstances(new THREE.CylinderGeometry(0.44, 0.34, 0.34, 12, 2, true), wood, baskets);

    const fruitColors = [0xb84636, 0xd5963e, 0x6f8b48, 0xa75338];
    const fruits: PropTransform[] = [];
    for (let stall = 0; stall < 2; stall++) {
      const centerX = stall === 0 ? -2.65 : 2.62;
      for (let i = 0; i < 12; i++) {
        fruits.push({
          x: centerX + (i % 4 - 1.5) * 0.28,
          z: -0.18 + Math.floor(i / 4) * 0.28,
          lift: 1.02 + ((i * 7) % 3) * 0.06,
          sx: 0.16 + (i % 2) * 0.025,
          sy: 0.14 + (i % 3) * 0.018,
          sz: 0.16 + ((i + 1) % 2) * 0.025,
          color: fruitColors[(i + stall) % fruitColors.length] as number,
        });
      }
    }
    addInstances(new THREE.IcosahedronGeometry(0.5, 1), produce, fruits);

    const pennantGeo = new THREE.BufferGeometry();
    pennantGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.22, 0, 0, 0.22, 0, 0, 0, -0.42, 0,
    ], 3));
    pennantGeo.computeVertexNormals();
    const pennantMat = fabric.clone();
    pennantMat.side = THREE.DoubleSide;
    const pennants: PropTransform[] = [];
    const pennantColors = [0xa84c3f, 0xd1aa58, 0x5b7780, 0x748253];
    for (let i = 0; i < 13; i++) {
      pennants.push({
        x: -4.5 + i * 0.75,
        z: 2.72,
        lift: 3.25 - (1 - Math.abs(i - 6) / 6) * 0.16,
        sx: 1,
        sy: 1,
        sz: 1,
        color: pennantColors[i % pennantColors.length] as number,
      });
    }
    addInstances(pennantGeo, pennantMat, pennants);

    const lampMaterial = new THREE.MeshStandardMaterial({
      color: 0xffd48a,
      emissive: 0xff9b3d,
      emissiveIntensity: 2.1,
      roughness: 0.34,
    });
    addInstances(new THREE.SphereGeometry(0.5, 8, 6), lampMaterial, [
      { x: -5.55, z: -4.45, lift: 3.2, sx: 0.18, sy: 0.14, sz: 0.18 },
      { x: 5.55, z: 4.45, lift: 3.2, sx: 0.18, sy: 0.14, sz: 0.18 },
      { x: 0, z: 2.7, lift: 3.12, sx: 0.13, sy: 0.11, sz: 0.13 },
    ]);
    const warm = new THREE.PointLight(0xffbd72, 2.2, 9, 1.9);
    warm.position.set(site.resolvedX, this.getHeight(site.resolvedX, site.resolvedZ + 2.7) + 3.05, site.resolvedZ + 2.7);
    scene.add(warm);
    return barrels.length + sacks.length + baskets.length + fruits.length + pennants.length + 3;
  }

  private buildMapContentKit(
    site: ResolvedMapContentSite,
    box: (
      site: ResolvedMapContentSite,
      lx: number, lz: number,
      w: number, h: number, d: number,
      color: number, yaw?: number, block?: boolean, lift?: number, surface?: SurfaceAssetId,
    ) => void,
    cylinder: (
      site: ResolvedMapContentSite,
      lx: number, lz: number,
      diameter: number, length: number,
      color: number, axis?: 'x' | 'y' | 'z', block?: boolean, lift?: number, surface?: SurfaceAssetId,
    ) => void,
  ): number {
    const wood = 0x765437;
    const woodDark = 0x493728;
    const metal = 0x55636a;
    const canvas = 0xd0b774;
    const red = 0x9e493d;
    const blue = 0x486d82;
    const concrete = 0x858780;
    const kit = site.kind as MapContentKind;
    let verticalSliceDetails = 0;
    const detailBox = (...args: Parameters<typeof box>): void => {
      box(...args);
      verticalSliceDetails++;
      if (kit === 'lumber') this.forestFacilityDetailCount++;
    };
    const detailCylinder = (...args: Parameters<typeof cylinder>): void => {
      cylinder(...args);
      verticalSliceDetails++;
      if (kit === 'lumber') this.forestFacilityDetailCount++;
    };

    if (kit === 'market') {
      // 连续石铺网格由场景层生成, 路肩拆成短模块逐段贴地.
      for (const z of [-5.48, 5.48]) {
        for (let segment = -3; segment <= 3; segment++) {
          const x = segment * 1.86;
          detailBox(site, x, z, 1.76, 0.16, 0.3, 0xaaa497, 0, false, 0.035, 'stone');
          detailBox(site, x, z + (z < 0 ? 0.26 : -0.26), 1.68, 0.025, 0.18, 0x3f4748, 0, false, 0.045, 'metal');
        }
      }
      for (const x of [-2.6, 2.6]) {
        box(site, x, 0, 2.2, 0.82, 1.25, wood, 0, true, 0, 'wood');
        box(site, x, 0, 2.8, 0.16, 2.2, x < 0 ? red : canvas, 0, false, 2.15, 'fabric');
        for (const z of [-0.9, 0.9]) cylinder(site, x - 1, z, 0.12, 2.25, woodDark, 'y', false, 0, 'wood');
        // 摊位台面边框、货箱和悬挂布条形成前中后三级细节.
        detailBox(site, x, -0.52, 2.28, 0.11, 0.12, 0x4d3929, 0, false, 0.77, 'wood');
        for (const dx of [-0.62, 0, 0.62]) {
          detailBox(site, x + dx, 0.2, 0.46, 0.34, 0.46, dx === 0 ? 0x667c57 : 0x9b7451, 0.08 * dx, false, 0.84, dx === 0 ? 'foliage' : 'wood');
        }
        for (const dz of [-0.72, 0, 0.72]) {
          detailBox(site, x - 0.98, dz, 0.08, 0.42, 0.22, dz === 0 ? 0xc7a95e : 0xa75e4b, 0, false, 1.36, 'fabric');
        }
      }
      box(site, 0, -3.5, 5.6, 0.75, 0.55, concrete, 0, true, 0, 'stonegateBrick');
      box(site, 0, -3.5, 1.9, 0.3, 0.62, red, 0, false, 0.76, 'paintedMetal');
      // 横跨摊位的旧城招牌和暖色灯箱形成街口识别轮廓。
      for (const x of [-3.9, 3.9]) cylinder(site, x, 2.8, 0.14, 3.15, woodDark, 'y', false, 0, 'wood');
      box(site, 0, 2.8, 7.7, 0.18, 0.18, woodDark, 0, false, 2.82, 'wood');
      box(site, 0, 2.77, 2.9, 0.62, 0.12, canvas, 0, false, 2.95, 'wood');
      // 砖门柱、层叠檐口、旧式路灯和架空线缆建立旧城入口轮廓.
      for (const x of [-4.35, 4.35]) {
        detailBox(site, x, 2.78, 0.58, 3.35, 0.58, 0x98705f, 0, false, 0, 'stonegateBrick');
        detailBox(site, x, 2.78, 0.78, 0.18, 0.78, 0xb7aa96, 0, false, 3.32, 'stone');
      }
      detailBox(site, 0, 2.78, 8.25, 0.16, 0.28, 0x9c7562, 0, false, 3.32, 'stonegateBrick');
      for (const [x, z] of [[-5.55, -4.45], [5.55, 4.45]] as const) {
        detailCylinder(site, x, z, 0.14, 3.55, 0x3f484b, 'y', false, 0, 'metal');
        detailBox(site, x, z, 0.62, 0.14, 0.28, 0x4e585a, 0, false, 3.36, 'metal');
        detailBox(site, x, z, 0.28, 0.2, 0.22, 0xe2b66c, 0, false, 3.18, 'paintedMetal');
      }
      detailCylinder(site, 0, -4.45, 0.045, 11.1, 0x333839, 'x', false, 3.38, 'metal');
      detailCylinder(site, 0, 4.45, 0.045, 11.1, 0x333839, 'x', false, 3.38, 'metal');
      // 长凳、花池、手推车和排水井盖补齐可读的生活痕迹.
      for (const x of [-5.15, 5.15]) {
        detailBox(site, x, -1.55, 1.5, 0.12, 0.48, 0x66503c, 0, true, 0.55, 'wood');
        for (const dx of [-0.58, 0.58]) detailBox(site, x + dx, -1.55, 0.1, 0.55, 0.42, 0x414849, 0, false, 0, 'metal');
      }
      for (const z of [-2.8, 2.1]) {
        detailBox(site, -5.05, z, 1.2, 0.5, 1.2, 0x9a7461, 0, true, 0, 'stonegateBrick');
        for (const dx of [-0.28, 0, 0.28]) detailBox(site, -5.05 + dx, z, 0.2, 0.48 + (dx === 0 ? 0.14 : 0), 0.2, 0x667c55, 0, false, 0.48, 'foliage');
      }
      detailBox(site, 4.85, -3.1, 1.65, 0.18, 0.85, 0x6a523d, -0.12, true, 0.48, 'wood');
      detailCylinder(site, 4.25, -3.52, 0.42, 0.16, 0x343a3b, 'z', false, 0.12, 'metal');
      detailCylinder(site, 5.45, -3.52, 0.42, 0.16, 0x343a3b, 'z', false, 0.12, 'metal');
      detailBox(site, 0.35, 4.15, 1.2, 0.035, 0.72, 0x343b3d, 0, false, 0.06, 'metal');
    } else if (kit === 'freight') {
      box(site, -2.4, -1.6, 5.2, 2.15, 2.05, blue, 0.12, true);
      box(site, 2.5, 1.7, 5.2, 2.15, 2.05, red, -0.1, true);
      for (const x of [-3.4, 3.4]) cylinder(site, x, -4.2, 0.22, 3.3, metal);
      box(site, 0, -4.2, 7, 0.28, 0.35, metal, 0, false, 3.05);
      box(site, 0, -4.15, 2.8, 1.05, 0.22, canvas, 0, false, 3.3);
      // 低矮龙门吊补足竞技场工业天际线，不侵占箱间战术通道。
      for (const x of [-4.8, 4.8]) cylinder(site, x, 4.2, 0.2, 5.4, metal);
      box(site, 0, 4.2, 9.8, 0.22, 0.28, red, 0, false, 5.05);
      box(site, 3.2, 4.2, 0.18, 1.35, 0.18, canvas, 0, false, 3.72);
    } else if (kit === 'grain') {
      cylinder(site, -2.2, 0, 3.2, 6.4, 0xb5aa8b, 'y', true);
      cylinder(site, -2.2, 0, 2.45, 1.0, 0x8f6f4b, 'y', false, 6.2);
      box(site, 2.5, 0.4, 3.6, 2.5, 3.2, wood, 0.08, true);
      box(site, 2.5, 0.4, 4.1, 0.24, 3.7, red, 0.08, false, 2.48);
      cylinder(site, 0.6, -3.3, 0.2, 5.2, metal);
      box(site, 0.6, -3.3, 2.8, 0.15, 0.22, canvas, 0, false, 4.55);
      // 粮仓风向标和仓号牌让农场从远处即可辨认。
      box(site, -2.2, 0, 0.14, 1.55, 0.14, metal, 0, false, 7.05);
      box(site, -2.2, 0, 1.35, 0.11, 0.12, red, 0, false, 7.72);
      box(site, 2.5, -1.23, 1.2, 0.75, 0.08, canvas, 0.08, false, 1.15);
    } else if (kit === 'lumber') {
      for (let row = 0; row < 3; row++) {
        for (let level = 0; level < 2; level++) {
          cylinder(site, -2.8 + level * 0.62, -1.6 + row * 1.5, 0.5, 4.2, wood, 'x', true);
        }
      }
      box(site, 2.2, 0.4, 3.1, 0.9, 1.4, woodDark, 0.1, true);
      box(site, 2.2, 0.4, 3.6, 0.16, 2.4, 0x687052, 0.1, false, 0.92);
      box(site, 0.2, 4.0, 5.4, 0.78, 0.72, wood, 0.05, true);
      // 锯木棚门架与吊挂横梁强调林场加工区身份。
      for (const x of [-3.5, 3.5]) cylinder(site, x, 4.9, 0.18, 3.25, woodDark);
      box(site, 0, 4.9, 7.1, 0.2, 0.24, wood, 0, false, 2.95);
      box(site, 0, 4.86, 2.5, 0.52, 0.1, 0x687052, 0, false, 3.06);

      // 护林员木屋: 用分段墙体保留真实门洞，台基、窗框、门廊和分层屋檐形成完整建筑轮廓。
      detailBox(site, 4.5, -4.0, 5.1, 0.24, 3.9, 0x8c806a, 0, true, 0, 'stone');
      detailBox(site, 4.5, -5.68, 4.8, 2.35, 0.22, 0x8b6847, 0, true, 0.24, 'wood');
      for (const x of [2.2, 6.8]) {
        detailBox(site, x, -4.0, 0.22, 2.35, 3.55, 0x8b6847, 0, true, 0.24, 'wood');
      }
      detailBox(site, 3.0, -2.28, 1.6, 2.35, 0.22, 0x8b6847, 0, true, 0.24, 'wood');
      detailBox(site, 6.05, -2.28, 1.5, 2.35, 0.22, 0x8b6847, 0, true, 0.24, 'wood');
      detailBox(site, 4.5, -2.15, 1.22, 2.04, 0.12, 0x4d3526, 0, false, 0.25, 'wood');
      for (const x of [3.15, 5.85]) {
        detailBox(site, x, -2.14, 0.84, 0.78, 0.08, 0x36545b, 0, false, 1.08, 'paintedMetal');
        detailBox(site, x, -2.1, 0.94, 0.09, 0.12, 0xd1c3a5, 0, false, 1.0, 'wood');
      }
      detailBox(site, 4.5, -4.0, 5.45, 0.18, 4.35, 0x59654b, 0, false, 2.62, 'roof');
      detailBox(site, 4.5, -4.0, 4.75, 0.16, 3.62, 0x6c7658, 0, false, 2.79, 'roof');
      detailBox(site, 4.5, -4.0, 0.34, 0.18, 4.05, 0x49392d, 0, false, 2.94, 'roof');
      detailBox(site, 2.92, -4.82, 0.48, 1.18, 0.48, 0x665f58, 0, false, 2.72, 'stone');
      detailBox(site, 4.5, -1.72, 3.15, 0.18, 1.05, 0x7a5c3f, 0, true, 0.08, 'wood');
      detailBox(site, 4.5, -1.72, 3.4, 0.14, 1.36, 0x59654b, 0, false, 2.25, 'roof');
      detailBox(site, 5.35, -2.04, 0.18, 0.26, 0.16, 0xe4b769, 0, false, 1.78, 'paintedMetal');

      // 林火瞭望台和工具区让树林拥有远近两级地标，而不是只在地面散放原木。
      const towerX = -5.1;
      const towerZ = 4.15;
      for (const dx of [-0.88, 0.88]) {
        for (const dz of [-0.88, 0.88]) {
          detailCylinder(site, towerX + dx, towerZ + dz, 0.16, 3.45, woodDark, 'y', true, 0, 'wood');
        }
      }
      detailBox(site, towerX, towerZ, 2.55, 0.22, 2.55, wood, 0, true, 2.82, 'wood');
      for (const z of [towerZ - 1.12, towerZ + 1.12]) {
        detailBox(site, towerX, z, 2.45, 0.12, 0.12, woodDark, 0, false, 3.82, 'wood');
      }
      for (const x of [towerX - 1.12, towerX + 1.12]) {
        detailBox(site, x, towerZ, 0.12, 0.12, 2.45, woodDark, 0, false, 3.82, 'wood');
      }
      detailBox(site, towerX, towerZ, 3.05, 0.18, 3.05, 0x59654b, 0, false, 4.42, 'roof');
      for (let rung = 0; rung < 6; rung++) {
        detailBox(site, towerX + 1.15, towerZ - 1.35, 0.76, 0.08, 0.1, wood, 0, false, 0.55 + rung * 0.48, 'wood');
      }
      detailBox(site, -0.1, 2.55, 2.45, 0.72, 1.15, woodDark, 0, true, 0, 'wood');
      detailCylinder(site, -0.1, 1.94, 1.05, 0.12, metal, 'z', false, 0.86, 'metal');
      detailBox(site, 1.05, 2.55, 0.16, 1.28, 0.16, metal, 0, false, 0.05, 'metal');
    } else if (kit === 'relay') {
      cylinder(site, 0, 0, 0.28, 10.5, metal, 'y', true);
      box(site, 0, 0, 5.8, 0.16, 0.16, metal, 0, false, 4.2);
      box(site, 0, 0, 3.8, 0.16, 0.16, metal, Math.PI / 2, false, 7.3);
      box(site, 0, 0, 0.7, 0.7, 0.18, red, 0, false, 9.55);
      box(site, -2.4, 2.8, 2.4, 1.65, 1.8, concrete, 0.12, true);
      box(site, 2.5, 2.5, 2.2, 1.2, 1.7, metal, -0.08, true);
      for (const x of [-3.6, 3.6]) box(site, x, -3.2, 3.2, 0.75, 0.62, concrete, x < 0 ? 0.25 : -0.25, true);
      // 错位竖向接收板取代穿过主杆的横臂，保留通信塔识别度但不形成十字剪影。
      for (const [index, lift] of [2.2, 5.5, 8.6].entries()) {
        box(site, index % 2 === 0 ? -0.5 : 0.5, 0, 0.24, 0.72, 0.12,
          lift > 5 ? red : canvas, 0, false, lift);
      }
      for (const x of [-1.5, 1.5]) cylinder(site, x, 1.15, 0.11, 4.6, metal);
    } else {
      for (const x of [-2.5, 2.5]) {
        box(site, x, 0, 3.1, 0.86, 1.2, wood, 0, true);
        box(site, x, 0, 3.5, 0.18, 2.4, x < 0 ? blue : canvas, 0, false, 2.35);
        for (const z of [-0.95, 0.95]) cylinder(site, x - 1.35, z, 0.14, 2.5, woodDark);
      }
      box(site, 0, -3.6, 4.8, 1.0, 1.1, metal, 0.08, true);
      cylinder(site, 0, 3.8, 0.22, 5.8, metal);
      box(site, 0, 3.8, 1.6, 0.42, 0.35, red, 0, false, 5.15);
      // 鱼市入口门架和蓝黄双色横牌连接码头视觉语言。
      for (const x of [-3.7, 3.7]) cylinder(site, x, -4.9, 0.16, 3.4, woodDark);
      box(site, 0, -4.9, 7.5, 0.16, 0.2, blue, 0, false, 3.12);
      box(site, 0, -4.86, 2.7, 0.55, 0.1, canvas, 0, false, 3.22);
    }
    return verticalSliceDetails;
  }

  private addMapContentLootSpots(site: ResolvedMapContentSite): void {
    const maxSpots = regionById(site.region).landmarkLootSpots;
    for (let i = 0; i < maxSpots; i++) {
      let found = false;
      for (let step = 0; step < 8; step++) {
        const angle = i * 2.399963 + 0.55 + step * 0.31;
        const distance = 6.2 + (i % 2) * 2.35 + step * 1.15;
        const x = site.resolvedX + Math.cos(angle) * distance;
        const z = site.resolvedZ + Math.sin(angle) * distance;
        if (!this.pointFree(x, z, 0.42, WATER_Y + 0.25, 17)) continue;
        const terrainY = this.getHeight(x, z);
        this.mapLootSpots.push({
          // 地标附近可能有矮台、栈板或台阶, 物资应落在可站立顶面而不是埋进其下方.
          x, y: this.groundHeight(x, z, terrainY + 1.2), z,
          premium: i < site.premiumSpots,
          region: site.region,
          siteId: site.id,
        });
        found = true;
        break;
      }
      if (!found) continue;
    }
  }

  private addScenicLootSpots(): void {
    const church = this.scenicSites.find((site) => site.kind === 'church');
    if (!church) return;
    const region = regionAt(church.x, church.z);
    if (!region || region.id === 'wilderness') return;
    const floorY = this.churchFloorTop(church);
    const centerZ = church.z - 5;
    const interior = [
      [church.x, centerZ + 2.0, false],
      [church.x, centerZ - 3.2, true],
      [church.x + 4.9, centerZ - 7.8, true],
    ] as const;
    for (const [x, z, premium] of interior) {
      this.mapLootSpots.push({
        x, y: floorY, z, premium,
        region: region.id, siteId: 'stonegate-church',
      });
    }
    const plazaX = church.x + 4.1;
    const plazaZ = church.z + 14;
    this.mapLootSpots.push({
      x: plazaX, y: this.churchPlazaTop(church), z: plazaZ,
      premium: false, region: region.id, siteId: 'stonegate-church-plaza',
    });
  }

  private addDistantLandforms(scene: THREE.Scene): void {
    const rng = mulberry32(60491);
    const ridgeA = new THREE.InstancedMesh(
      makeDistantRidgeGeometry(0.4),
      new THREE.MeshBasicMaterial({ color: 0x89958f, fog: true }),
      14,
    );
    const ridgeB = new THREE.InstancedMesh(
      makeDistantRidgeGeometry(2.1),
      new THREE.MeshBasicMaterial({ color: 0x9aa39a, fog: true }),
      14,
    );
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    let countA = 0;
    let countB = 0;
    for (let i = 0; i < 14; i++) {
      const angle = i / 14 * Math.PI * 2 + (rng() - 0.5) * 0.28;
      const radius = 472 + rng() * 78;
      const width = 54 + rng() * 42;
      position.set(Math.cos(angle) * radius, -7.5 - rng() * 2.5, Math.sin(angle) * radius);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
      scale.set(width, 17 + rng() * 16, width * (0.72 + rng() * 0.45));
      matrix.compose(position, rotation, scale);
      const mesh = i % 2 === 0 ? ridgeA : ridgeB;
      const index = i % 2 === 0 ? countA++ : countB++;
      mesh.setMatrixAt(index, matrix);
    }
    ridgeA.count = countA;
    ridgeB.count = countB;
    ridgeA.instanceMatrix.needsUpdate = true;
    ridgeB.instanceMatrix.needsUpdate = true;
    ridgeA.computeBoundingSphere();
    ridgeB.computeBoundingSphere();
    ridgeA.renderOrder = -2;
    ridgeB.renderOrder = -2;
    scene.add(ridgeA, ridgeB);
    this.distantLandformCount = countA + countB;
    this.environmentDetailInstanceCount += this.distantLandformCount;
  }

  private addGroundEcology(scene: THREE.Scene): void {
    const budget = naturalDetailBudget(navigator.hardwareConcurrency);
    const rng = mulberry32(31871);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();

    const fernMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true, side: THREE.DoubleSide,
    });
    this.addSway(fernMaterial, 0.045, 0, 0.5, true, true, 90, 128);
    const ferns = new THREE.InstancedMesh(makeFernGeometry(), fernMaterial, budget.understory);
    let fernCount = 0;
    for (let t = 0; t < budget.understory * 12 && fernCount < budget.understory; t++) {
      const x = (rng() * 2 - 1) * 325;
      const z = -110 - rng() * 220;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.65 || h > 12.5 || this.slopeAt(x, z) > 0.5) continue;
      if (this.inPlot(x, z, 1.7) || this.inScenicSite(x, z, 0.8) || this.nearRoad(x, z, 0.55)) continue;
      const size = 0.72 + rng() * 0.82;
      position.set(x, h + 0.01, z);
      rotation.setFromAxisAngle(up, rng() * Math.PI * 2);
      scale.set(size, size * (0.78 + rng() * 0.38), size);
      matrix.compose(position, rotation, scale);
      ferns.setMatrixAt(fernCount, matrix);
      tint.setHex(rng() < 0.25 ? 0x76954d : 0x4d7b45).multiplyScalar(0.86 + rng() * 0.24);
      ferns.setColorAt(fernCount++, tint);
    }
    ferns.count = fernCount;
    ferns.instanceMatrix.needsUpdate = true;
    if (ferns.instanceColor) ferns.instanceColor.needsUpdate = true;
    ferns.computeBoundingSphere();
    ferns.receiveShadow = true;
    scene.add(ferns);

    const flowerMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true, side: THREE.DoubleSide,
    });
    this.addSway(flowerMaterial, 0.035, 0.1, 0.58, true, true, 78, 112);
    const flowers = new THREE.InstancedMesh(makeWildflowerGeometry(), flowerMaterial, budget.flowers);
    const flowerPalette = [0xf3d36b, 0xe9a4b2, 0xc8c9ef, 0xf0efe0, 0xe2a45b] as const;
    let flowerCount = 0;
    for (let t = 0; t < budget.flowers * 15 && flowerCount < budget.flowers; t++) {
      const x = (rng() * 2 - 1) * 325;
      const z = (rng() * 2 - 1) * 325;
      const h = this.getHeight(x, z);
      if (z < -145 || h < WATER_Y + 0.9 || h > 10.5 || this.slopeAt(x, z) > 0.34) continue;
      if (this.inPlot(x, z, 1.2) || this.inScenicSite(x, z, 0.5) || this.nearRoad(x, z, 0.15)) continue;
      const patch = Math.sin(x * 0.071 + Math.sin(z * 0.033)) * Math.cos(z * 0.064 - x * 0.021);
      if (patch < 0.18) continue;
      const size = 0.55 + rng() * 0.72;
      position.set(x, h + 0.015, z);
      rotation.setFromAxisAngle(up, rng() * Math.PI * 2);
      scale.set(size, size, size);
      matrix.compose(position, rotation, scale);
      flowers.setMatrixAt(flowerCount, matrix);
      tint.setHex(flowerPalette[Math.floor(rng() * flowerPalette.length)] as number);
      flowers.setColorAt(flowerCount++, tint);
    }
    flowers.count = flowerCount;
    flowers.instanceMatrix.needsUpdate = true;
    if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
    flowers.computeBoundingSphere();
    scene.add(flowers);

    const litterCap = Math.round(budget.understory * 0.7);
    const litterGeo = new THREE.CircleGeometry(1, 5);
    litterGeo.rotateX(-Math.PI / 2);
    const litter = new THREE.InstancedMesh(
      litterGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
      litterCap,
    );
    let litterCount = 0;
    for (let t = 0; t < litterCap * 9 && litterCount < litterCap; t++) {
      const x = (rng() * 2 - 1) * 325;
      const z = -125 - rng() * 205;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.65 || h > 13 || this.slopeAt(x, z) > 0.58) continue;
      if (this.inPlot(x, z, 1.3) || this.nearRoad(x, z, 0.25)) continue;
      const size = 0.07 + rng() * 0.16;
      position.set(x, h + 0.018, z);
      rotation.setFromAxisAngle(up, rng() * Math.PI * 2);
      scale.set(size * (1.2 + rng()), 1, size);
      matrix.compose(position, rotation, scale);
      litter.setMatrixAt(litterCount, matrix);
      tint.setHex(rng() < 0.35 ? 0x796943 : rng() < 0.7 ? 0x4d5b34 : 0x936d3d);
      litter.setColorAt(litterCount++, tint);
    }
    litter.count = litterCount;
    litter.instanceMatrix.needsUpdate = true;
    if (litter.instanceColor) litter.instanceColor.needsUpdate = true;
    litter.computeBoundingSphere();
    scene.add(litter);

    const deadwoodCap = Math.round(budget.understory * 0.1);
    const deadwood = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.08, 0.13, 1.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x5a432d, roughness: 1, flatShading: true }),
      deadwoodCap,
    );
    const deadwoodAxis = new THREE.Vector3();
    let deadwoodCount = 0;
    for (let t = 0; t < deadwoodCap * 14 && deadwoodCount < deadwoodCap; t++) {
      const x = (rng() * 2 - 1) * 320;
      const z = -130 - rng() * 195;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.8 || h > 12 || this.slopeAt(x, z) > 0.42) continue;
      if (this.inPlot(x, z, 2) || this.inScenicSite(x, z, 1) || this.nearRoad(x, z, 0.8)) continue;
      const length = 0.7 + rng() * 1.1;
      if (!this.pointFree(x, z, length * 0.92, WATER_Y + 0.5, 14)) continue;
      if (this.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r / 1.5 + length * 0.92)) continue;
      position.set(x, h + 0.12, z);
      rotation.setFromEuler(new THREE.Euler(0, rng() * Math.PI * 2, Math.PI / 2 + (rng() - 0.5) * 0.16));
      scale.set(length, length, length);
      matrix.compose(position, rotation, scale);
      deadwood.setMatrixAt(deadwoodCount++, matrix);
      deadwoodAxis.set(0, 1, 0).applyQuaternion(rotation);
      const halfLength = 0.8 * length;
      const halfX = Math.abs(deadwoodAxis.x) * halfLength + 0.13 * length;
      const halfZ = Math.abs(deadwoodAxis.z) * halfLength + 0.13 * length;
      this.addCollider({
        kind: 'aabb', minX: x - halfX, minY: h - 0.03, minZ: z - halfZ,
        maxX: x + halfX, maxY: h + 0.3 * length, maxZ: z + halfZ, tag: 'wall',
      });
    }
    deadwood.count = deadwoodCount;
    deadwood.instanceMatrix.needsUpdate = true;
    deadwood.computeBoundingSphere();
    deadwood.castShadow = true;
    scene.add(deadwood);

    // 裸土斑和细碎石为草地提供近景纹理层, 不参与碰撞也不遮挡移动。
    const soilCap = Math.round(budget.flowers * 0.32);
    const soilGeometry = new THREE.CircleGeometry(1, 12);
    soilGeometry.rotateX(-Math.PI / 2);
    const soil = new THREE.InstancedMesh(
      soilGeometry,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 1,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
      soilCap,
    );
    soil.name = 'ground-soil-patches';
    soil.renderOrder = 1;
    const groundNormal = new THREE.Vector3();
    const groundAlign = new THREE.Quaternion();
    let soilCount = 0;
    for (let t = 0; t < soilCap * 12 && soilCount < soilCap; t++) {
      const x = (rng() * 2 - 1) * 326;
      const z = (rng() * 2 - 1) * 326;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.55 || h > 13.5 || this.slopeAt(x, z) > 0.28) continue;
      if (this.inPlot(x, z, 1.1) || this.inScenicSite(x, z, 0.25) || this.nearRoad(x, z, 0.08)) continue;
      const size = 0.38 + rng() * 0.72;
      position.set(x, h + 0.032, z);
      groundNormal.set(
        this.getHeight(x - 0.55, z) - this.getHeight(x + 0.55, z),
        1.1,
        this.getHeight(x, z - 0.55) - this.getHeight(x, z + 0.55),
      ).normalize();
      rotation.setFromAxisAngle(up, rng() * Math.PI * 2);
      groundAlign.setFromUnitVectors(up, groundNormal);
      rotation.premultiply(groundAlign);
      // CircleGeometry 旋转后位于 XZ 平面，扁率必须写入 Z 轴；旧代码误缩放 Y 轴，
      // 导致贴片在坡地上被拉成长条并穿入地形。
      scale.set(size * (1.05 + rng() * 0.75), 1, size * (0.62 + rng() * 0.32));
      matrix.compose(position, rotation, scale);
      soil.setMatrixAt(soilCount, matrix);
      tint.setHex(rng() < 0.45 ? 0x806a48 : rng() < 0.72 ? 0x695b43 : 0x92734c);
      soil.setColorAt(soilCount++, tint);
    }
    soil.count = soilCount;
    soil.instanceMatrix.needsUpdate = true;
    if (soil.instanceColor) soil.instanceColor.needsUpdate = true;
    soil.computeBoundingSphere();
    scene.add(soil);

    const microStoneCap = Math.round(budget.flowers * 0.62);
    const microStones = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
      microStoneCap,
    );
    let microStoneCount = 0;
    for (let t = 0; t < microStoneCap * 10 && microStoneCount < microStoneCap; t++) {
      const x = (rng() * 2 - 1) * 328;
      const z = (rng() * 2 - 1) * 328;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.5 || h > 15 || this.slopeAt(x, z) > 0.62) continue;
      if (this.inPlot(x, z, 0.9) || this.inScenicSite(x, z, 0.2)) continue;
      const size = 0.035 + rng() * 0.11;
      position.set(x, h + size * 0.18, z);
      rotation.setFromEuler(new THREE.Euler(rng() * 0.3, rng() * Math.PI * 2, rng() * 0.3));
      scale.set(size * (1.1 + rng()), size * (0.28 + rng() * 0.35), size * (0.8 + rng() * 0.7));
      matrix.compose(position, rotation, scale);
      microStones.setMatrixAt(microStoneCount, matrix);
      tint.setHex(rng() < 0.5 ? 0x85847a : rng() < 0.75 ? 0xa09782 : 0x666c67);
      microStones.setColorAt(microStoneCount++, tint);
    }
    microStones.count = microStoneCount;
    microStones.instanceMatrix.needsUpdate = true;
    if (microStones.instanceColor) microStones.instanceColor.needsUpdate = true;
    microStones.computeBoundingSphere();
    microStones.receiveShadow = true;
    scene.add(microStones);

    this.groundMicroDetailCount = fernCount + flowerCount + litterCount + soilCount + microStoneCount;
    const added = this.groundMicroDetailCount + deadwoodCount;
    this.naturalGroundDetailCount += added;
    this.environmentDetailInstanceCount += added;
  }

  private addNaturalStoryProps(scene: THREE.Scene): void {
    const rng = mulberry32(61207);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const barkMaterial = new THREE.MeshStandardMaterial({ color: 0x67482f, roughness: 1 });
    const cutMaterial = new THREE.MeshStandardMaterial({ color: 0xb09161, roughness: 0.96 });
    applySurfaceAsset(barkMaterial, 'wood', 3.4, 0.74);
    applySurfaceAsset(cutMaterial, 'wood', 2.6, 0.42);

    const stumpCap = 52;
    const stumpBodies = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.3, 0.4, 0.72, 10), barkMaterial, stumpCap,
    );
    const stumpTops = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.305, 0.305, 0.025, 12), cutMaterial, stumpCap,
    );
    let stumpCount = 0;
    for (let t = 0; t < 1600 && stumpCount < stumpCap; t++) {
      const x = (rng() * 2 - 1) * 285;
      const z = -115 - rng() * 215;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.8 || h > 12.5 || this.slopeAt(x, z) > 0.42) continue;
      if (this.inPlot(x, z, 2.4) || this.inScenicSite(x, z, 1.5) || this.nearRoad(x, z, 1.1)) continue;
      const size = 0.72 + rng() * 0.55;
      if (!this.pointFree(x, z, 0.44 * size, WATER_Y + 0.5, 14)) continue;
      if (this.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r / 1.5 + 0.44 * size)) continue;
      rotation.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08));
      scale.set(size, size * (0.78 + rng() * 0.35), size);
      position.set(x, h + 0.36 * scale.y, z);
      matrix.compose(position, rotation, scale);
      stumpBodies.setMatrixAt(stumpCount, matrix);
      position.y = h + 0.72 * scale.y + 0.012;
      matrix.compose(position, rotation, scale);
      stumpTops.setMatrixAt(stumpCount, matrix);
      this.addCollider({ kind: 'cyl', x, z, r: 0.38 * size, y0: h - 0.1, y1: h + 0.78 * scale.y, tag: 'tree' });
      stumpCount++;
    }
    stumpBodies.count = stumpCount;
    stumpTops.count = stumpCount;
    stumpBodies.instanceMatrix.needsUpdate = true;
    stumpTops.instanceMatrix.needsUpdate = true;
    stumpBodies.castShadow = true;
    stumpTops.castShadow = true;
    stumpBodies.computeBoundingSphere();
    stumpTops.computeBoundingSphere();
    scene.add(stumpBodies, stumpTops);

    const logCap = 38;
    const logBodies = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.29, 0.35, 3.2, 10), barkMaterial, logCap,
    );
    const logCuts = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.295, 0.295, 0.035, 12), cutMaterial, logCap * 2,
    );
    let logCount = 0;
    for (let t = 0; t < 1800 && logCount < logCap; t++) {
      const x = (rng() * 2 - 1) * 295;
      const z = -105 - rng() * 220;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.85 || h > 12.5 || this.slopeAt(x, z) > 0.35) continue;
      if (this.inPlot(x, z, 3.1) || this.inScenicSite(x, z, 2) || this.nearRoad(x, z, 1.4)) continue;
      const lengthScale = 0.82 + rng() * 0.42;
      if (!this.pointFree(x, z, 1.9 * lengthScale, WATER_Y + 0.5, 14)) continue;
      if (this.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r / 1.5 + 1.9 * lengthScale)) continue;
      const yaw = rng() * Math.PI * 2;
      rotation.setFromEuler(new THREE.Euler(0, yaw, Math.PI / 2 + (rng() - 0.5) * 0.06));
      scale.set(0.85 + rng() * 0.28, lengthScale, 0.85 + rng() * 0.28);
      position.set(x, h + 0.31 * scale.x, z);
      matrix.compose(position, rotation, scale);
      logBodies.setMatrixAt(logCount, matrix);
      axis.set(0, 1, 0).applyQuaternion(rotation);
      for (let end = 0; end < 2; end++) {
        const direction = end === 0 ? -1 : 1;
        position.set(
          x + axis.x * 1.61 * lengthScale * direction,
          h + 0.31 * scale.x + axis.y * 1.61 * lengthScale * direction,
          z + axis.z * 1.61 * lengthScale * direction,
        );
        matrix.compose(position, rotation, scale);
        logCuts.setMatrixAt(logCount * 2 + end, matrix);
      }
      const halfX = Math.abs(axis.x) * 1.7 * lengthScale + 0.38 * scale.x;
      const halfZ = Math.abs(axis.z) * 1.7 * lengthScale + 0.38 * scale.z;
      this.addCollider({
        kind: 'aabb', minX: x - halfX, minY: h - 0.08, minZ: z - halfZ,
        maxX: x + halfX, maxY: h + 0.72 * scale.x, maxZ: z + halfZ, tag: 'wall',
      });
      logCount++;
    }
    logBodies.count = logCount;
    logCuts.count = logCount * 2;
    logBodies.instanceMatrix.needsUpdate = true;
    logCuts.instanceMatrix.needsUpdate = true;
    logBodies.castShadow = true;
    logCuts.castShadow = true;
    logBodies.computeBoundingSphere();
    logCuts.computeBoundingSphere();
    scene.add(logBodies, logCuts);

    const driftwoodCap = 58;
    const driftwood = new THREE.InstancedMesh(
      new THREE.CapsuleGeometry(0.06, 1.25, 2, 7),
      new THREE.MeshStandardMaterial({ color: 0x79684e, roughness: 1 }),
      driftwoodCap,
    );
    let driftwoodCount = 0;
    for (let t = 0; t < 6000 && driftwoodCount < driftwoodCap; t++) {
      const x = (rng() * 2 - 1) * 335;
      const z = (rng() * 2 - 1) * 335;
      const h = this.getHeight(x, z);
      if (shorelineSuitability(h, WATER_Y, this.slopeAt(x, z)) < 0.42) continue;
      if (this.inPlot(x, z, 1.3) || this.nearRoad(x, z, 0.4)) continue;
      const size = 0.65 + rng() * 0.75;
      if (!this.pointFree(x, z, size * 0.82, WATER_Y - 0.7, 14)) continue;
      if (this.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r / 1.5 + size * 0.82)) continue;
      rotation.setFromEuler(new THREE.Euler(Math.PI / 2 + (rng() - 0.5) * 0.08, rng() * Math.PI * 2, 0));
      scale.set(size, size, size);
      position.set(x, h + 0.07, z);
      matrix.compose(position, rotation, scale);
      driftwood.setMatrixAt(driftwoodCount++, matrix);
      axis.set(0, 1, 0).applyQuaternion(rotation);
      const halfLength = 0.72 * size;
      const halfX = Math.abs(axis.x) * halfLength + 0.08 * size;
      const halfZ = Math.abs(axis.z) * halfLength + 0.08 * size;
      this.addCollider({
        kind: 'aabb', minX: x - halfX, minY: h - 0.03, minZ: z - halfZ,
        maxX: x + halfX, maxY: h + 0.2 * size, maxZ: z + halfZ, tag: 'wall',
      });
    }
    driftwood.count = driftwoodCount;
    driftwood.instanceMatrix.needsUpdate = true;
    driftwood.castShadow = true;
    driftwood.computeBoundingSphere();
    scene.add(driftwood);

    this.naturalStoryPropCount = stumpCount * 2 + logCount * 3 + driftwoodCount;
    this.environmentDetailInstanceCount += this.naturalStoryPropCount;
    this.assetUsage.add('map.nature.deadwood', stumpCount + logCount + driftwoodCount);
  }

  private addShoreDetails(scene: THREE.Scene): void {
    const rng = mulberry32(77119);
    const budget = naturalDetailBudget(navigator.hardwareConcurrency);
    const stemMat = new THREE.MeshLambertMaterial({ color: 0x738b42 });
    const headMat = new THREE.MeshLambertMaterial({ color: 0x755b36 });
    this.addSway(stemMat, 0.035, -0.1, 0.55, true, false, 105, 145);
    this.addSway(headMat, 0.055, -0.1, 0.18, true, false, 105, 145);
    const stems = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.018, 0.026, 0.9, 4), stemMat, budget.shore,
    );
    const heads = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.05, 0.07, 0.25, 5), headMat, budget.shore,
    );
    const foamCap = Math.round(budget.shore * 0.44);
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xd8e5d8,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const foam = new THREE.InstancedMesh(new THREE.RingGeometry(0.68, 0.86, 10), foamMat, foamCap);
    foam.renderOrder = 1;
    const pebbleCap = Math.round(budget.shore * 0.72);
    const pebble = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
      pebbleCap,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const color = new THREE.Color();
    let count = 0;
    let foamCount = 0;
    let pebbleCount = 0;
    for (let t = 0; t < 19000 && count < budget.shore; t++) {
      const x = (rng() * 2 - 1) * 340;
      const z = (rng() * 2 - 1) * 340;
      const h = this.getHeight(x, z);
      const shoreF = shorelineSuitability(h, WATER_Y, this.slopeAt(x, z));
      if (shoreF < 0.28 || rng() > shoreF || this.inPlot(x, z, 1.5) || this.nearRoad(x, z, 0.2)) continue;
      const scale = 0.75 + rng() * 0.7;
      q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08));
      s.set(scale, scale, scale);
      p.set(x, h + 0.45 * scale, z);
      m.compose(p, q, s);
      stems.setMatrixAt(count, m);
      p.y = h + 0.98 * scale;
      m.compose(p, q, s);
      heads.setMatrixAt(count, m);
      if (foamCount < foamCap && rng() < 0.46 && h < WATER_Y + 0.18) {
        q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
        const foamSize = 0.48 + rng() * 0.82;
        s.set(foamSize * (1.2 + rng() * 1.2), foamSize * (0.48 + rng() * 0.5), 1);
        p.set(x + (rng() - 0.5) * 0.4, WATER_Y + 0.018, z + (rng() - 0.5) * 0.4);
        m.compose(p, q, s);
        foam.setMatrixAt(foamCount++, m);
      }
      if (pebbleCount < pebbleCap && rng() < 0.75) {
        const angle = rng() * Math.PI * 2;
        const dist = 0.35 + rng() * 1.5;
        const px = x + Math.cos(angle) * dist;
        const pz = z + Math.sin(angle) * dist;
        const ph = this.getHeight(px, pz);
        const ps = 0.06 + rng() * 0.14;
        q.setFromEuler(new THREE.Euler(rng() * 0.2, rng() * Math.PI * 2, rng() * 0.2));
        s.set(ps * (1.2 + rng()), ps * (0.35 + rng() * 0.3), ps * (0.9 + rng() * 0.8));
        p.set(px, ph + ps * 0.18, pz);
        m.compose(p, q, s);
        pebble.setMatrixAt(pebbleCount, m);
        color.setHex(rng() < 0.5 ? 0x8d8b80 : rng() < 0.75 ? 0xaaa38d : 0x6f756e);
        pebble.setColorAt(pebbleCount++, color);
      }
      count++;
    }
    stems.count = count;
    heads.count = count;
    foam.count = foamCount;
    pebble.count = pebbleCount;
    stems.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    foam.instanceMatrix.needsUpdate = true;
    pebble.instanceMatrix.needsUpdate = true;
    if (pebble.instanceColor) pebble.instanceColor.needsUpdate = true;
    stems.castShadow = true;
    pebble.receiveShadow = true;
    stems.computeBoundingSphere();
    heads.computeBoundingSphere();
    foam.computeBoundingSphere();
    pebble.computeBoundingSphere();
    scene.add(stems, heads, foam, pebble);
    this.shorelineDetailCount = count * 2 + foamCount + pebbleCount;
    this.environmentDetailInstanceCount += this.shorelineDetailCount;
  }

  // 道路跨过湖湾或支流时补齐低矮桥梁。旧道路只跳过水下三角形，视觉上会变成两截路直插水面，
  // 同时角色和载具也没有可行走表面。这里沿道路中心线逐段生成桥面、护栏、桥墩和导航平台。
  private addRoadWaterCrossings(scene: THREE.Scene): void {
    type WaterSegment = {
      x: number; z: number; length: number; yaw: number;
      sideX: number; sideZ: number; sequence: number;
    };
    const segments: WaterSegment[] = [];
    let crossingCount = 0;
    this.roadWaterCrossingPositions.length = 0;
    const coveredByMainBridge = (x: number, z: number): boolean => insideMainBridgeDeck(x, z, 0.1);

    for (let pathIndex = 0; pathIndex < ROAD_PATHS.length; pathIndex++) {
      const path = ROAD_PATHS[pathIndex] as readonly (readonly [number, number])[];
      let previousWasWater = false;
      let sequence = 0;
      for (let pointIndex = 0; pointIndex < path.length - 1; pointIndex++) {
        const a = path[pointIndex] as readonly [number, number];
        const b = path[pointIndex + 1] as readonly [number, number];
        const wholeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(wholeLength / 2.35));
        for (let step = 0; step < steps; step++) {
          const t0 = step / steps;
          const t1 = (step + 1) / steps;
          const x0 = a[0] + (b[0] - a[0]) * t0;
          const z0 = a[1] + (b[1] - a[1]) * t0;
          const x1 = a[0] + (b[0] - a[0]) * t1;
          const z1 = a[1] + (b[1] - a[1]) * t1;
          const x = (x0 + x1) * 0.5;
          const z = (z0 + z1) * 0.5;
          const water = Math.min(this.getHeight(x0, z0), this.getHeight(x, z), this.getHeight(x1, z1)) < WATER_Y + 0.18;
          const mainBridge = coveredByMainBridge(x, z);
          if (!water || mainBridge) {
            previousWasWater = false;
            continue;
          }
          if (!previousWasWater) {
            crossingCount++;
            this.roadWaterCrossingPositions.push({ x, z });
          }
          previousWasWater = true;
          const dx = x1 - x0;
          const dz = z1 - z0;
          const length = Math.hypot(dx, dz) || 1;
          segments.push({
            x, z, length: length + 0.12,
            yaw: Math.atan2(dx, dz), sideX: -dz / length, sideZ: dx / length,
            sequence: sequence++,
          });
        }
      }
    }

    this.roadWaterCrossingCount = crossingCount;
    this.roadWaterCrossingSegmentCount = segments.length;
    if (segments.length === 0) return;

    const group = new THREE.Group();
    group.name = 'road-water-crossings';
    const deckMat = new THREE.MeshBasicMaterial({ color: 0x9a8867, fog: true });
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xc4baa2,
      emissive: 0x80745f,
      emissiveIntensity: 0.46,
      roughness: 0.76,
      metalness: 0.12,
    });
    const pierMat = new THREE.MeshStandardMaterial({ color: 0x62696b, roughness: 0.96, metalness: 0.02 });
    applySurfaceAsset(railMat, 'paintedMetal', 3.2, 0.64);
    applySurfaceAsset(pierMat, 'concrete', 2.6, 0.62);

    const deckGeometry = new THREE.BoxGeometry(1, 1, 1);
    const decks = new THREE.InstancedMesh(deckGeometry, deckMat, segments.length);
    const rails = new THREE.InstancedMesh(deckGeometry, railMat, segments.length * 2);
    const railPosts = new THREE.InstancedMesh(deckGeometry, railMat, segments.length * 2);
    decks.name = 'road-water-crossing-decks';
    rails.name = 'road-water-crossing-top-rails';
    railPosts.name = 'road-water-crossing-rail-posts';
    const pierSegments = segments.filter((segment) => segment.sequence % 4 === 1);
    const piers = new THREE.InstancedMesh(deckGeometry, pierMat, pierSegments.length * 2);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const deckWidth = 5.45;

    const addBoxCollider = (
      x: number, z: number, width: number, length: number, yaw: number,
      minY: number, maxY: number, tag: 'floor' | 'wall', platform = false,
    ): void => {
      const halfX = Math.abs(Math.cos(yaw)) * width * 0.5 + Math.abs(Math.sin(yaw)) * length * 0.5;
      const halfZ = Math.abs(Math.sin(yaw)) * width * 0.5 + Math.abs(Math.cos(yaw)) * length * 0.5;
      const bounds = { minX: x - halfX, minZ: z - halfZ, maxX: x + halfX, maxZ: z + halfZ };
      this.addCollider({ kind: 'aabb', ...bounds, minY, maxY, tag });
      if (platform) this.platforms.push({ ...bounds, top: maxY });
    };

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index] as WaterSegment;
      quaternion.setFromAxisAngle(up, segment.yaw);
      position.set(segment.x, ROAD_WATER_DECK_Y - 0.14, segment.z);
      scale.set(deckWidth, 0.28, segment.length);
      matrix.compose(position, quaternion, scale);
      decks.setMatrixAt(index, matrix);
      addBoxCollider(
        segment.x, segment.z, deckWidth, segment.length, segment.yaw,
        ROAD_WATER_DECK_Y - 0.28, ROAD_WATER_DECK_Y, 'floor', true,
      );

      for (const side of [-1, 1] as const) {
        const railX = segment.x + segment.sideX * side * (deckWidth * 0.5 - 0.12);
        const railZ = segment.z + segment.sideZ * side * (deckWidth * 0.5 - 0.12);
        position.set(railX, ROAD_WATER_DECK_Y + 0.67, railZ);
        scale.set(0.13, 0.14, segment.length + 0.08);
        matrix.compose(position, quaternion, scale);
        rails.setMatrixAt(index * 2 + (side === -1 ? 0 : 1), matrix);
        position.set(railX, ROAD_WATER_DECK_Y + 0.35, railZ);
        scale.set(0.14, 0.7, 0.14);
        matrix.compose(position, quaternion, scale);
        railPosts.setMatrixAt(index * 2 + (side === -1 ? 0 : 1), matrix);
        addBoxCollider(
          railX, railZ, 0.13, segment.length, segment.yaw,
          ROAD_WATER_DECK_Y, ROAD_WATER_DECK_Y + 0.78, 'wall', false,
        );
      }
    }

    for (let index = 0; index < pierSegments.length; index++) {
      const segment = pierSegments[index] as WaterSegment;
      for (const side of [-1, 1] as const) {
        const pierX = segment.x + segment.sideX * side * 1.78;
        const pierZ = segment.z + segment.sideZ * side * 1.78;
        const bed = Math.min(this.getHeight(pierX, pierZ), WATER_Y - 0.25);
        const height = Math.max(0.45, ROAD_WATER_DECK_Y - bed - 0.16);
        position.set(pierX, bed + height * 0.5, pierZ);
        quaternion.identity();
        scale.set(0.34, height, 0.34);
        matrix.compose(position, quaternion, scale);
        piers.setMatrixAt(index * 2 + (side === -1 ? 0 : 1), matrix);
      }
    }

    for (const mesh of [decks, rails, railPosts, piers]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    scene.add(group);
    this.environmentDetailInstanceCount += segments.length * 4 + pierSegments.length * 2;
    this.assetUsage.add('map.infrastructure.bridge', crossingCount);
  }

  // 单座桥: 桥面(floor 可走) + 两端踏步 + 侧护栏 + 桥墩, ≤20 AABB
  private addBridge(scene: THREE.Scene, bx: number): void {
    const rzC = riverZAt(bx);
    const z0 = rzC - MAIN_BRIDGE_HALF_LENGTH;
    const z1 = rzC + MAIN_BRIDGE_HALF_LENGTH;
    const hBank0 = this.getHeight(bx, z0 - 3);
    const hBank1 = this.getHeight(bx, z1 + 3);
    // 桥面贴近较低岸 +0.5 (高岸下坡自然接上, 低岸 1~2 级踏步)
    const deckY = Math.max(ROAD_WATER_DECK_Y + 0.18, Math.min(hBank0, hBank1) + 0.5);
    const wood = new THREE.MeshLambertMaterial({ color: 0x9b784b });
    const approach = new THREE.MeshBasicMaterial({
      color: 0x9a8867,
      fog: true,
      side: THREE.DoubleSide,
    });
    const box = (
      tag: 'wall' | 'floor', x0: number, y0: number, z0_: number, x1: number, y1: number, z1_: number,
      opts: { collider?: boolean; platform?: boolean; material?: THREE.Material; name?: string } = {},
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1_ - z0_), opts.material ?? wood);
      if (opts.name) mesh.name = opts.name;
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0_ + z1_) / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      if (opts.collider !== false) {
        this.addCollider({ kind: 'aabb', minX: x0, minY: y0, minZ: z0_, maxX: x1, maxY: y1, maxZ: z1_, tag });
      }
      if (opts.platform) {
        this.platforms.push({ minX: x0, minZ: z0_, maxX: x1, maxZ: z1_, top: y1 });
      }
      return mesh;
    };
    // 桥面宽度与道路主车辙一致，避免桥下残留第二层路面和桥头突然收窄。
    box(
      'floor', bx - MAIN_BRIDGE_HALF_WIDTH, deckY - 0.24, z0,
      bx + MAIN_BRIDGE_HALF_WIDTH, deckY, z1,
      { platform: true, name: 'main-bridge-deck' },
    );
    // 两端使用喇叭形连续坡面从 7.2m 路肩平滑收束到 5.4m 桥面，
    // 避免方块坡台互相叠压后留下三角形草地和锯齿接缝。
    for (const [ze, dir] of [[z0, -1], [z1, 1]] as const) {
      const bankH = this.getHeight(bx, ze + dir * 3);
      const bankRoadY = bankH + 0.11;
      const approachLength = 4.4;
      const outerZ = ze + dir * approachLength;
      const outerHalfWidth = 4.15;
      const approachVertices = dir < 0
        ? [
          bx - MAIN_BRIDGE_HALF_WIDTH, deckY + 0.012, ze,
          bx + outerHalfWidth, bankRoadY + 0.012, outerZ,
          bx + MAIN_BRIDGE_HALF_WIDTH, deckY + 0.012, ze,
          bx - MAIN_BRIDGE_HALF_WIDTH, deckY + 0.012, ze,
          bx - outerHalfWidth, bankRoadY + 0.012, outerZ,
          bx + outerHalfWidth, bankRoadY + 0.012, outerZ,
        ]
        : [
          bx - MAIN_BRIDGE_HALF_WIDTH, deckY + 0.012, ze,
          bx + MAIN_BRIDGE_HALF_WIDTH, deckY + 0.012, ze,
          bx + outerHalfWidth, bankRoadY + 0.012, outerZ,
          bx - MAIN_BRIDGE_HALF_WIDTH, deckY + 0.012, ze,
          bx + outerHalfWidth, bankRoadY + 0.012, outerZ,
          bx - outerHalfWidth, bankRoadY + 0.012, outerZ,
        ];
      const approachGeometry = new THREE.BufferGeometry();
      approachGeometry.setAttribute('position', new THREE.Float32BufferAttribute(approachVertices, 3));
      const approachNormals = new Float32Array(approachVertices.length);
      for (let normalIndex = 1; normalIndex < approachNormals.length; normalIndex += 3) {
        approachNormals[normalIndex] = 1;
      }
      approachGeometry.setAttribute('normal', new THREE.BufferAttribute(approachNormals, 3));
      const approachMesh = new THREE.Mesh(approachGeometry, approach);
      approachMesh.name = 'main-bridge-approach';
      approachMesh.receiveShadow = true;
      scene.add(approachMesh);
      for (let i = 0; i < 4; i++) {
        const near = i / 4;
        const far = (i + 1) / 4;
        const top = deckY + (bankRoadY - deckY) * far;
        const nearDistance = near * approachLength;
        const farDistance = far * approachLength;
        const segmentMinZ = Math.min(ze + dir * nearDistance, ze + dir * farDistance);
        const segmentMaxZ = Math.max(ze + dir * nearDistance, ze + dir * farDistance);
        const halfWidth = MAIN_BRIDGE_HALF_WIDTH + (outerHalfWidth - MAIN_BRIDGE_HALF_WIDTH) * far;
        this.platforms.push({
          minX: bx - halfWidth, minZ: segmentMinZ,
          maxX: bx + halfWidth, maxZ: segmentMaxZ, top,
        });
      }
    }
    // 侧护栏(矮碰撞)
    box('wall', bx - 2.7, deckY, z0, bx - 2.5, deckY + 0.85, z1, { name: 'main-bridge-rail' });
    box('wall', bx + 2.5, deckY, z0, bx + 2.7, deckY + 0.85, z1, { name: 'main-bridge-rail' });
    // 装饰: 板面条纹(深色板缝) + 底托侧梁(无碰撞)
    const woodDark = new THREE.MeshLambertMaterial({ color: 0x6f5435 });
    for (let z = z0 + 0.7; z < z1 - 0.5; z += 1.15) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(5.12, 0.02, 0.07), woodDark);
      stripe.position.set(bx, deckY + 0.012, z);
      scene.add(stripe);
    }
    const beamL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, z1 - z0), woodDark);
    beamL.position.set(bx - 2.58, deckY - 0.4, (z0 + z1) / 2);
    scene.add(beamL);
    const beamR = beamL.clone();
    beamR.position.x = bx + 2.58;
    scene.add(beamR);
    // 桥墩(入水立柱)
    for (const pz of [z0 + 4.5, z1 - 4.5]) {
      for (const px of [bx - 1.5, bx + 1.5]) {
        const bedH = this.getHeight(px, pz);
        const pierBottom = Math.min(bedH - 0.5, deckY - 0.45);
        box('wall', px - 0.18, pierBottom, pz - 0.18, px + 0.18, deckY - 0.2, pz + 0.18);
      }
    }
  }

  // 植被顶点位移摇摆(InstancedMesh 顶点着色器注入, 零 CPU 逐帧开销)
  // fade=true 时按与相机距离把实例缩成退化三角形(远距消退)
  // upNormal=true 时片元法线强制朝上(双面草叶背光面不发黑, 与地形光照一致)
  private addSway(
    mat: THREE.Material,
    amp: number,
    lo: number,
    hi: number,
    fade = false,
    upNormal = false,
    fadeNear = 95,
    fadeFar = 120,
  ): void {
    const timeU = this.timeU;
    const camU = this.camU;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.uniforms.uCamPos = camU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uCamPos;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 swayIP = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  float swayPhase = swayIP.x * 0.37 + swayIP.y * 0.53;
  float swayW = smoothstep(${lo.toFixed(2)}, ${hi.toFixed(2)}, transformed.y);
  transformed.x += sin(uTime * 1.15 + swayPhase) * ${amp.toFixed(3)} * swayW;
  transformed.z += cos(uTime * 0.9 + swayPhase * 1.31) * ${amp.toFixed(3)} * swayW;
  ${fade ? `transformed *= 1.0 - smoothstep(${fadeNear.toFixed(1)}, ${fadeFar.toFixed(1)}, distance(swayIP, uCamPos.xz));` : ''}
#endif`,
        );
      if (upNormal) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`,
        );
      }
    };
    mat.customProgramCacheKey = () => `sway:${amp}:${lo}:${hi}:${fade}:${upNormal}:${fadeNear}:${fadeFar}`;
  }

  get environmentState(): EnvironmentSnapshot {
    return this.environment.snapshot;
  }

  resetEnvironment(): void {
    this.environment.reset();
  }

  consumeEnvironmentNotice(): string | null {
    return this.environment.consumeNotice();
  }

  consumeThunder(): boolean {
    return this.environment.consumeThunder();
  }

  collisionIndexStatsAt(x: number, z: number): {
    localCylinders: number;
    totalCylinders: number;
    localBoxes: number;
    totalBoxes: number;
  } {
    return {
      localCylinders: this.cylinderGrid.at(x, z).length,
      totalCylinders: this.cyls.length,
      localBoxes: this.aabbGrid.at(x, z).length,
      totalBoxes: this.aabbs.length,
    };
  }

  // 每帧视觉更新: 水波/植被/天空/昼夜/天气(暂停时仅保留视觉动画)
  updateVisuals(dt: number, camPos: THREE.Vector3, advanceEnvironment = false): void {
    this.elapsed += dt;
    this.timeU.value = this.elapsed;
    this.camU.value.copy(camPos);
    this.environment.update(dt, camPos, advanceEnvironment ? this.shadowAnchor : camPos, advanceEnvironment);
    this.sky.update(dt, camPos);
  }

  // 记录阴影跟随锺点, 太阳/月亮方位由环境系统统一计算
  updateShadow(px: number, pz: number): void {
    this.shadowAnchor.set(px, 0, pz);
  }

  // ---- 物理查询 ----

  // 站立高度: 地形 + 可站立 AABB 顶面 + 平台(楼梯踏步), 仅取 ≤ feetY+0.45 的台阶容忍内
  groundHeight(x: number, z: number, feetY: number): number {
    let g = this.getHeight(x, z);
    for (const b of this.aabbGrid.at(x, z)) {
      if (b.off) continue;
      if (x < b.minX - 0.06 || x > b.maxX + 0.06 || z < b.minZ - 0.06 || z > b.maxZ + 0.06) continue;
      if (b.maxY <= feetY + 0.45 && b.maxY > g) g = b.maxY;
    }
    for (const p of this.platformGrid.at(x, z)) {
      if (x < p.minX - 0.06 || x > p.maxX + 0.06 || z < p.minZ - 0.06 || z > p.maxZ + 0.06) continue;
      if (p.top <= feetY + 0.45 && p.top > g) g = p.top;
    }
    return g;
  }

  // 落脚表面供玩家和远端角色共用，视觉材质与声音分类保持一致。
  footstepSurfaceAt(x: number, z: number, feetY: number): FootstepSurface {
    const terrainY = this.getHeight(x, z);
    if (feetY <= WATER_Y + 0.18 && terrainY < WATER_Y + 0.12) return 'water';

    const contentSite = this.mapSiteAt(x, z);
    const contentSurface = (): FootstepSurface => {
      if (!contentSite) return 'stone';
      if (contentSite.kind === 'freight') return 'metal';
      if (contentSite.kind === 'relay') return 'stone';
      return 'wood';
    };
    for (const b of this.aabbGrid.at(x, z)) {
      if (b.off || x < b.minX - 0.06 || x > b.maxX + 0.06 || z < b.minZ - 0.06 || z > b.maxZ + 0.06) continue;
      if (Math.abs(b.maxY - feetY) > 0.52 || b.maxY <= terrainY + 0.08) continue;
      if (b.tag === 'door' || b.tag === 'window') return 'wood';
      if (contentSite) return contentSurface();
      return b.tag === 'roof' ? 'metal' : 'stone';
    }
    for (const p of this.platformGrid.at(x, z)) {
      if (x < p.minX - 0.06 || x > p.maxX + 0.06 || z < p.minZ - 0.06 || z > p.maxZ + 0.06) continue;
      if (Math.abs(p.top - feetY) > 0.52 || p.top <= terrainY + 0.08) continue;
      return this.inPlot(x, z, 0) ? 'stone' : 'wood';
    }
    if (contentSite && Math.hypot(x - contentSite.resolvedX, z - contentSite.resolvedZ) < contentSite.radius * 0.38) {
      return contentSurface();
    }
    if (this.nearRoad(x, z, 0.25)) return 'dirt';
    if (this.slopeAt(x, z) > 0.68 || terrainY > 13.5) return 'stone';
    return 'grass';
  }

  isShelteredAt(x: number, z: number, feetY: number): boolean {
    // 普通住宅层高约 3m，但体育馆等挑空建筑的实体屋面会高出角色近 9m。
    // 遮蔽检测需要覆盖这类完整室内空间，否则雨声、枪声混响和天气效果会在
    // 体育馆大厅内错误按室外处理。上限仍保持有限，避免把高空桥梁误当屋顶。
    const maxRoofDistance = 12;
    for (const b of this.aabbGrid.at(x, z)) {
      if (b.off || (b.tag !== 'floor' && b.tag !== 'roof')) continue;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (b.minY > feetY + 1.2 && b.minY < feetY + maxRoofDistance) return true;
    }
    return false;
  }

  // 载具碰撞: 大圆 vs 静态碰撞体推出, 返回是否发生碰撞(墙/树/岩/桥栏)
  resolveVehicle(p: THREE.Vector3, r: number): boolean {
    let hit = false;
    for (const c of this.cylinderGrid.at(p.x, p.z)) {
      if (p.y > c.y1 - 0.05) continue;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const rr = r + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (d < 0.0001) {
        p.x += rr;
      } else {
        p.x = c.x + (dx / d) * rr;
        p.z = c.z + (dz / d) * rr;
      }
      hit = true;
    }
    for (const b of this.aabbGrid.at(p.x, p.z)) {
      if (b.off) continue;
      if (b.tag === 'floor' || b.tag === 'roof') continue;
      if (p.y >= b.maxY - 0.02 || p.y + 1.4 <= b.minY) continue;
      const cx = clamp(p.x, b.minX, b.maxX);
      const cz = clamp(p.z, b.minZ, b.maxZ);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      hit = true;
      if (d2 > 0.000001) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        const pushW = Math.min(p.x - b.minX + r, b.maxX - p.x + r);
        const pushD = Math.min(p.z - b.minZ + r, b.maxZ - p.z + r);
        if (pushW < pushD) {
          p.x = p.x - b.minX < b.maxX - p.x ? b.minX - r : b.maxX + r;
        } else {
          p.z = p.z - b.minZ < b.maxZ - p.z ? b.minZ - r : b.maxZ + r;
        }
      }
    }
    return hit;
  }

  // 2D 圆 vs 静态碰撞体推出；楼板可站立，但侧面与角色身体相交时仍参与阻挡。
  resolveCharacterCeiling(p: THREE.Vector3, radius: number, previousFeetY: number): boolean {
    if (p.y <= previousFeetY) return false;
    const previousTop = previousFeetY + CHARACTER_COLLISION_HEIGHT;
    const nextTop = p.y + CHARACTER_COLLISION_HEIGHT;
    let ceiling = Infinity;
    for (const b of this.aabbGrid.at(p.x, p.z)) {
      if (b.off || (b.tag !== 'floor' && b.tag !== 'roof')) continue;
      // 只处理这一帧从下向上穿过的楼板底面。水平圆需要真实压进楼板范围，
      // 不能因为半径擦到梯井边缘就在开放洞口中错误撞头。
      if (previousTop > b.minY + CEILING_CONTACT_GAP || nextTop < b.minY) continue;
      const overlapX = p.x > b.minX + radius * 0.12 && p.x < b.maxX - radius * 0.12;
      const overlapZ = p.z > b.minZ + radius * 0.12 && p.z < b.maxZ - radius * 0.12;
      if (!overlapX || !overlapZ) continue;
      ceiling = Math.min(ceiling, b.minY);
    }
    if (!Number.isFinite(ceiling)) return false;
    p.y = Math.min(p.y, ceiling - CHARACTER_COLLISION_HEIGHT - CEILING_CONTACT_GAP);
    return true;
  }

  // 2D 圆 vs 静态碰撞体推出；楼板可站立，但侧面与角色身体相交时仍参与阻挡。
  resolveCollision(p: THREE.Vector3, r: number): void {
    for (const c of this.cylinderGrid.at(p.x, p.z)) {
      if (p.y > c.y1 - 0.05) continue;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const rr = r + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (d < 0.0001) {
        p.x += rr;
      } else {
        p.x = c.x + (dx / d) * rr;
        p.z = c.z + (dz / d) * rr;
      }
    }
    for (const b of this.aabbGrid.at(p.x, p.z)) {
      if (b.off) continue;
      // 已站在楼板上方或拥有完整净空时不阻挡；否则楼板边缘也必须横向推出，
      // 避免 AI 从高台侧面钻进楼板并在室内穿模。
      // 首帧或卡顿帧会让脚底在地面吸附前短暂下沉，顶部容差避免整块楼板把角色横向推出房屋。
      if ((b.tag === 'floor' || b.tag === 'roof') && p.y >= b.maxY - PLATFORM_TOP_SNAP_TOLERANCE) continue;
      if (!characterOverlapsColliderHeight(p.y, b.minY, b.maxY)) continue;
      const cx = clamp(p.x, b.minX, b.maxX);
      const cz = clamp(p.z, b.minZ, b.maxZ);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 0.000001) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        // 圆心在盒内: 沿最小穿透轴推出
        const pushW = Math.min(p.x - b.minX + r, b.maxX - p.x + r);
        const pushD = Math.min(p.z - b.minZ + r, b.maxZ - p.z + r);
        if (pushW < pushD) {
          p.x = p.x - b.minX < b.maxX - p.x ? b.minX - r : b.maxX + r;
        } else {
          p.z = p.z - b.minZ < b.maxZ - p.z ? b.minZ - r : b.maxZ + r;
        }
      }
    }
    // 开合中的门扇已离开静态门框 AABB, 使用跟随转角的线段碰撞继续阻挡角色.
    this.buildings.resolveDoorCollisions(p, r);
    // 世界边界
    p.x = clamp(p.x, -WORLD_HALF + 1, WORLD_HALF - 1);
    p.z = clamp(p.z, -WORLD_HALF + 1, WORLD_HALF - 1);
  }

  // 地形射线(步进 + 二分), 返回 t 或 Infinity
  raycastTerrain(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
    if (o.y > this.maxTerrainH && d.y >= 0) return Infinity;
    const step = 2.2;
    let t = 0;
    let prevT = 0;
    let prevDy = o.y - this.getHeight(o.x, o.z);
    if (prevDy <= 0) return 0;
    while (t < maxT) {
      t = Math.min(t + step, maxT);
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      const dy = o.y + d.y * t - this.getHeight(x, z);
      if (dy <= 0) {
        // 二分细化
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          const md = o.y + d.y * mid - this.getHeight(o.x + d.x * mid, o.z + d.z * mid);
          if (md <= 0) hi = mid;
          else lo = mid;
        }
        return (lo + hi) / 2;
      }
      prevDy = dy;
      prevT = t;
      if (o.y + d.y * t > this.maxTerrainH && d.y > 0) return Infinity;
    }
    return Infinity;
  }

  // 静态碰撞体射线, 命中返回 true 并填充 out
  raycastStatics(o: THREE.Vector3, d: THREE.Vector3, maxT: number, out: StaticHit): boolean {
    let best = maxT;
    let kind: SurfaceKind | null = null;
    let destruct: DestructibleLike | undefined;
    const endX = o.x + d.x * maxT;
    const endZ = o.z + d.z * maxT;
    const minX = Math.min(o.x, endX);
    const minZ = Math.min(o.z, endZ);
    const maxX = Math.max(o.x, endX);
    const maxZ = Math.max(o.z, endZ);
    const cylinders = this.cylinderGrid.queryBounds(minX, minZ, maxX, maxZ, this.rayCylinderCandidates);
    for (const c of cylinders) {
      const ox = o.x - c.x;
      const oz = o.z - c.z;
      const a = d.x * d.x + d.z * d.z;
      if (a < 1e-9) continue;
      const b = 2 * (ox * d.x + oz * d.z);
      const cc = ox * ox + oz * oz - c.r * c.r;
      const disc = b * b - 4 * a * cc;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / (2 * a);
      if (t < 0) t = (-b + sq) / (2 * a); // 起点在圆内
      if (t < 0 || t >= best) continue;
      const y = o.y + d.y * t;
      if (y < c.y0 || y > c.y1) continue;
      best = t;
      kind = c.tag;
      destruct = undefined;
    }
    const boxes = this.aabbGrid.queryBounds(minX, minZ, maxX, maxZ, this.rayBoxCandidates);
    for (const b of boxes) {
      if (b.off) continue;
      const t = rayAABB(o, d, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
      if (t >= 0 && t < best) {
        best = t;
        kind = b.tag;
        destruct = b.destruct;
      }
    }
    if (kind === null) return false;
    out.t = best;
    out.kind = kind;
    out.destruct = destruct;
    return true;
  }

  // 视线检测: 仅地形 + 建筑构件阻挡(树木半透明遮挡忽略, 提升 AI 手感)
  isLOSBlocked(a: THREE.Vector3, b: THREE.Vector3, tmpDir: THREE.Vector3): boolean {
    tmpDir.subVectors(b, a);
    const len = tmpDir.length();
    if (len < 0.001) return false;
    tmpDir.divideScalar(len);
    if (this.raycastTerrain(a, tmpDir, len) < len) return true;
    const boxes = this.aabbGrid.queryBounds(
      Math.min(a.x, b.x),
      Math.min(a.z, b.z),
      Math.max(a.x, b.x),
      Math.max(a.z, b.z),
      this.rayBoxCandidates,
    );
    for (const box of boxes) {
      if (box.off) continue;
      const t = rayAABB(a, tmpDir, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
      if (t >= 0 && t < len) return true;
    }
    return false;
  }

  // 出生点/巡点是否可用(陆地且不被碰撞体占据)
  pointFree(x: number, z: number, r: number, minH = WATER_Y + 0.7, maxH = 14): boolean {
    const h = this.getHeight(x, z);
    if (h < minH || h > maxH) return false;
    for (const c of this.cylinderGrid.at(x, z)) {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = r + c.r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    for (const b of this.aabbGrid.at(x, z)) {
      if (b.off) continue;
      const cx = clamp(x, b.minX, b.maxX);
      const cz = clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }

  // AI 局部导航采样。与出生点 pointFree 不同，这里按角色当前脚高判断楼层，
  // 忽略地板/屋顶的水平碰撞，并把门视为可通行目标，让机器人能够主动靠近开门。
  navPointFree(
    x: number,
    z: number,
    feetY: number,
    r = 0.48,
    allowWater = true,
    swimExit = false,
    allowDrop = false,
  ): boolean {
    const standY = this.groundHeight(x, z, feetY + 0.16);
    const deepWater = standY < WATER_Y - 0.55;
    const swimExitApproach = swimExit && allowWater && feetY < WATER_Y + 0.2 && standY <= WATER_Y + 3.6;
    if (deepWater && !allowWater) return false;
    if (!deepWater && !swimExitApproach &&
      (standY > feetY + 0.62 || (!allowDrop && standY < feetY - 1.45))) return false;
    const bodyY = deepWater ? WATER_Y - 0.78 : standY;
    for (const c of this.cylinderGrid.at(x, z)) {
      if (bodyY >= c.y1 - 0.05 || bodyY + 1.65 <= c.y0) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = r + c.r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    for (const b of this.aabbGrid.at(x, z)) {
      if (b.off || b.tag === 'floor' || b.tag === 'roof' || b.tag === 'door') continue;
      if (bodyY >= b.maxY - 0.02 || bodyY + 1.65 <= b.minY) continue;
      const cx = clamp(x, b.minX, b.maxX);
      const cz = clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return x > -WORLD_HALF + 1 && x < WORLD_HALF - 1 && z > -WORLD_HALF + 1 && z < WORLD_HALF - 1;
  }
}

// 草丛几何体: 11 叶片组成三团交错草簇, 根深暗/尖亮(顶点色围绕 1.0, 与 instanceColor 相乘)
// 法线统一朝上 -- 让叶片接受与地形一致的光照, 避免逆光黑刺
function makeGrassGeo(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const rng = mulberry32(9917);
  for (let b = 0; b < 11; b++) {
    const a = rng() * Math.PI * 2;
    const cluster = b % 3;
    const clusterAngle = cluster / 3 * Math.PI * 2;
    const rr = rng() * 0.22;
    const ox = Math.cos(a) * rr + Math.cos(clusterAngle) * 0.14;
    const oz = Math.sin(a) * rr + Math.sin(clusterAngle) * 0.14;
    const fa = rng() * Math.PI * 2;
    const dx = Math.cos(fa);
    const dz = Math.sin(fa);
    const h = 0.38 + rng() * 0.24;
    const w = 0.05 + rng() * 0.02;
    const lean = 0.1 + rng() * 0.12; // 叶尖微后仰
    const bx = -dz * w;
    const bz = dx * w;
    pos.push(ox - bx, 0, oz - bz, ox + bx, 0, oz + bz, ox + dx * lean, h, oz + dz * lean);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    col.push(0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 1.12, 1.12, 1.1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// 射线 vs AABB(slab), 未命中返回 -1
export function rayAABB(
  o: THREE.Vector3,
  d: THREE.Vector3,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  let tmin = 0;
  let tmax = Infinity;
  // X
  if (Math.abs(d.x) < 1e-9) {
    if (o.x < minX || o.x > maxX) return -1;
  } else {
    let t1 = (minX - o.x) / d.x;
    let t2 = (maxX - o.x) / d.x;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y
  if (Math.abs(d.y) < 1e-9) {
    if (o.y < minY || o.y > maxY) return -1;
  } else {
    let t1 = (minY - o.y) / d.y;
    let t2 = (maxY - o.y) / d.y;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z
  if (Math.abs(d.z) < 1e-9) {
    if (o.z < minZ || o.z > maxZ) return -1;
  } else {
    let t1 = (minZ - o.z) / d.z;
    let t2 = (maxZ - o.z) / d.z;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
