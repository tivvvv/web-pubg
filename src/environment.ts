// 动态环境: 昼夜时钟 + 天气转场 + 光照/雾/云/降雨/闪电
import * as THREE from 'three';
import type { Sky } from './sky';
import { clamp, lerp, mulberry32, smoothstep } from './utils';

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'fog' | 'storm';

export interface EnvironmentSnapshot {
  timeText: string;
  phaseLabel: string;
  weather: WeatherKind;
  weatherLabel: string;
  rainIntensity: number;
  exposure: number;
  daylight: number;
}

interface WeatherProfile {
  cloud: number;
  rain: number;
  fogNear: number;
  fogFar: number;
  light: number;
  wind: number;
  wet: number;
  storm: number;
}

const WEATHER: Record<WeatherKind, WeatherProfile> = {
  clear: { cloud: 0.18, rain: 0, fogNear: 185, fogFar: 690, light: 1, wind: 0.75, wet: 0, storm: 0 },
  cloudy: { cloud: 0.72, rain: 0, fogNear: 140, fogFar: 545, light: 0.8, wind: 1.25, wet: 0.08, storm: 0 },
  rain: { cloud: 0.9, rain: 0.76, fogNear: 96, fogFar: 440, light: 0.76, wind: 2.05, wet: 0.82, storm: 0.16 },
  fog: { cloud: 0.62, rain: 0.04, fogNear: 30, fogFar: 235, light: 0.7, wind: 0.34, wet: 0.28, storm: 0 },
  storm: { cloud: 0.98, rain: 1, fogNear: 68, fogFar: 365, light: 0.58, wind: 3.1, wet: 1, storm: 1 },
};

const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: '晴朗', cloudy: '多云', rain: '降雨', fog: '大雾', storm: '雷暴',
};

const WEATHER_ICON: Record<WeatherKind, string> = {
  clear: '☀︎', cloudy: '☁︎', rain: '☂︎', fog: '≡', storm: 'ϟ',
};

const NEXT_WEATHER: Record<WeatherKind, readonly WeatherKind[]> = {
  clear: ['cloudy', 'cloudy', 'fog'],
  cloudy: ['clear', 'rain', 'rain', 'fog'],
  rain: ['cloudy', 'storm', 'cloudy'],
  fog: ['clear', 'cloudy'],
  storm: ['rain', 'cloudy'],
};

const INITIAL_WEATHER: readonly WeatherKind[] = ['clear', 'cloudy', 'rain', 'fog', 'storm'];
const START_HOURS = [12, 7.25, 16.8, 6.1, 20.4] as const;
const DAY_DURATION_SEC = 420;

function copyProfile(p: WeatherProfile): WeatherProfile {
  return { ...p };
}

function phaseAt(hour: number): string {
  if (hour >= 5 && hour < 8) return '清晨';
  if (hour >= 8 && hour < 11) return '上午';
  if (hour >= 11 && hour < 14) return '正午';
  if (hour >= 14 && hour < 17) return '下午';
  if (hour >= 17 && hour < 19.5) return '黄昏';
  if (hour >= 19.5 && hour < 23.5) return '夜晚';
  return '深夜';
}

function timeText(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60) % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export class EnvironmentSystem {
  readonly snapshot: EnvironmentSnapshot = {
    timeText: '12:00', phaseLabel: '正午', weather: 'clear', weatherLabel: '晴朗',
    rainIntensity: 0, exposure: 1.08, daylight: 1,
  };

  private readonly sky: Sky;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.MeshPhongMaterial;
  private readonly rain: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly rainPos: Float32Array;
  private readonly rainSpeed: Float32Array;
  private readonly rainSeed: Float32Array;
  private readonly zenith = new THREE.Color();
  private readonly horizon = new THREE.Color();
  private readonly fogColor = new THREE.Color();
  private readonly sunDir = new THREE.Vector3(0.7, 0.6, 0.35).normalize();
  private readonly lightDir = new THREE.Vector3();
  private readonly dayZenith = new THREE.Color(0x5798d2);
  private readonly dayHorizon = new THREE.Color(0xd9d9c9);
  private readonly dawnZenith = new THREE.Color(0x405f91);
  private readonly dawnHorizon = new THREE.Color(0xe4a278);
  private readonly nightZenith = new THREE.Color(0x061226);
  private readonly nightHorizon = new THREE.Color(0x17263a);
  private readonly dayWater = new THREE.Color(0x2c7898);
  private readonly nightWater = new THREE.Color(0x102d49);
  private readonly cloudFog = new THREE.Color(0x68737a);
  private readonly warmSun = new THREE.Color(0xffa268);
  private readonly daySun = new THREE.Color(0xffefcf);
  private readonly dayHemi = new THREE.Color(0xddebf8);
  private readonly dayGround = new THREE.Color(0x68704d);
  private readonly nightGround = new THREE.Color(0x263041);
  private readonly stormWater = new THREE.Color(0x294b5b);
  private current = copyProfile(WEATHER.clear);
  private target = copyProfile(WEATHER.clear);
  private weather: WeatherKind = 'clear';
  private timeHours = 12;
  private weatherTimer = 35;
  private lightningTimer = 7;
  private flash = 0;
  private notice: string | null = null;
  private thunderPending = false;
  private lastPhase = '正午';
  private roundIndex = -1;
  private rng = mulberry32(81027);

  constructor(
    scene: THREE.Scene,
    sky: Sky,
    sun: THREE.DirectionalLight,
    hemi: THREE.HemisphereLight,
    fog: THREE.Fog,
    terrainMat: THREE.MeshStandardMaterial,
    waterMat: THREE.MeshPhongMaterial,
  ) {
    this.sky = sky;
    this.sun = sun;
    this.hemi = hemi;
    this.fog = fog;
    this.terrainMat = terrainMat;
    this.waterMat = waterMat;

    const count = navigator.hardwareConcurrency <= 4 ? 360 : 680;
    this.rainPos = new Float32Array(count * 6);
    this.rainSpeed = new Float32Array(count);
    this.rainSeed = new Float32Array(count * 2);
    const rr = mulberry32(91373);
    for (let i = 0; i < count; i++) {
      this.rainSeed[i * 2] = (rr() * 2 - 1) * 38;
      this.rainSeed[i * 2 + 1] = (rr() * 2 - 1) * 38;
      this.rainSpeed[i] = 21 + rr() * 16;
      const y = -3 + rr() * 35;
      const o = i * 6;
      this.rainPos[o] = this.rainSeed[i * 2] as number;
      this.rainPos[o + 1] = y;
      this.rainPos[o + 2] = this.rainSeed[i * 2 + 1] as number;
      this.rainPos[o + 3] = this.rainPos[o];
      this.rainPos[o + 4] = y - 1.6;
      this.rainPos[o + 5] = this.rainPos[o + 2];
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    const rainMat = new THREE.LineBasicMaterial({
      color: 0xbad7e5, transparent: true, opacity: 0, depthWrite: false, fog: true,
    });
    this.rain = new THREE.LineSegments(rainGeo, rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 4;
    this.rain.visible = false;
    scene.add(this.rain);
    this.reset();
  }

  reset(): void {
    this.roundIndex++;
    this.rng = mulberry32(81027 + this.roundIndex * 7919);
    this.timeHours = START_HOURS[this.roundIndex % START_HOURS.length] as number;
    this.weather = INITIAL_WEATHER[this.roundIndex % INITIAL_WEATHER.length] as WeatherKind;
    if (typeof window !== 'undefined') {
      const query = new URLSearchParams(window.location.search);
      if (query.has('test')) {
        const weather = query.get('weather') as WeatherKind | null;
        if (weather && weather in WEATHER) this.weather = weather;
        const timeParam = query.get('time');
        if (timeParam !== null) {
          const hour = Number(timeParam);
          if (Number.isFinite(hour)) this.timeHours = ((hour % 24) + 24) % 24;
        }
      }
    }
    this.current = copyProfile(WEATHER[this.weather]);
    this.target = copyProfile(WEATHER[this.weather]);
    this.weatherTimer = 30 + this.rng() * 16;
    this.lightningTimer = 4 + this.rng() * 8;
    this.flash = 0;
    this.notice = null;
    this.thunderPending = false;
    this.lastPhase = phaseAt(this.timeHours);
    this.syncSnapshot(1);
  }

  update(dt: number, camPos: THREE.Vector3, shadowAnchor: THREE.Vector3, active: boolean): void {
    const simDt = active ? dt : 0;
    if (simDt > 0) {
      this.timeHours = (this.timeHours + simDt * (24 / DAY_DURATION_SEC)) % 24;
      this.weatherTimer -= simDt;
      if (this.weatherTimer <= 0) this.pickNextWeather();
      const phase = phaseAt(this.timeHours);
      if (phase !== this.lastPhase) {
        this.lastPhase = phase;
        if (!this.notice) this.notice = `天色渐入${phase}`;
      }
    }

    const blend = 1 - Math.exp(-simDt * 0.24);
    for (const key of Object.keys(this.current) as (keyof WeatherProfile)[]) {
      this.current[key] = lerp(this.current[key], this.target[key], blend);
    }
    this.updateLightning(simDt);
    this.applyAtmosphere(shadowAnchor);
    this.updateRain(dt, camPos);
    this.syncSnapshot(this.snapshot.daylight);
  }

  consumeNotice(): string | null {
    const value = this.notice;
    this.notice = null;
    return value;
  }

  consumeThunder(): boolean {
    const value = this.thunderPending;
    this.thunderPending = false;
    return value;
  }

  private pickNextWeather(): void {
    const options = NEXT_WEATHER[this.weather];
    this.weather = options[Math.floor(this.rng() * options.length)] as WeatherKind;
    this.target = copyProfile(WEATHER[this.weather]);
    this.weatherTimer = 30 + this.rng() * 18;
    this.notice = `${WEATHER_ICON[this.weather]} 天气转为${WEATHER_LABEL[this.weather]}`;
  }

  private updateLightning(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 4.8);
    if (dt <= 0 || this.current.storm < 0.42) return;
    this.lightningTimer -= dt;
    if (this.lightningTimer > 0) return;
    this.flash = 1;
    this.lightningTimer = 5 + this.rng() * 10;
    this.thunderPending = true;
  }

  private applyAtmosphere(anchor: THREE.Vector3): void {
    const solar = ((this.timeHours - 6) / 24) * Math.PI * 2;
    const sunY = Math.sin(solar);
    const horizontal = Math.cos(solar);
    this.sunDir.set(horizontal * 0.86, sunY, Math.sin(solar * 0.58 + 0.7) * 0.42).normalize();
    const daylight = smoothstep(-0.15, 0.22, sunY);
    const twilight = (1 - smoothstep(0.03, 0.68, Math.abs(sunY))) * smoothstep(-0.2, 0.04, sunY);

    this.zenith.copy(this.nightZenith).lerp(this.dayZenith, daylight).lerp(this.dawnZenith, twilight * 0.55);
    this.horizon.copy(this.nightHorizon).lerp(this.dayHorizon, daylight).lerp(this.dawnHorizon, twilight * 0.82);
    this.sky.setAtmosphere(
      this.zenith, this.horizon, this.sunDir, daylight, this.current.cloud, this.current.wind, this.flash,
    );

    this.fogColor.copy(this.horizon).lerp(this.cloudFog, this.current.cloud * 0.24);
    this.fog.color.copy(this.fogColor);
    this.fog.near = this.current.fogNear;
    this.fog.far = this.current.fogFar;

    const moon = sunY < -0.08;
    this.lightDir.copy(this.sunDir);
    if (moon) this.lightDir.negate();
    if (this.lightDir.y < 0.12) this.lightDir.y = 0.12;
    this.lightDir.normalize();
    const lightDistance = 112;
    this.sun.position.set(
      anchor.x + this.lightDir.x * lightDistance,
      18 + this.lightDir.y * lightDistance,
      anchor.z + this.lightDir.z * lightDistance,
    );
    this.sun.target.position.set(anchor.x, 0, anchor.z);
    this.sun.target.updateMatrixWorld();
    if (moon) {
      this.sun.color.setHex(0x9ab8e6);
      this.sun.intensity = 0.32 * this.current.light + this.flash * 2.6;
    } else {
      this.sun.color.copy(this.warmSun).lerp(this.daySun, smoothstep(0.04, 0.58, sunY));
      this.sun.intensity = (0.16 + daylight * 2.38) * this.current.light + this.flash * 2.8;
    }
    this.hemi.color.copy(this.zenith).lerp(this.dayHemi, daylight * 0.28);
    this.hemi.groundColor.copy(this.nightGround).lerp(this.dayGround, daylight);
    // 阴雨天用柔和天空光补足被云层削弱的直射光，室内和建筑背阴面仍保持可辨识。
    const rainFill = this.current.rain * (0.08 + daylight * 0.14);
    this.hemi.intensity = 0.42 + daylight * 0.62 * this.current.light + rainFill + this.flash * 1.7;

    const groundDay = lerp(0.76, 1, daylight) * lerp(0.86, 1, this.current.light);
    this.terrainMat.color.setRGB(groundDay * (0.9 + daylight * 0.1), groundDay * (0.94 + daylight * 0.06), groundDay);
    this.terrainMat.roughness = 0.96 - this.current.wet * 0.13;
    this.waterMat.color.copy(this.nightWater).lerp(this.dayWater, daylight).lerp(this.stormWater, this.current.cloud * 0.34);
    this.waterMat.specular.setHex(moon ? 0x6f91b7 : 0xbde8ef);
    this.waterMat.shininess = 90 + this.current.wet * 45;
    this.waterMat.opacity = 0.73 + this.current.rain * 0.045;

    this.snapshot.daylight = daylight;
    this.snapshot.exposure = clamp(
      1.17 - daylight * 0.09 + (1 - this.current.light) * 0.08 + this.current.rain * 0.09 + this.current.storm * 0.025,
      1.06,
      1.3,
    );
  }

  private updateRain(dt: number, camPos: THREE.Vector3): void {
    const amount = this.current.rain;
    this.rain.visible = amount > 0.025;
    this.rain.material.opacity = clamp(amount * 0.64, 0, 0.68);
    this.rain.material.color.setHex(this.snapshot.daylight > 0.3 ? 0xbad7e5 : 0x7b9bbb);
    this.rain.position.copy(camPos);
    if (!this.rain.visible) return;
    const windX = this.current.wind * 0.2;
    const windZ = this.current.wind * -0.08;
    for (let i = 0; i < this.rainSpeed.length; i++) {
      const o = i * 6;
      let y = (this.rainPos[o + 1] as number) - (this.rainSpeed[i] as number) * dt;
      if (y < -4) y += 36;
      const x = this.rainSeed[i * 2] as number;
      const z = this.rainSeed[i * 2 + 1] as number;
      this.rainPos[o] = x;
      this.rainPos[o + 1] = y;
      this.rainPos[o + 2] = z;
      this.rainPos[o + 3] = x - windX;
      this.rainPos[o + 4] = y - 1.75;
      this.rainPos[o + 5] = z - windZ;
    }
    const attr = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private syncSnapshot(daylight: number): void {
    this.snapshot.timeText = timeText(this.timeHours);
    this.snapshot.phaseLabel = phaseAt(this.timeHours);
    this.snapshot.weather = this.weather;
    this.snapshot.weatherLabel = WEATHER_LABEL[this.weather];
    this.snapshot.rainIntensity = this.current.rain;
    this.snapshot.daylight = daylight;
  }
}
