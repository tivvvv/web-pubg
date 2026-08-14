// 低模军用运输机(航线投放/空投共用, 单实例)
import * as THREE from 'three';

// 运输机模型以 +Z 为机头。登机阶段把镜头放在尾部跳伞舱门，朝航线后方观察。
export const TRANSPORT_PLANE_NOSE_TIP_Z = 8.4;
export const TRANSPORT_PLANE_JUMP_BAY_BACK = 7.08;
export const TRANSPORT_PLANE_JUMP_BAY_HEIGHT_FROM_CHARACTER = -0.56;

// 镜头空间尾部跳伞舱。外模没有可进入的内舱，因此只补足贴近镜头的舱门框、
// 防滑跳板和货舱结构；视野中央保持完全敞开，明确表达“站在跳伞口”等待离机。
export function buildTransportJumpBayView(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'transport-jump-bay-view';
  group.visible = false;
  const frame = new THREE.MeshBasicMaterial({ color: 0x4f5d4d, depthTest: false, depthWrite: false });
  const frameDark = new THREE.MeshBasicMaterial({ color: 0x273129, depthTest: false, depthWrite: false });
  const floor = new THREE.MeshBasicMaterial({ color: 0x657064, depthTest: false, depthWrite: false });
  const floorDark = new THREE.MeshBasicMaterial({ color: 0x343e37, depthTest: false, depthWrite: false });
  const warning = new THREE.MeshBasicMaterial({ color: 0xe2b63f, depthTest: false, depthWrite: false });
  const glowRed = new THREE.MeshBasicMaterial({ color: 0xff4c42, depthTest: false, depthWrite: false });
  const glowGreen = new THREE.MeshBasicMaterial({ color: 0x62ed78, depthTest: false, depthWrite: false });
  const addBox = (name: string, material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
    const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    part.name = name;
    part.position.set(x, y, z);
    part.renderOrder = 950;
    group.add(part);
    return part;
  };

  // 舱门轮廓只占据画面边缘，不再出现驾驶舱风挡、仪表台和机鼻。
  addBox('jump-bay-door-top', frameDark, 3.36, 0.16, 0.18, 0, 1.03, -3.15);
  for (const side of [-1, 1]) {
    addBox('jump-bay-door-post', frame, 0.18, 2.18, 0.2, side * 1.58, -0.02, -3.13);
    addBox('jump-bay-side-wall', frameDark, 0.52, 2.08, 2.5, side * 1.73, -0.03, -2.02);
    addBox('jump-bay-handrail', warning, 0.06, 0.06, 1.42, side * 1.37, -0.28, -1.83);
    for (let rib = 0; rib < 3; rib++) {
      const structuralRib = addBox('jump-bay-rib', frame, 0.09, 1.65, 0.08, side * 1.48, 0.02, -1.12 - rib * 0.68);
      structuralRib.rotation.z = side * -0.08;
    }
  }

  const ramp = addBox('jump-bay-ramp', floor, 2.86, 0.1, 3.25, 0, -0.84, -1.76);
  ramp.rotation.x = -0.055;
  for (let rail = 0; rail < 5; rail++) {
    addBox('jump-bay-floor-rib', floorDark, 2.64, 0.025, 0.055, 0, -0.775 - rail * 0.01, -0.48 - rail * 0.55);
  }
  for (let stripe = 0; stripe < 7; stripe++) {
    const safetyStripe = addBox('jump-bay-warning-stripe', stripe % 2 === 0 ? warning : frameDark, 0.34, 0.025, 0.28, -1.02 + stripe * 0.34, -0.785, -3.05);
    safetyStripe.rotation.y = -0.42;
  }
  const redLight = new THREE.Mesh(new THREE.CircleGeometry(0.085, 12), glowRed);
  redLight.name = 'jump-bay-red-light';
  redLight.position.set(-1.31, 0.68, -3.02);
  redLight.renderOrder = 960;
  group.add(redLight);
  const greenLight = new THREE.Mesh(new THREE.CircleGeometry(0.085, 12), glowGreen);
  greenLight.name = 'jump-bay-green-light';
  greenLight.position.set(1.31, 0.68, -3.02);
  greenLight.renderOrder = 960;
  group.add(greenLight);
  return group;
}

// 低模军用运输机: 机身/高置主翼/尾翼/4 发螺旋桨(旋转桨盘) + 尾部跳板的暗示
// 共享材质, 单实例; 返回桨盘供每帧旋转
export function buildTransportPlane(): { group: THREE.Group; props: THREE.Object3D[] } {
  const camo = new THREE.MeshStandardMaterial({ color: 0x64705b, roughness: 0.82, metalness: 0.06, emissive: 0x11140f, emissiveIntensity: 0.12 });
  const camoDark = new THREE.MeshStandardMaterial({ color: 0x414b3c, roughness: 0.88, metalness: 0.08, emissive: 0x0b0d0a, emissiveIntensity: 0.1 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x263846, roughness: 0.24, metalness: 0.18 });
  const marking = new THREE.MeshStandardMaterial({ color: 0xd7d0b5, roughness: 0.72 });
  const warning = new THREE.MeshStandardMaterial({ color: 0xc96a39, roughness: 0.75 });
  const propMat = new THREE.MeshBasicMaterial({ color: 0x1c1c1c, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x20231f, roughness: 0.72, metalness: 0.15 });
  const g = new THREE.Group();
  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  // 机身(+Z 为机头) + 机头收缩 + 驾驶舱玻璃
  box(camo, 2.4, 2.3, 12.5, 0, 0, 0);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 1.05, 2.2, 4), camo);
  nose.rotation.x = -Math.PI / 2;
  nose.rotation.y = Math.PI / 4;
  nose.position.set(0, -0.1, 7.3);
  g.add(nose);
  box(glass, 1.6, 0.7, 0.9, 0, 0.75, 6.1);
  box(glass, 0.08, 0.56, 1.05, -1.17, 0.62, 5.55);
  box(glass, 0.08, 0.56, 1.05, 1.17, 0.62, 5.55);
  // 高置主翼 + 翼尖
  box(camo, 16.5, 0.28, 2.9, 0, 1.05, 0.6);
  box(camoDark, 0.7, 0.24, 2.6, -8.4, 1.05, 0.6);
  box(camoDark, 0.7, 0.24, 2.6, 8.4, 1.05, 0.6);
  // 4 发发动机舱 + 桨盘
  const props: THREE.Object3D[] = [];
  for (const ex of [-5.6, -2.7, 2.7, 5.6]) {
    box(camoDark, 0.85, 0.85, 2.6, ex, 0.55, 1.6);
    const pg = new THREE.Group();
    pg.position.set(ex, 0.55, 3.0);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.06, 12), propMat);
    disc.rotation.x = Math.PI / 2;
    pg.add(disc);
    for (let bi = 0; bi < 4; bi++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = bi * Math.PI / 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.18, 0.045), bladeMat);
      blade.position.y = 0.62;
      pivot.add(blade);
      pg.add(pivot);
    }
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 8), camoDark);
    spinner.rotation.x = Math.PI / 2;
    spinner.position.z = 0.2;
    pg.add(spinner);
    g.add(pg);
    props.push(pg);
  }
  // 尾翼: 垂尾 + 平尾
  box(camo, 0.3, 2.6, 2.4, 0, 1.9, -5.6);
  box(camo, 5.6, 0.22, 1.7, 0, 1.35, -5.7);
  // 翼面识别带、机舱分割线和起落架整流罩。
  box(marking, 3.6, 0.035, 0.72, -4.6, 1.22, 0.3);
  box(marking, 3.6, 0.035, 0.72, 4.6, 1.22, 0.3);
  box(warning, 0.08, 1.25, 0.06, -1.22, -0.05, -2.3);
  box(warning, 0.08, 1.25, 0.06, 1.22, -0.05, -2.3);
  box(camoDark, 0.55, 0.42, 1.45, -3.15, 0.18, -0.05);
  box(camoDark, 0.55, 0.42, 1.45, 3.15, 0.18, -0.05);
  // 尾跳板暗示(机尾腹面暗色斜板)
  const ramp = box(camoDark, 1.9, 0.18, 2.6, 0, -0.95, -6.3);
  ramp.rotation.x = 0.35;
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { group: g, props };
}
