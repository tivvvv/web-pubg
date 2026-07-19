// 低模军用运输机(航线投放/空投共用, 单实例)
import * as THREE from 'three';

// 低模军用运输机: 机身/高置主翼/尾翼/4 发螺旋桨(旋转桨盘) + 尾部跳板的暗示
// 共享材质, 单实例; 返回桨盘供每帧旋转
export function buildTransportPlane(): { group: THREE.Group; props: THREE.Object3D[] } {
  const camo = new THREE.MeshLambertMaterial({ color: 0x5d6b58 });   // 哑光军绿
  const camoDark = new THREE.MeshLambertMaterial({ color: 0x46523f }); // 腹面/细节
  const glass = new THREE.MeshLambertMaterial({ color: 0x2c3844 });
  const propMat = new THREE.MeshBasicMaterial({ color: 0x1c1c1c, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
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
    g.add(pg);
    props.push(pg);
  }
  // 尾翼: 垂尾 + 平尾
  box(camo, 0.3, 2.6, 2.4, 0, 1.9, -5.6);
  box(camo, 5.6, 0.22, 1.7, 0, 1.35, -5.7);
  // 尾跳板暗示(机尾腹面暗色斜板)
  const ramp = box(camoDark, 1.9, 0.18, 2.6, 0, -0.95, -6.3);
  ramp.rotation.x = 0.35;
  return { group: g, props };
}
