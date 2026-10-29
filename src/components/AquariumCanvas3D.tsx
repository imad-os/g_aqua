import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULT_SPECIES_LIST, TANK_TIERS } from '../engine/defaults';
import { getTankBoundsAtZ } from '../engine/simulation';
import {
  EnvironmentQualityTier,
  FishPolygonQuality,
  FoodPellet,
  SavedEcosystemState,
  ThreatEntity,
} from '../engine/types';

// Pre-allocated scratch math helpers at module scope (zero GC in render loop)
const _vec3A = new THREE.Vector3();
const _vec3CamTarget = new THREE.Vector3();
const _vec3LookTarget = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scaleVec = new THREE.Vector3();
const _color = new THREE.Color();

export interface AquariumCanvas3DProps {
  ecosystemRef: React.MutableRefObject<SavedEcosystemState>;
  pelletsRef: React.MutableRefObject<FoodPellet[]>;
  threatsRef: React.MutableRefObject<ThreatEntity[]>;
  cursorPosRef: React.MutableRefObject<{ x: number; y: number; z: number }>;
  cameraOrbitRef: React.MutableRefObject<{ yaw: number; pitch: number; zoom: number }>;
  selectedFishId: string | null;
  screensaverMode: boolean;
  qualityTier: EnvironmentQualityTier;
  fishPolygonQuality?: FishPolygonQuality;
  framelessTvMode?: boolean;
  activeTankTier: number;
  isPaused: boolean;
  onTickSimulation: (dt: number) => void;
  onSelectFish?: (fishId: string) => void;
  onPolygonStatsUpdate?: (stats: { trianglesPerFish: number; totalFishTriangles: number }) => void;
  onFpsUpdate?: (fps: number) => void;
}

type FishMaterialType =
  | THREE.MeshBasicMaterial
  | THREE.MeshLambertMaterial
  | THREE.MeshStandardMaterial
  | THREE.MeshPhysicalMaterial;

interface FishMeshRig {
  group: THREE.Group;
  bodyGeo: THREE.BufferGeometry;
  staticFinsGeo: THREE.BufferGeometry;
  bodyMat: FishMaterialType;
  finMat: FishMaterialType;
  liveSkinMap: THREE.CanvasTexture;
  liveFinMap: THREE.CanvasTexture;
  liveAccentColor: THREE.Color;
  spineUniforms: {
    uTailPhase: { value: number };
    uSwimAmp: { value: number };
  };
  tailPeduncleGroup: THREE.Group;
  tailBladeMesh: THREE.Mesh;
  pectoralLeftGroup: THREE.Group;
  pectoralRightGroup: THREE.Group;
  selectionRing: THREE.Mesh;
  shadowDisc: THREE.Mesh;
  speciesId: string;
  polygonQuality: FishPolygonQuality;
  materialTier: EnvironmentQualityTier;
  isDeadVisualApplied: boolean;
  triangleCount: number;
}

export function getPolygonSpecForQuality(quality: FishPolygonQuality): {
  lengthRings: number;
  radialSegments: number;
  finSegmentsU: number;
  finSegmentsV: number;
  eyeSegments: number;
  label: string;
} {
  switch (quality) {
    case 'very_low':
      return {
        lengthRings: 8,
        radialSegments: 6,
        finSegmentsU: 2,
        finSegmentsV: 2,
        eyeSegments: 4,
        label: 'Very Low (~140 Polygons/Fish)',
      };
    case 'low':
      return {
        lengthRings: 14,
        radialSegments: 10,
        finSegmentsU: 5,
        finSegmentsV: 5,
        eyeSegments: 6,
        label: 'Low (~420 Polygons/Fish)',
      };
    case 'medium':
      return {
        lengthRings: 24,
        radialSegments: 16,
        finSegmentsU: 8,
        finSegmentsV: 8,
        eyeSegments: 10,
        label: 'Medium (~1,380 Polygons/Fish)',
      };
    case 'ultra':
      return {
        lengthRings: 52,
        radialSegments: 38,
        finSegmentsU: 16,
        finSegmentsV: 14,
        eyeSegments: 16,
        label: 'Ultra (~6,800 Polygons/Fish)',
      };
    case 'high':
    default:
      return {
        lengthRings: 34,
        radialSegments: 24,
        finSegmentsU: 11,
        finSegmentsV: 11,
        eyeSegments: 12,
        label: 'High (~2,950 Polygons/Fish)',
      };
  }
}

/**
 * Generates tileable procedural sand, ripple bump, and underwater caustic textures.
 */
function createProceduralSandAndCausticsTextures(
  maxAnisotropy: number
): { sandMap: THREE.CanvasTexture; sandBump: THREE.CanvasTexture; causticMap: THREE.CanvasTexture } {
  const sandCanvas = document.createElement('canvas');
  sandCanvas.width = 256;
  sandCanvas.height = 256;
  const sCtx = sandCanvas.getContext('2d')!;
  sCtx.fillStyle = '#1b2c3b';
  sCtx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 2) {
    const wave = Math.sin((y / 256) * Math.PI * 12) * 14;
    sCtx.fillStyle = `rgb(${26 + wave}, ${46 + wave}, ${62 + wave})`;
    sCtx.fillRect(0, y, 256, 2);
  }
  for (let i = 0; i < 1200; i++) {
    const x = (i * 73) % 256;
    const y = (i * 137) % 256;
    sCtx.fillStyle = i % 2 === 0 ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.18)';
    sCtx.fillRect(x, y, 2, 2);
  }
  const sandMap = new THREE.CanvasTexture(sandCanvas);
  sandMap.colorSpace = THREE.SRGBColorSpace;
  sandMap.wrapS = THREE.RepeatWrapping;
  sandMap.wrapT = THREE.RepeatWrapping;
  sandMap.repeat.set(4, 4);
  sandMap.anisotropy = maxAnisotropy;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 256;
  bumpCanvas.height = 256;
  const bCtx = bumpCanvas.getContext('2d')!;
  for (let y = 0; y < 256; y++) {
    const v = Math.floor(128 + Math.sin((y / 256) * Math.PI * 16) * 65);
    bCtx.fillStyle = `rgb(${v},${v},${v})`;
    bCtx.fillRect(0, y, 256, 1);
  }
  const sandBump = new THREE.CanvasTexture(bumpCanvas);
  sandBump.wrapS = THREE.RepeatWrapping;
  sandBump.wrapT = THREE.RepeatWrapping;
  sandBump.repeat.set(6, 6);
  sandBump.anisotropy = maxAnisotropy;

  const cCanvas = document.createElement('canvas');
  cCanvas.width = 256;
  cCanvas.height = 256;
  const cCtx = cCanvas.getContext('2d')!;
  cCtx.fillStyle = '#000000';
  cCtx.fillRect(0, 0, 256, 256);
  cCtx.strokeStyle = 'rgba(56, 189, 248, 0.44)';
  cCtx.lineWidth = 2.2;
  for (let i = 0; i < 28; i++) {
    const cx = ((i * 53) % 220) + 18;
    const cy = ((i * 97) % 220) + 18;
    const r = 18 + (i % 5) * 7;
    cCtx.beginPath();
    cCtx.arc(cx, cy, r, 0, Math.PI * 2);
    cCtx.stroke();
  }
  const causticMap = new THREE.CanvasTexture(cCanvas);
  causticMap.colorSpace = THREE.SRGBColorSpace;
  causticMap.wrapS = THREE.RepeatWrapping;
  causticMap.wrapT = THREE.RepeatWrapping;
  causticMap.repeat.set(3, 3);
  causticMap.anisotropy = maxAnisotropy;

  return { sandMap, sandBump, causticMap };
}

// Cache skin & fin textures per species colors so we don't recreate canvases unnecessarily
const _skinTextureCache = new Map<
  string,
  { skinMap: THREE.CanvasTexture; skinBump: THREE.CanvasTexture; finMap: THREE.CanvasTexture }
>();

let _deadGreyTextures: {
  deadSkinMap: THREE.CanvasTexture;
  deadFinMap: THREE.CanvasTexture;
} | null = null;

/**
 * Generates pure monochrome greyed-out textures for DEAD fishes so any starved/killed fish
 * is unmistakably greyed in color inside the 3D aquarium.
 */
function getOrCreateDeadFishGreyscaleTextures(): {
  deadSkinMap: THREE.CanvasTexture;
  deadFinMap: THREE.CanvasTexture;
} {
  if (_deadGreyTextures) return _deadGreyTextures;
  const { skinMap, finMap } = getOrCreateFishSkinTextures('#9ca3af', '#4b5563', '#d1d5db');
  _deadGreyTextures = { deadSkinMap: skinMap, deadFinMap: finMap };
  return _deadGreyTextures;
}

function getOrCreateFishSkinTextures(
  primaryHex: string,
  secondaryHex: string,
  accentHex: string
): { skinMap: THREE.CanvasTexture; skinBump: THREE.CanvasTexture; finMap: THREE.CanvasTexture } {
  const key = `${primaryHex}_${secondaryHex}_${accentHex}`;
  const cached = _skinTextureCache.get(key);
  if (cached) return cached;

  // 1. Fish Body Albedo Texture (Countershading: dark dorsum, iridescent lateral stripe, silver belly, overlapping scales)
  const skinCanvas = document.createElement('canvas');
  skinCanvas.width = 256;
  skinCanvas.height = 128;
  const ctx = skinCanvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.0, secondaryHex);
  grad.addColorStop(0.28, primaryHex);
  grad.addColorStop(0.48, accentHex);
  grad.addColorStop(0.62, primaryHex);
  grad.addColorStop(0.88, '#e2e8f0');
  grad.addColorStop(1.0, '#cbd5e1');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 128);

  const stripeGrad = ctx.createLinearGradient(40, 0, 245, 0);
  stripeGrad.addColorStop(0, 'rgba(255,255,255,0)');
  stripeGrad.addColorStop(0.2, accentHex);
  stripeGrad.addColorStop(0.85, accentHex);
  stripeGrad.addColorStop(1.0, secondaryHex);
  ctx.fillStyle = stripeGrad;
  ctx.fillRect(35, 54, 210, 17);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
  ctx.lineWidth = 1.1;
  const scaleCols = 22;
  const scaleRows = 11;
  const colW = 256 / scaleCols;
  const rowH = 128 / scaleRows;
  for (let r = 0; r < scaleRows; r++) {
    for (let c = 3; c < scaleCols; c++) {
      const cx = c * colW + (r % 2 === 0 ? 0 : colW * 0.5);
      const cy = r * rowH + rowH * 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, rowH * 0.54, -Math.PI * 0.42, Math.PI * 0.42);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(59, 64, 38, -Math.PI * 0.36, Math.PI * 0.36);
  ctx.stroke();

  const skinMap = new THREE.CanvasTexture(skinCanvas);
  skinMap.colorSpace = THREE.SRGBColorSpace;
  skinMap.wrapS = THREE.ClampToEdgeWrapping;
  skinMap.wrapT = THREE.RepeatWrapping;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 128;
  bumpCanvas.height = 64;
  const bCtx = bumpCanvas.getContext('2d')!;
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, 128, 64);
  bCtx.strokeStyle = '#d4d4d4';
  bCtx.lineWidth = 1.2;
  for (let r = 0; r < 10; r++) {
    for (let c = 2; c < 18; c++) {
      const cx = c * 7 + (r % 2) * 3.5;
      const cy = r * 6.4 + 3;
      bCtx.beginPath();
      bCtx.arc(cx, cy, 3.2, -Math.PI * 0.4, Math.PI * 0.4);
      bCtx.stroke();
    }
  }
  const skinBump = new THREE.CanvasTexture(bumpCanvas);
  skinBump.wrapS = THREE.ClampToEdgeWrapping;
  skinBump.wrapT = THREE.RepeatWrapping;

  const finCanvas = document.createElement('canvas');
  finCanvas.width = 128;
  finCanvas.height = 128;
  const fCtx = finCanvas.getContext('2d')!;
  const finGrad = fCtx.createLinearGradient(0, 0, 128, 0);
  finGrad.addColorStop(0.0, secondaryHex);
  finGrad.addColorStop(0.45, primaryHex);
  finGrad.addColorStop(0.85, accentHex);
  finGrad.addColorStop(1.0, '#ffffff');
  fCtx.fillStyle = finGrad;
  fCtx.fillRect(0, 0, 128, 128);

  fCtx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  fCtx.lineWidth = 1.4;
  for (let i = 0; i < 18; i++) {
    const y = (i / 17) * 128;
    fCtx.beginPath();
    fCtx.moveTo(0, 64 + (y - 64) * 0.35);
    fCtx.lineTo(128, y);
    fCtx.stroke();
  }
  const finMap = new THREE.CanvasTexture(finCanvas);
  finMap.colorSpace = THREE.SRGBColorSpace;

  const result = { skinMap, skinBump, finMap };
  _skinTextureCache.set(key, result);
  return result;
}

/**
 * Attaches a fast GPU vertex shader hook (`onBeforeCompile`) so the fish spine S-wave
 * swimming deformation runs 100% on the GPU with zero CPU vertex loop and zero buffer uploads.
 */
function attachGpuSpineWaveShader(
  material: FishMaterialType,
  uniforms: { uTailPhase: { value: number }; uSwimAmp: { value: number } }
) {
  material.customProgramCacheKey = () => 'fish-gpu-spine-wave-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTailPhase = uniforms.uTailPhase;
    shader.uniforms.uSwimAmp = uniforms.uSwimAmp;
    shader.vertexShader =
      `uniform float uTailPhase;\nuniform float uSwimAmp;\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float spineU = clamp((0.66 - position.z) / 1.32, 0.0, 1.0);
        float spineEnv = spineU * spineU * 1.15 + spineU * 0.15;
        transformed.x += sin(uTailPhase - spineU * 4.2) * uSwimAmp * spineEnv;`
      );
  };
}

interface CachedFishGeometrySet {
  mergedBodyGeo: THREE.BufferGeometry;
  staticFinsGeo: THREE.BufferGeometry;
  tailGeo: THREE.BufferGeometry;
  pecGeo: THREE.BufferGeometry;
  pecRightGeo: THREE.BufferGeometry;
  mergedIrisGeo: THREE.BufferGeometry;
  mergedPupilGeo: THREE.BufferGeometry;
  mergedCatchGeo: THREE.BufferGeometry | null;
  ringGeo: THREE.BufferGeometry;
  shadowGeo: THREE.BufferGeometry;
  triangleCount: number;
}

const _fishGeometrySetCache = new Map<string, CachedFishGeometrySet>();

function getOrCreateCachedFishGeometrySet(
  bodyStyle: string,
  polygonQuality: FishPolygonQuality
): CachedFishGeometrySet {
  const cacheKey = `${bodyStyle}|${polygonQuality}`;
  const existing = _fishGeometrySetCache.get(cacheKey);
  if (existing) return existing;

  const polySpec = getPolygonSpecForQuality(polygonQuality);
  const isVeryLowPoly = polygonQuality === 'very_low';
  const isAngel = bodyStyle === 'angel_disc';

  // 1. Body + Gills
  const coreBodyGeo = buildSculptedFishBodyGeometry(
    bodyStyle,
    polySpec.lengthRings,
    polySpec.radialSegments
  );
  let mergedBodyGeo: THREE.BufferGeometry = coreBodyGeo;
  if (!isVeryLowPoly) {
    const gillLeftGeo = new THREE.SphereGeometry(0.14, polySpec.eyeSegments, polySpec.eyeSegments);
    gillLeftGeo.scale(0.28, 1.35, 0.95);
    gillLeftGeo.rotateY(0.22);
    gillLeftGeo.translate(0.21, -0.01, 0.31);

    const gillRightGeo = new THREE.SphereGeometry(0.14, polySpec.eyeSegments, polySpec.eyeSegments);
    gillRightGeo.scale(0.28, 1.35, 0.95);
    gillRightGeo.rotateY(-0.22);
    gillRightGeo.translate(-0.21, -0.01, 0.31);

    mergedBodyGeo =
      mergeGeometries([coreBodyGeo, gillLeftGeo, gillRightGeo], false) || coreBodyGeo;
  }

  // 2. Static Fins
  const dorsalGeo = build3DVolumetricFinGeometry(
    'dorsal',
    bodyStyle,
    polySpec.finSegmentsU,
    polySpec.finSegmentsV
  );
  dorsalGeo.translate(0, isAngel ? 0.44 : 0.26, -0.04);

  const analGeo = build3DVolumetricFinGeometry(
    'anal',
    bodyStyle,
    Math.max(2, Math.floor(polySpec.finSegmentsU * 0.75)),
    Math.max(2, Math.floor(polySpec.finSegmentsV * 0.75))
  );
  analGeo.translate(0, isAngel ? -0.38 : -0.22, -0.22);

  const finPartsToMerge: THREE.BufferGeometry[] = [dorsalGeo, analGeo];
  if (!isVeryLowPoly) {
    const pelvicSegU = Math.max(3, Math.floor(polySpec.finSegmentsU * 0.65));
    const pelvicSegV = Math.max(3, Math.floor(polySpec.finSegmentsV * 0.65));
    const pelvicLeftGeo = build3DVolumetricFinGeometry('pelvic', bodyStyle, pelvicSegU, pelvicSegV);
    pelvicLeftGeo.rotateZ(0.32);
    pelvicLeftGeo.translate(0.08, isAngel ? -0.36 : -0.23, 0.14);

    const pelvicRightGeo = build3DVolumetricFinGeometry('pelvic', bodyStyle, pelvicSegU, pelvicSegV);
    pelvicRightGeo.rotateZ(-0.32);
    pelvicRightGeo.translate(-0.08, isAngel ? -0.36 : -0.23, 0.14);

    const lureGeo = new THREE.SphereGeometry(0.045, 6, 6);
    lureGeo.translate(0, isAngel ? 0.48 : 0.28, 0.25);
    finPartsToMerge.push(pelvicLeftGeo, pelvicRightGeo, lureGeo);
  }
  const staticFinsGeo = mergeGeometries(finPartsToMerge, false) || dorsalGeo;

  // 3. Caudal Tail
  const tailGeo = build3DVolumetricFinGeometry(
    'caudal',
    bodyStyle,
    polySpec.finSegmentsU,
    polySpec.finSegmentsV
  );

  // 4. Pectoral Fins
  const pecGeo = build3DVolumetricFinGeometry(
    'pectoral',
    bodyStyle,
    polySpec.finSegmentsU,
    polySpec.finSegmentsV
  );
  const pecRightGeo = pecGeo.clone();
  pecRightGeo.scale(-1, 1, 1);
  const pecRightIdx = pecRightGeo.index;
  if (pecRightIdx) {
    const arr = pecRightIdx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
  }

  // 5. Eyes
  const irisL = new THREE.SphereGeometry(0.068, polySpec.eyeSegments, polySpec.eyeSegments);
  irisL.scale(0.65, 1.0, 1.0);
  irisL.rotateY(0.24);
  irisL.translate(0.165, 0.075, 0.44);
  const irisR = new THREE.SphereGeometry(0.068, polySpec.eyeSegments, polySpec.eyeSegments);
  irisR.scale(0.65, 1.0, 1.0);
  irisR.rotateY(-0.24);
  irisR.translate(-0.165, 0.075, 0.44);
  const mergedIrisGeo = mergeGeometries([irisL, irisR], false) || irisL;

  const pupilL = new THREE.SphereGeometry(0.044, polySpec.eyeSegments, polySpec.eyeSegments);
  pupilL.translate(0.19, 0.075, 0.455);
  const pupilR = new THREE.SphereGeometry(0.044, polySpec.eyeSegments, polySpec.eyeSegments);
  pupilR.translate(-0.19, 0.075, 0.455);
  const mergedPupilGeo = mergeGeometries([pupilL, pupilR], false) || pupilL;

  let mergedCatchGeo: THREE.BufferGeometry | null = null;
  if (!isVeryLowPoly) {
    const catchL = new THREE.SphereGeometry(0.018, 6, 6);
    catchL.translate(0.207, 0.097, 0.468);
    const catchR = new THREE.SphereGeometry(0.018, 6, 6);
    catchR.translate(-0.207, 0.097, 0.468);
    mergedCatchGeo = mergeGeometries([catchL, catchR], false) || catchL;
  }

  const ringGeo = new THREE.RingGeometry(0.72, 0.82, isVeryLowPoly ? 12 : 24);
  ringGeo.rotateX(-Math.PI / 2);

  const shadowGeo = new THREE.CircleGeometry(0.55, isVeryLowPoly ? 8 : 14);
  shadowGeo.rotateX(-Math.PI / 2);

  const countGeoTris = (g: THREE.BufferGeometry | null) => {
    if (!g) return 0;
    if (g.index) return g.index.count / 3;
    return g.attributes.position ? g.attributes.position.count / 3 : 0;
  };
  const triangleCount = Math.round(
    countGeoTris(mergedBodyGeo) +
      countGeoTris(staticFinsGeo) +
      countGeoTris(tailGeo) +
      countGeoTris(pecGeo) +
      countGeoTris(pecRightGeo) +
      countGeoTris(mergedIrisGeo) +
      countGeoTris(mergedPupilGeo) +
      countGeoTris(mergedCatchGeo)
  );

  const created: CachedFishGeometrySet = {
    mergedBodyGeo,
    staticFinsGeo,
    tailGeo,
    pecGeo,
    pecRightGeo,
    mergedIrisGeo,
    mergedPupilGeo,
    mergedCatchGeo,
    ringGeo,
    shadowGeo,
    triangleCount,
  };
  _fishGeometrySetCache.set(cacheKey, created);
  return created;
}

/**
 * Builds a true 3D anatomically lofted fish body BufferGeometry (+Z is forward snout, -Z is tail peduncle,
 * +Y is dorsal ridge, -Y is ventral belly, +X / -X are left / right sculpted flanks and gill plates).
 */
function buildSculptedFishBodyGeometry(
  bodyStyle: string,
  lengthRings: number,
  radialSegments: number
): THREE.BufferGeometry {
  const numVerts = (lengthRings + 1) * (radialSegments + 1);
  const positions = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);

  const totalLength = 1.32;
  const noseZ = 0.66;

  const isAngel = bodyStyle === 'angel_disc';
  const isLantern = bodyStyle === 'biolum_Latern';
  const maxHalfHeight = isAngel ? 0.56 : isLantern ? 0.38 : 0.32;
  const maxHalfWidth = isAngel ? 0.22 : isLantern ? 0.27 : 0.24;

  let vIdx = 0;
  for (let i = 0; i <= lengthRings; i++) {
    const u = i / lengthRings;
    const z = noseZ - u * totalLength;

    let heightEnvelope: number;
    let widthEnvelope: number;
    let verticalCenterOffset = 0;

    if (u < 0.04) {
      const t = u / 0.04;
      const sphereCap = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
      heightEnvelope = sphereCap * 0.22;
      widthEnvelope = sphereCap * 0.24;
      verticalCenterOffset = -0.02 * (1 - t);
    } else if (u < 0.72) {
      const norm = (u - 0.04) / 0.68;
      const arch = Math.sin(Math.pow(norm, 0.72) * Math.PI);
      heightEnvelope = 0.22 + 0.78 * arch;
      widthEnvelope = 0.24 + 0.76 * Math.sin(Math.pow(norm, 0.65) * Math.PI);

      const gillDist = Math.abs(u - 0.27);
      if (gillDist < 0.06) {
        const gillFlare = Math.cos((gillDist / 0.06) * (Math.PI / 2));
        widthEnvelope += 0.11 * gillFlare;
      }
      verticalCenterOffset = isAngel ? 0.04 * arch : 0.02 * arch;
    } else {
      const tailNorm = (u - 0.72) / 0.28;
      const smoothStep = 1 - tailNorm * tailNorm * (3 - 2 * tailNorm);
      heightEnvelope = 0.22 + 0.22 * smoothStep;
      widthEnvelope = 0.16 + 0.18 * smoothStep;
      if (u > 0.92) {
        heightEnvelope += ((u - 0.92) / 0.08) * 0.08;
      }
    }

    const halfH = maxHalfHeight * heightEnvelope;
    const halfW = maxHalfWidth * widthEnvelope;

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const theta = v * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const dorsalSharpness =
        cosT > 0 ? 1.0 - 0.12 * Math.pow(sinT, 2) : 1.0 + 0.08 * Math.pow(sinT, 2);
      let x = sinT * halfW * dorsalSharpness;
      const y = cosT * halfH + verticalCenterOffset;

      if (u > 0.01 && u < 0.07 && Math.abs(cosT + 0.15) < 0.25) {
        x *= 0.92;
      }

      positions[vIdx * 3 + 0] = x;
      positions[vIdx * 3 + 1] = y;
      positions[vIdx * 3 + 2] = z;

      const symV = Math.abs(v - 0.5) * 2;
      uvs[vIdx * 2 + 0] = u;
      uvs[vIdx * 2 + 1] = 1 - symV;
      vIdx++;
    }
  }

  const indices: number[] = [];
  const stride = radialSegments + 1;
  for (let i = 0; i < lengthRings; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds a 3D volumetric double-sided fin fan (used for Caudal Tail, Dorsal Fin, Anal Fin,
 * and Paired Pectoral/Pelvic Fins) with outward-facing normals on both sides so `THREE.FrontSide`
 * can be used for maximum GPU speed without clipping.
 */
function build3DVolumetricFinGeometry(
  kind: 'caudal' | 'dorsal' | 'pectoral' | 'pelvic' | 'anal',
  bodyStyle: string,
  segU: number,
  segV: number
): THREE.BufferGeometry {
  const cols = segU + 1;
  const rows = segV + 1;
  const sideVerts = cols * rows;
  const positions = new Float32Array(sideVerts * 2 * 3);
  const uvs = new Float32Array(sideVerts * 2 * 2);

  const isAngel = bodyStyle === 'angel_disc';

  function evalFinPoint(u: number, v: number, sideSign: 1 | -1): [number, number, number] {
    const centeredV = (v - 0.5) * 2;
    const rayCorrugation = Math.sin(v * Math.PI * 10) * 0.014 * u;
    const baseThickness = (1 - u * 0.78) * 0.028 + 0.006;
    const xThickness = sideSign * (baseThickness + rayCorrugation * sideSign);

    if (kind === 'caudal') {
      const forkIndent = 1.0 - 0.36 * Math.exp(-centeredV * centeredV * 4.5);
      const spanZ = -u * (isAngel ? 0.68 : 0.54) * forkIndent;
      const spreadY = centeredV * (0.12 + u * (isAngel ? 0.62 : 0.46));
      const cupX = xThickness + Math.sin(u * Math.PI) * (centeredV * centeredV) * 0.04 * sideSign;
      return [cupX, spreadY, spanZ];
    }

    if (kind === 'dorsal') {
      const zRoot = (0.5 - v) * 0.52;
      const heightMax = isAngel ? 0.62 : 0.32;
      const profileH = Math.sin(Math.pow(v, 0.7) * Math.PI) * heightMax;
      const y = u * profileH;
      const z = zRoot - u * (isAngel ? 0.34 : 0.22);
      return [xThickness, y, z];
    }

    if (kind === 'anal') {
      const zRoot = (0.5 - v) * 0.34;
      const depthMax = isAngel ? 0.48 : 0.24;
      const profileD = Math.sin(Math.pow(v, 0.75) * Math.PI) * depthMax;
      const y = -u * profileD;
      const z = zRoot - u * 0.2;
      return [xThickness, y, z];
    }

    if (kind === 'pectoral') {
      const length = 0.38;
      const width = 0.22 * Math.sin(Math.pow(v, 0.65) * Math.PI);
      const z = -u * length * 0.65 + (v - 0.5) * width;
      const y = (v - 0.35) * width * 0.85 - u * 0.06;
      const camberX = Math.sin(u * Math.PI) * 0.045 + xThickness;
      return [camberX, y, z];
    }

    // pelvic fin
    const length = isAngel ? 0.42 : 0.24;
    const z = -u * length * 0.5 + (v - 0.5) * 0.1;
    const y = -u * length;
    return [xThickness, y, z];
  }

  for (let side = 0; side < 2; side++) {
    const sideSign: 1 | -1 = side === 0 ? 1 : -1;
    const offset = side * sideVerts;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      for (let j = 0; j <= segV; j++) {
        const v = j / segV;
        const idx = offset + i * rows + j;
        const [px, py, pz] = evalFinPoint(u, v, sideSign);
        positions[idx * 3 + 0] = px;
        positions[idx * 3 + 1] = py;
        positions[idx * 3 + 2] = pz;
        uvs[idx * 2 + 0] = u;
        uvs[idx * 2 + 1] = v;
      }
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * rows + j;
      const b = (i + 1) * rows + j;
      const c = (i + 1) * rows + (j + 1);
      const d = i * rows + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = sideVerts + i * rows + j;
      const b = sideVerts + (i + 1) * rows + j;
      const c = sideVerts + (i + 1) * rows + (j + 1);
      const d = sideVerts + i * rows + (j + 1);
      indices.push(a, d, b, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds a complete, GPU-accelerated, merged-geometry 3D fish `THREE.Group` with quality-tiered materials.
 */
function createSculpted3DFishRig(
  speciesId: string,
  primaryHex: string,
  secondaryHex: string,
  accentHex: string,
  bodyStyle: string,
  polygonQuality: FishPolygonQuality,
  materialTier: EnvironmentQualityTier
): FishMeshRig {
  const group = new THREE.Group();
  const polySpec = getPolygonSpecForQuality(polygonQuality);
  const isVeryLowPoly = polygonQuality === 'very_low';
  const { skinMap, skinBump, finMap } = getOrCreateFishSkinTextures(
    primaryHex,
    secondaryHex,
    accentHex
  );

  const spineUniforms = {
    uTailPhase: { value: 0 },
    uSwimAmp: { value: 0.085 },
  };

  const liveAccentColor = new THREE.Color(accentHex).lerp(new THREE.Color('#ffffff'), 0.35);

  // Quality-tiered materials with FrontSide culling (huge GPU speedup on Very Low / Low / Mid)
  let bodyMat: FishMaterialType;
  let finMat: FishMaterialType;

  if (materialTier === 'very_low') {
    bodyMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ffffff'),
      map: skinMap,
      side: THREE.FrontSide,
    });
    finMat = new THREE.MeshBasicMaterial({
      color: liveAccentColor.clone(),
      map: finMap,
      side: THREE.FrontSide,
    });
  } else if (materialTier === 'low') {
    bodyMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color('#ffffff'),
      map: skinMap,
      side: THREE.FrontSide,
    });
    finMat = new THREE.MeshLambertMaterial({
      color: liveAccentColor.clone(),
      map: finMap,
      emissive: new THREE.Color(accentHex),
      emissiveIntensity: 0.22,
      side: THREE.FrontSide,
    });
  } else if (materialTier === 'mid') {
    bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ffffff'),
      map: skinMap,
      roughness: 0.28,
      metalness: 0.12,
      side: THREE.FrontSide,
    });
    finMat = new THREE.MeshStandardMaterial({
      color: liveAccentColor.clone(),
      map: finMap,
      roughness: 0.32,
      metalness: 0.08,
      emissive: new THREE.Color(accentHex),
      emissiveIntensity: 0.24,
      side: THREE.FrontSide,
    });
  } else {
    bodyMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      map: skinMap,
      bumpMap: skinBump,
      bumpScale: 0.024,
      roughness: 0.24,
      metalness: 0.14,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18,
      side: THREE.FrontSide,
    });
    finMat = new THREE.MeshPhysicalMaterial({
      color: liveAccentColor.clone(),
      map: finMap,
      roughness: 0.28,
      metalness: 0.1,
      emissive: new THREE.Color(accentHex),
      emissiveIntensity: 0.26,
      transparent: true,
      opacity: 0.92,
      side: THREE.FrontSide,
    });
  }

  // Attach GPU vertex shader spine undulation to both body and static fins
  attachGpuSpineWaveShader(bodyMat, spineUniforms);
  attachGpuSpineWaveShader(finMat, spineUniforms);

  const cachedGeos = getOrCreateCachedFishGeometrySet(bodyStyle, polygonQuality);

  const bodyMesh = new THREE.Mesh(cachedGeos.mergedBodyGeo, bodyMat);
  bodyMesh.castShadow = materialTier === 'high';
  bodyMesh.receiveShadow = materialTier === 'high';
  group.add(bodyMesh);

  const staticFinsMesh = new THREE.Mesh(cachedGeos.staticFinsGeo, finMat);
  group.add(staticFinsMesh);

  const tailPeduncleGroup = new THREE.Group();
  tailPeduncleGroup.position.set(0, 0, -0.61);
  const tailBladeMesh = new THREE.Mesh(cachedGeos.tailGeo, finMat);
  tailPeduncleGroup.add(tailBladeMesh);
  group.add(tailPeduncleGroup);

  const pectoralLeftGroup = new THREE.Group();
  pectoralLeftGroup.position.set(0.21, -0.06, 0.22);
  const pecLeftMesh = new THREE.Mesh(cachedGeos.pecGeo, finMat);
  pecLeftMesh.rotation.y = 0.58;
  pecLeftMesh.rotation.z = -0.24;
  pectoralLeftGroup.add(pecLeftMesh);
  group.add(pectoralLeftGroup);

  const pectoralRightGroup = new THREE.Group();
  pectoralRightGroup.position.set(-0.21, -0.06, 0.22);
  const pecRightMesh = new THREE.Mesh(cachedGeos.pecRightGeo, finMat);
  pecRightMesh.rotation.y = -0.58;
  pecRightMesh.rotation.z = 0.24;
  pectoralRightGroup.add(pecRightMesh);
  group.add(pectoralRightGroup);

  const irisMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(accentHex).lerp(new THREE.Color('#fbbf24'), 0.5),
  });
  group.add(new THREE.Mesh(cachedGeos.mergedIrisGeo, irisMat));

  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x030712 });
  group.add(new THREE.Mesh(cachedGeos.mergedPupilGeo, pupilMat));

  if (cachedGeos.mergedCatchGeo) {
    const eyeHighlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    group.add(new THREE.Mesh(cachedGeos.mergedCatchGeo, eyeHighlightMat));
  }

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const selectionRing = new THREE.Mesh(cachedGeos.ringGeo, ringMat);
  selectionRing.position.set(0, -0.48, 0);
  selectionRing.visible = false;
  group.add(selectionRing);

  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x02060d,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
  });
  const shadowDisc = new THREE.Mesh(cachedGeos.shadowGeo, shadowMat);

  return {
    group,
    bodyGeo: cachedGeos.mergedBodyGeo,
    staticFinsGeo: cachedGeos.staticFinsGeo,
    bodyMat,
    finMat,
    liveSkinMap: skinMap,
    liveFinMap: finMap,
    liveAccentColor,
    spineUniforms,
    tailPeduncleGroup,
    tailBladeMesh,
    pectoralLeftGroup,
    pectoralRightGroup,
    selectionRing,
    shadowDisc,
    speciesId,
    polygonQuality,
    materialTier,
    isDeadVisualApplied: false,
    triangleCount: cachedGeos.triangleCount,
  };
}

export const AquariumCanvas3D: React.FC<AquariumCanvas3DProps> = ({
  ecosystemRef,
  pelletsRef,
  threatsRef,
  cursorPosRef,
  cameraOrbitRef,
  selectedFishId,
  screensaverMode,
  qualityTier,
  fishPolygonQuality = 'high',
  framelessTvMode = true,
  activeTankTier,
  isPaused,
  onTickSimulation,
  onPolygonStatsUpdate,
  onFpsUpdate,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const selectedFishIdRef = useRef(selectedFishId);
  selectedFishIdRef.current = selectedFishId;

  const screensaverRef = useRef(screensaverMode);
  screensaverRef.current = screensaverMode;

  const activeTankTierRef = useRef(activeTankTier);
  activeTankTierRef.current = activeTankTier;

  const fishPolygonQualityRef = useRef<FishPolygonQuality>(fishPolygonQuality);
  fishPolygonQualityRef.current = fishPolygonQuality;

  const framelessTvModeRef = useRef<boolean>(framelessTvMode);
  framelessTvModeRef.current = framelessTvMode;

  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const onTickRef = useRef(onTickSimulation);
  onTickRef.current = onTickSimulation;

  const onPolyStatsRef = useRef(onPolygonStatsUpdate);
  onPolyStatsRef.current = onPolygonStatsUpdate;

  const onFpsUpdateRef = useRef(onFpsUpdate);
  onFpsUpdateRef.current = onFpsUpdate;

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isVeryLowTier = qualityTier === 'very_low';
    const isLowOrVeryLow = qualityTier === 'low' || isVeryLowTier;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isLowOrVeryLow && qualityTier === 'high',
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = isLowOrVeryLow ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.setPixelRatio(
      isVeryLowTier
        ? 0.55
        : qualityTier === 'low'
        ? 0.75
        : qualityTier === 'mid'
        ? 1.0
        : Math.min(window.devicePixelRatio || 1, 1.5)
    );
    renderer.shadowMap.enabled = qualityTier === 'high';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight
    );

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      48,
      (container.clientWidth || window.innerWidth) /
        Math.max(1, container.clientHeight || window.innerHeight),
      0.2,
      140
    );
    camera.position.set(0, 2.2, 18.5);

    // 2. Studio Environment Map via RoomEnvironment + PMREMGenerator (Only on High tier)
    if (qualityTier === 'high') {
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      pmremGenerator.dispose();
    }

    // 3. Multi-Light Underwater Studio Rig (On 'very_low', only 1 light is active to minimize shader overhead)
    const hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x081c30, 1.15);
    hemiLight.position.set(0, 25, 0);
    scene.add(hemiLight);

    const sunKeyLight = new THREE.DirectionalLight(0xfff7e0, 1.85);
    sunKeyLight.position.set(7, 22, 12);
    sunKeyLight.visible = !isVeryLowTier;
    if (qualityTier === 'high') {
      sunKeyLight.castShadow = true;
      sunKeyLight.shadow.mapSize.width = 512;
      sunKeyLight.shadow.mapSize.height = 512;
      const d = 18;
      sunKeyLight.shadow.camera.left = -d;
      sunKeyLight.shadow.camera.right = d;
      sunKeyLight.shadow.camera.top = d;
      sunKeyLight.shadow.camera.bottom = -d;
      sunKeyLight.shadow.camera.near = 1;
      sunKeyLight.shadow.camera.far = 45;
      sunKeyLight.shadow.bias = -0.0005;
      sunKeyLight.shadow.normalBias = 0.02;
    }
    scene.add(sunKeyLight);

    const rimLight = new THREE.DirectionalLight(0x22d3ee, 0.9);
    rimLight.position.set(-12, 8, -14);
    rimLight.visible = !isVeryLowTier;
    scene.add(rimLight);

    const frontFillLight = new THREE.DirectionalLight(0xbae6fd, 0.65);
    frontFillLight.position.set(0, 4, 18);
    frontFillLight.visible = !isVeryLowTier;
    scene.add(frontFillLight);

    const maxAniso = isVeryLowTier ? 1 : renderer.capabilities.getMaxAnisotropy();
    const { sandMap, sandBump, causticMap } = createProceduralSandAndCausticsTextures(maxAniso);

    // 4. Aquarium Habitat Container Group
    const habitatGroup = new THREE.Group();
    scene.add(habitatGroup);

    let causticOverlayPlane: THREE.Mesh | null = null;
    let bulbLightGroup: THREE.Group | null = null;
    let activeFrustumWallsMat: THREE.MeshBasicMaterial | null = null;
    let activeWaterSurfaceMat: THREE.MeshBasicMaterial | null = null;
    let kelpInstancedMesh: THREE.InstancedMesh | null = null;
    let kelpCountCurrent = 0;
    const kelpBasePositions: Array<{ x: number; y: number; z: number; scaleY: number; phase: number }> = [];
    let builtTankTier = -1;
    let builtFramelessMode: boolean | null = null;
    let builtAspect = camera.aspect;
    const _abyssBlack = new THREE.Color(0x010409);
    const _daylightSkyTint = new THREE.Color(0x0ea5e9);
    const _bulbNightTint = new THREE.Color(0x070d19);
    const _baseWaterColor = new THREE.Color();
    const _ambientWaterColor = new THREE.Color();
    const _computedBgColor = new THREE.Color();

    function computeUserBackgroundColor(
      tank: { waterTintHex: string; ambientLightColorHex: string },
      bgBrightness: number,
      useSolarDaylight: boolean = true
    ): THREE.Color {
      const b = Math.max(0, Math.min(1, bgBrightness));
      _baseWaterColor.set(tank.waterTintHex);
      _ambientWaterColor.set(tank.ambientLightColorHex);
      if (useSolarDaylight) {
        _baseWaterColor.lerp(_daylightSkyTint, 0.24);
      } else {
        _baseWaterColor.lerp(_bulbNightTint, 0.35);
      }
      if (b <= 0.35) {
        const t = b / 0.35;
        return _computedBgColor.copy(_abyssBlack).lerp(_baseWaterColor, t);
      } else {
        const t = ((b - 0.35) / 0.65) * 0.52;
        return _computedBgColor.copy(_baseWaterColor).lerp(_ambientWaterColor, t);
      }
    }

    function buildTrapezoidalFrustumSurfaceGeometry(
      tank: { width: number; height: number; depth: number },
      aspect: number,
      mode: 'floor' | 'caustic' | 'surface',
      widthScale: number = 1.12
    ): THREE.BufferGeometry {
      const segX = isVeryLowTier ? 6 : 16;
      const segZ = isVeryLowTier ? 4 : 12;
      const cols = segX + 1;
      const rows = segZ + 1;
      const positions = new Float32Array(cols * rows * 3);
      const uvs = new Float32Array(cols * rows * 2);

      const halfD = tank.depth * 0.44;
      const zFront = halfD * 1.12;
      const zBack = -halfD * 1.16;

      let ptr = 0;
      let uvPtr = 0;
      for (let iz = 0; iz <= segZ; iz++) {
        const v = iz / segZ;
        const z = zFront + (zBack - zFront) * v;
        const slice = getTankBoundsAtZ(tank, z, true, aspect);
        const spanW = slice.frustumHalfW * 2 * widthScale;

        for (let ix = 0; ix <= segX; ix++) {
          const u = ix / segX;
          const centeredU = u - 0.5;
          const x = centeredU * spanW;
          const duneRipple =
            mode !== 'surface'
              ? Math.sin(centeredU * Math.PI * 3) * Math.cos(v * Math.PI * 2) * 0.06
              : 0;
          const y =
            mode === 'floor'
              ? slice.floorY + duneRipple
              : mode === 'caustic'
              ? slice.floorY + 0.035 + duneRipple
              : slice.surfaceY;

          positions[ptr++] = x;
          positions[ptr++] = y;
          positions[ptr++] = z;

          uvs[uvPtr++] = u;
          uvs[uvPtr++] = v;
        }
      }

      const indices: number[] = [];
      for (let iz = 0; iz < segZ; iz++) {
        for (let ix = 0; ix < segX; ix++) {
          const a = iz * cols + ix;
          const b = (iz + 1) * cols + ix;
          const c = (iz + 1) * cols + (ix + 1);
          const d = iz * cols + (ix + 1);
          indices.push(a, d, b);
          indices.push(b, d, c);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }

    function buildFrustumEnclosureWallsGeometry(
      tank: { width: number; height: number; depth: number },
      aspect: number
    ): THREE.BufferGeometry {
      const halfD = tank.depth * 0.44;
      const zFront = halfD * 1.12;
      const zBack = -halfD * 1.16;
      const frontSlice = getTankBoundsAtZ(tank, zFront, true, aspect);
      const backSlice = getTankBoundsAtZ(tank, zBack, true, aspect);

      const wf = frontSlice.frustumHalfW * 1.08;
      const wb = backSlice.frustumHalfW * 1.08;
      const yfBot = frontSlice.floorY - 0.25;
      const yfTop = frontSlice.surfaceY + 0.25;
      const ybBot = backSlice.floorY - 0.25;
      const ybTop = backSlice.surfaceY + 0.25;

      const positions = new Float32Array([
        -wf, yfBot, zFront,
        -wb, ybBot, zBack,
        -wb, ybTop, zBack,
        -wf, yfTop, zFront,
        wb, ybBot, zBack,
        wf, yfBot, zFront,
        wf, yfTop, zFront,
        wb, ybTop, zBack,
        -wb, ybBot, zBack,
        wb, ybBot, zBack,
        wb, ybTop, zBack,
        -wb, ybTop, zBack,
      ]);

      const botShade = 0.48;
      const topShade = 1.0;
      const colors = new Float32Array([
        botShade, botShade, botShade,
        botShade, botShade, botShade,
        topShade, topShade, topShade,
        topShade, topShade, topShade,
        botShade, botShade, botShade,
        botShade, botShade, botShade,
        topShade, topShade, topShade,
        topShade, topShade, topShade,
        botShade, botShade, botShade,
        botShade, botShade, botShade,
        topShade, topShade, topShade,
        topShade, topShade, topShade,
      ]);

      const indices = [
        0, 1, 2, 0, 2, 3,
        4, 5, 6, 4, 6, 7,
        8, 9, 10, 8, 10, 11,
      ];

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }

    function buildTankEnvironment(tierIdx: number, isFrameless: boolean) {
      while (habitatGroup.children.length > 0) {
        habitatGroup.remove(habitatGroup.children[0]);
      }
      kelpBasePositions.length = 0;
      activeFrustumWallsMat = null;
      activeWaterSurfaceMat = null;
      bulbLightGroup = null;

      const tank = TANK_TIERS[tierIdx] || TANK_TIERS[0];
      const aspect = camera.aspect || 16 / 9;
      builtAspect = aspect;

      const initBgBrightness =
        ecosystemRef.current.graphicsSettings?.backgroundBrightness ?? 0.22;
      const bgCol = computeUserBackgroundColor(tank, initBgBrightness);

      scene.background = bgCol.clone();
      scene.fog = new THREE.FogExp2(
        bgCol.clone(),
        isFrameless ? tank.fogDensity * 0.92 : tank.fogDensity
      );
      hemiLight.color.set(tank.ambientLightColorHex);

      const W = tank.width;
      const H = tank.height;
      const D = tank.depth;
      const floorY = -H * 0.42;

      sandMap.repeat.set(isFrameless ? 6 : 4, isFrameless ? 5 : 4);
      sandBump.repeat.set(isFrameless ? 9 : 6, isFrameless ? 8 : 6);
      causticMap.repeat.set(isFrameless ? 5 : 3, isFrameless ? 4 : 3);

      const floorMat =
        qualityTier === 'very_low'
          ? new THREE.MeshBasicMaterial({
              color: 0xcbd5e1,
              map: sandMap,
              side: THREE.FrontSide,
            })
          : qualityTier === 'low'
          ? new THREE.MeshLambertMaterial({
              color: 0xffffff,
              map: sandMap,
              side: THREE.FrontSide,
            })
          : new THREE.MeshStandardMaterial({
              color: 0xffffff,
              map: sandMap,
              bumpMap: sandBump,
              bumpScale: 0.08,
              roughness: 0.88,
              metalness: 0.05,
              side: THREE.FrontSide,
            });

      const causticMat = new THREE.MeshBasicMaterial({
        map: causticMap,
        transparent: true,
        opacity: 0.36 * tank.causticsIntensity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
      });

      const surfaceMat = new THREE.MeshBasicMaterial({
        map: causticMap,
        color: 0x7dd3fc,
        transparent: true,
        opacity: isFrameless ? 0.16 : 0.22,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      activeWaterSurfaceMat = surfaceMat;

      if (isFrameless) {
        const frustumFloorGeo = buildTrapezoidalFrustumSurfaceGeometry(tank, aspect, 'floor', 1.14);
        const floorMesh = new THREE.Mesh(frustumFloorGeo, floorMat);
        floorMesh.receiveShadow = qualityTier === 'high';
        habitatGroup.add(floorMesh);

        if (!isVeryLowTier) {
          const frustumCausticGeo = buildTrapezoidalFrustumSurfaceGeometry(tank, aspect, 'caustic', 1.12);
          causticOverlayPlane = new THREE.Mesh(frustumCausticGeo, causticMat);
          habitatGroup.add(causticOverlayPlane);

          const frustumSurfaceGeo = buildTrapezoidalFrustumSurfaceGeometry(tank, aspect, 'surface', 1.14);
          const waterSurfaceMesh = new THREE.Mesh(frustumSurfaceGeo, surfaceMat);
          habitatGroup.add(waterSurfaceMesh);
        }

        if (!isLowOrVeryLow) {
          const frustumWallsGeo = buildFrustumEnclosureWallsGeometry(tank, aspect);
          const frustumWallsMat = new THREE.MeshBasicMaterial({
            color: bgCol.clone(),
            vertexColors: true,
            side: THREE.DoubleSide,
            fog: true,
          });
          activeFrustumWallsMat = frustumWallsMat;
          const frustumWallsMesh = new THREE.Mesh(frustumWallsGeo, frustumWallsMat);
          habitatGroup.add(frustumWallsMesh);
        }
      } else {
        const floorGeo = new THREE.BoxGeometry(W, 0.45, D);
        const floorMesh = new THREE.Mesh(floorGeo, floorMat);
        floorMesh.position.set(0, floorY - 0.225, 0);
        floorMesh.receiveShadow = qualityTier === 'high';
        habitatGroup.add(floorMesh);

        const causticGeo = new THREE.PlaneGeometry(W * 0.98, D * 0.98);
        causticGeo.rotateX(-Math.PI / 2);
        causticOverlayPlane = new THREE.Mesh(causticGeo, causticMat);
        causticOverlayPlane.position.set(0, floorY + 0.025, 0);
        habitatGroup.add(causticOverlayPlane);

        const frameMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
        const trimMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });

        const pillarGeo = new THREE.BoxGeometry(0.24, H + 0.4, 0.24);
        const corners = [
          [-W / 2, 0, -D / 2],
          [W / 2, 0, -D / 2],
          [-W / 2, 0, D / 2],
          [W / 2, 0, D / 2],
        ];
        for (const [cx, cy, cz] of corners) {
          const p = new THREE.Mesh(pillarGeo, frameMat);
          p.position.set(cx, cy, cz);
          habitatGroup.add(p);
        }

        const railXGeo = new THREE.BoxGeometry(W + 0.3, 0.22, 0.26);
        const railZGeo = new THREE.BoxGeometry(0.26, 0.22, D + 0.3);
        for (const ry of [floorY - 0.35, H * 0.46]) {
          const rFront = new THREE.Mesh(railXGeo, frameMat);
          rFront.position.set(0, ry, D / 2);
          const rBack = new THREE.Mesh(railXGeo, frameMat);
          rBack.position.set(0, ry, -D / 2);
          const rLeft = new THREE.Mesh(railZGeo, frameMat);
          rLeft.position.set(-W / 2, ry, 0);
          const rRight = new THREE.Mesh(railZGeo, frameMat);
          rRight.position.set(W / 2, ry, 0);
          habitatGroup.add(rFront, rBack, rLeft, rRight);
        }

        const canopyGroup = new THREE.Group();
        const hoodGeo = new THREE.BoxGeometry(W * 0.72, 0.28, D * 0.32);
        const hoodMesh = new THREE.Mesh(hoodGeo, frameMat);
        const ledStripGeo = new THREE.PlaneGeometry(W * 0.68, D * 0.24);
        ledStripGeo.rotateX(Math.PI / 2);
        const ledMesh = new THREE.Mesh(ledStripGeo, trimMat);
        ledMesh.position.y = -0.145;
        canopyGroup.add(hoodMesh, ledMesh);
        canopyGroup.position.set(0, H * 0.49, 0);
        habitatGroup.add(canopyGroup);

        const glassMat = new THREE.MeshBasicMaterial({
          color: 0xbae6fd,
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
        });
        const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(W, H), glassMat);
        backGlass.position.set(0, 0.02 * H, -D / 2);
        backGlass.renderOrder = 2;
        habitatGroup.add(backGlass);

        const surfaceGeo = new THREE.PlaneGeometry(W * 0.98, D * 0.98);
        surfaceGeo.rotateX(Math.PI / 2);
        const waterSurfaceMesh = new THREE.Mesh(surfaceGeo, surfaceMat);
        waterSurfaceMesh.position.set(0, H * 0.355, 0);
        habitatGroup.add(waterSurfaceMesh);
      }

      // C2. Overhead 3D Aquarium Bulb Light Fixtures & Volumetric Cones (Visible when Bulb Light Mode is active)
      const bulbsContainer = new THREE.Group();
      const centerTopSlice = getTankBoundsAtZ(tank, 0, isFrameless, aspect);
      const topLampY = isFrameless ? centerTopSlice.surfaceY - 0.08 : H * 0.42;
      const spanHalfX = isFrameless ? centerTopSlice.halfW * 0.64 : W * 0.32;

      const housingMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
      const warmBulbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
      const actinicBulbMat = new THREE.MeshBasicMaterial({ color: 0x818cf8 });
      const warmConeMat = new THREE.MeshBasicMaterial({
        color: 0xfde68a,
        transparent: true,
        opacity: 0.11,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const actinicConeMat = new THREE.MeshBasicMaterial({
        color: 0x6366f1,
        transparent: true,
        opacity: 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const lampOffsets = [-spanHalfX, 0, spanHalfX];
      for (let li = 0; li < lampOffsets.length; li++) {
        const lx = lampOffsets[li];
        const isCenterActinic = li === 1;
        const capMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.34, 0.18, isVeryLowTier ? 6 : 12),
          housingMat
        );
        capMesh.position.set(lx, topLampY + 0.12, 0);

        const bulbOrb = new THREE.Mesh(
          new THREE.SphereGeometry(0.18, isVeryLowTier ? 6 : 10, isVeryLowTier ? 6 : 10),
          isCenterActinic ? actinicBulbMat : warmBulbMat
        );
        bulbOrb.position.set(lx, topLampY - 0.02, 0);

        bulbsContainer.add(capMesh, bulbOrb);

        if (!isVeryLowTier) {
          const coneH = H * 0.72;
          const coneGeo = new THREE.ConeGeometry(1.9, coneH, 12, 1, true);
          const coneMesh = new THREE.Mesh(
            coneGeo,
            isCenterActinic ? actinicConeMat : warmConeMat
          );
          coneMesh.position.set(lx, topLampY - coneH * 0.5, 0);
          bulbsContainer.add(coneMesh);
        }
      }
      bulbLightGroup = bulbsContainer;
      habitatGroup.add(bulbsContainer);

      // D. Batched Basalt Rock Arches & Reef Formations
      const rockMat =
        qualityTier === 'very_low'
          ? new THREE.MeshBasicMaterial({ color: 0x1e293b })
          : qualityTier === 'low'
          ? new THREE.MeshLambertMaterial({ color: 0x1e293b })
          : new THREE.MeshStandardMaterial({
              color: 0x1e293b,
              roughness: 0.82,
              metalness: 0.12,
            });
      const mossMat =
        qualityTier === 'very_low'
          ? new THREE.MeshBasicMaterial({ color: 0x0f766e })
          : qualityTier === 'low'
          ? new THREE.MeshLambertMaterial({ color: 0x0f766e })
          : new THREE.MeshStandardMaterial({
              color: 0x0f766e,
              roughness: 0.65,
              metalness: 0.08,
            });

      const dodecaGeo = new THREE.DodecahedronGeometry(1.1, 0);
      const rockSubGeos: THREE.BufferGeometry[] = [];
      const mossSubGeos: THREE.BufferGeometry[] = [];
      const effectiveRockCount = isVeryLowTier
        ? Math.min(2, tank.rockArchCount)
        : tank.rockArchCount;

      for (let r = 0; r < effectiveRockCount; r++) {
        const angle = (r / Math.max(1, effectiveRockCount)) * Math.PI * 1.6 - Math.PI * 0.8;
        const rz = -D * 0.14 + Math.cos(angle * 2) * (D * 0.22);
        const rSlice = getTankBoundsAtZ(tank, rz, isFrameless, aspect);
        const rx = Math.sin(angle) * (rSlice.halfW * 0.72);
        const rotY = (r * 1.1) % Math.PI;

        const addTransformedPart = (
          sx: number,
          sy: number,
          sz: number,
          px: number,
          py: number,
          pz: number,
          targetList: THREE.BufferGeometry[]
        ) => {
          const g = dodecaGeo.clone();
          g.scale(sx, sy, sz);
          g.translate(px, py, pz);
          g.rotateY(rotY);
          g.translate(rx, rSlice.floorY, rz);
          targetList.push(g);
        };

        addTransformedPart(1.2, 1.4, 1.0, -0.9, 0.7, 0, rockSubGeos);
        addTransformedPart(1.1, 1.3, 0.9, 0.9, 0.65, 0.1, rockSubGeos);
        addTransformedPart(1.6, 0.65, 0.85, 0, 1.55, 0.05, rockSubGeos);
        addTransformedPart(1.3, 0.28, 0.7, 0, 1.92, 0.05, mossSubGeos);
      }

      if (rockSubGeos.length > 0) {
        const mergedRocks = mergeGeometries(rockSubGeos, false);
        if (mergedRocks) habitatGroup.add(new THREE.Mesh(mergedRocks, rockMat));
      }
      if (mossSubGeos.length > 0) {
        const mergedMoss = mergeGeometries(mossSubGeos, false);
        if (mergedMoss) habitatGroup.add(new THREE.Mesh(mergedMoss, mossMat));
      }

      // E. Batched Bioluminescent Coral Colonies
      const coralColors = [0xf43f5e, 0xf59e0b, 0xa855f7, 0x06b6d4, 0x10b981];
      const branchGeo = new THREE.CylinderGeometry(0.06, 0.14, 0.9, isVeryLowTier ? 4 : 6);
      branchGeo.translate(0, 0.45, 0);
      const tipGeo = new THREE.SphereGeometry(0.11, isVeryLowTier ? 4 : 6, isVeryLowTier ? 4 : 6);
      tipGeo.translate(0, 0.9, 0);
      const singleStemGeo = mergeGeometries([branchGeo, tipGeo], false) || branchGeo;

      const coralBuckets: THREE.BufferGeometry[][] = coralColors.map(() => []);
      const effectiveCoralCount = isVeryLowTier
        ? Math.min(3, tank.coralCount)
        : tank.coralCount;
      for (let c = 0; c < effectiveCoralCount; c++) {
        const bucketIdx = c % coralColors.length;
        const cz = (((c * 43) % 100) / 100 - 0.5) * (D * 0.74);
        const cSlice = getTankBoundsAtZ(tank, cz, isFrameless, aspect);
        const cx = (((c * 67) % 100) / 100 - 0.5) * (cSlice.halfW * 1.72);

        const branchesPerColony = isVeryLowTier ? 2 : 4;
        for (let b = 0; b < branchesPerColony; b++) {
          const g = singleStemGeo.clone();
          const s = 0.65 + (b % 3) * 0.25;
          g.scale(s, s, s);
          g.rotateX(((b % 2) - 0.5) * 0.28);
          g.rotateZ((b - 1.5) * 0.32);
          g.translate(cx, cSlice.floorY, cz);
          coralBuckets[bucketIdx].push(g);
        }
      }

      for (let idx = 0; idx < coralColors.length; idx++) {
        if (coralBuckets[idx].length === 0) continue;
        const mergedCoral = mergeGeometries(coralBuckets[idx], false);
        if (!mergedCoral) continue;
        const colHex = coralColors[idx];
        const coralMat = isVeryLowTier
          ? new THREE.MeshBasicMaterial({ color: colHex })
          : new THREE.MeshLambertMaterial({
              color: colHex,
              emissive: colHex,
              emissiveIntensity: 0.26,
            });
        habitatGroup.add(new THREE.Mesh(mergedCoral, coralMat));
      }

      // F. Swaying Botanical Kelp Blades (`InstancedMesh`, Distributed inside Frustum)
      kelpCountCurrent = isVeryLowTier ? Math.min(6, tank.kelpCount) : tank.kelpCount;
      const kelpGeo = new THREE.CylinderGeometry(
        0.03,
        0.08,
        2.6,
        isVeryLowTier ? 4 : 6,
        isVeryLowTier ? 1 : 3
      );
      kelpGeo.scale(1.8, 1.0, 0.45);
      kelpGeo.translate(0, 1.3, 0);
      const kelpMat = isVeryLowTier
        ? new THREE.MeshBasicMaterial({ color: 0x10b981 })
        : new THREE.MeshLambertMaterial({ color: 0x10b981 });
      kelpInstancedMesh = new THREE.InstancedMesh(kelpGeo, kelpMat, kelpCountCurrent);
      kelpInstancedMesh.frustumCulled = false;

      for (let k = 0; k < kelpCountCurrent; k++) {
        const kz = -D * 0.36 + (((k * 31) % 100) / 100) * (D * 0.68);
        const kSlice = getTankBoundsAtZ(tank, kz, isFrameless, aspect);
        const kx = (((k * 89) % 100) / 100 - 0.5) * (kSlice.halfW * 1.8);
        const sy = 0.65 + ((k * 19) % 10) * 0.08;
        kelpBasePositions.push({ x: kx, y: kSlice.floorY, z: kz, scaleY: sy, phase: k * 0.7 });
        _vec3A.set(kx, kSlice.floorY, kz);
        _euler.set(0, (k * 0.5) % Math.PI, 0);
        _quat.setFromEuler(_euler);
        _scaleVec.set(1, sy, 1);
        _mat4.compose(_vec3A, _quat, _scaleVec);
        kelpInstancedMesh.setMatrixAt(k, _mat4);
        _color.setHSL(0.42 + (k % 5) * 0.015, 0.75, 0.32 + (k % 3) * 0.05);
        kelpInstancedMesh.setColorAt(k, _color);
      }
      kelpInstancedMesh.instanceMatrix.needsUpdate = true;
      if (kelpInstancedMesh.instanceColor) kelpInstancedMesh.instanceColor.needsUpdate = true;
      habitatGroup.add(kelpInstancedMesh);
    }

    const initialFrameless =
      ecosystemRef.current.graphicsSettings?.framelessTvMode !== undefined
        ? ecosystemRef.current.graphicsSettings.framelessTvMode
        : framelessTvModeRef.current;
    builtTankTier = activeTankTierRef.current;
    builtFramelessMode = initialFrameless;
    buildTankEnvironment(builtTankTier, builtFramelessMode);

    // 5. Rising Oxygen Bubble Stream (`InstancedMesh` Pool — Zero Allocation)
    const BUBBLE_COUNT = isVeryLowTier ? 8 : qualityTier === 'low' ? 18 : 42;
    const bubbleGeo = new THREE.SphereGeometry(0.065, isVeryLowTier ? 5 : 8, isVeryLowTier ? 5 : 8);
    const bubbleMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    });
    const bubbleInstanced = new THREE.InstancedMesh(bubbleGeo, bubbleMat, BUBBLE_COUNT);
    bubbleInstanced.frustumCulled = false;
    scene.add(bubbleInstanced);

    const initTank = TANK_TIERS[builtTankTier] || TANK_TIERS[0];
    const bubbleStates = new Float32Array(BUBBLE_COUNT * 4);
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const bz = (Math.random() - 0.5) * (initTank.depth * 0.74);
      const bSlice = getTankBoundsAtZ(initTank, bz, builtFramelessMode !== false, camera.aspect);
      bubbleStates[i * 4 + 0] = (Math.random() - 0.5) * (bSlice.halfW * 1.7);
      bubbleStates[i * 4 + 1] = bSlice.floorY + Math.random() * (bSlice.surfaceY - bSlice.floorY);
      bubbleStates[i * 4 + 2] = bz;
      bubbleStates[i * 4 + 3] = 0.65 + Math.random() * 0.9;
    }

    // 6. Food Pellet `InstancedMesh` Pool (Pre-warmed with MeshBasicMaterial so dropping food never triggers lazy shader compilation)
    const MAX_PELLETS = 64;
    const pelletGeo = new THREE.SphereGeometry(0.11, isVeryLowTier ? 5 : 8, isVeryLowTier ? 5 : 8);
    const pelletMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
    const pelletInstanced = new THREE.InstancedMesh(pelletGeo, pelletMat, MAX_PELLETS);
    pelletInstanced.frustumCulled = false;
    pelletInstanced.visible = true;
    pelletInstanced.count = 1;
    _vec3A.set(0, -999, 0);
    _quat.identity();
    _scaleVec.set(0.0001, 0.0001, 0.0001);
    _mat4.compose(_vec3A, _quat, _scaleVec);
    pelletInstanced.setMatrixAt(0, _mat4);
    pelletInstanced.instanceMatrix.needsUpdate = true;
    scene.add(pelletInstanced);

    // 7. Caretaker 3D Cursor Ring
    const cursorGroup = new THREE.Group();
    const cursorRingMesh = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.035, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.78 })
    );
    cursorRingMesh.rotation.x = Math.PI / 2;
    const cursorCenterPip = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.1, 0),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b })
    );
    cursorGroup.add(cursorRingMesh, cursorCenterPip);
    scene.add(cursorGroup);

    // 8. Individual Sculpted 3D Fish Mesh Pool keyed by `fishId`
    const fishRigs = new Map<string, FishMeshRig>();
    const fishContainer = new THREE.Group();
    scene.add(fishContainer);

    renderer.compile(scene, camera);

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = Math.max(1, container.clientHeight || window.innerHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // 9. Native 60Hz+ Render & Simulation Loop (No artificial 80ms sleep!)
    let frameId = 0;
    let isUnmounted = false;
    let lastTimeMs = performance.now();
    let elapsedTotal = 0;
    let lastReportedPolyQuality: FishPolygonQuality | null = null;
    let lastReportedFishCount = -1;
    let lastSyncedPelletCount = -1;
    let fpsFrameCount = 0;
    let lastFpsReportMs = performance.now();

    function tick() {
      if (isUnmounted) return;
      const nowMs = performance.now();
      const rawDt = Math.min(0.05, Math.max(0.001, (nowMs - lastTimeMs) / 1000));
      lastTimeMs = nowMs;

      // Measure & report real-time FPS every ~500ms when listener is provided
      fpsFrameCount++;
      if (nowMs - lastFpsReportMs >= 500) {
        const measuredFps = Math.max(
          1,
          Math.min(240, Math.round((fpsFrameCount * 1000) / (nowMs - lastFpsReportMs)))
        );
        fpsFrameCount = 0;
        lastFpsReportMs = nowMs;
        if (onFpsUpdateRef.current) {
          onFpsUpdateRef.current(measuredFps);
        }
      }

      if (!isPausedRef.current) {
        elapsedTotal += rawDt;
        onTickRef.current(rawDt);
      }

      const eco = ecosystemRef.current;
      const targetFrameless =
        eco.graphicsSettings?.framelessTvMode !== undefined
          ? eco.graphicsSettings.framelessTvMode
          : framelessTvModeRef.current;

      if (
        builtTankTier !== activeTankTierRef.current ||
        builtFramelessMode !== targetFrameless ||
        (targetFrameless && Math.abs(camera.aspect - builtAspect) > 0.05)
      ) {
        builtTankTier = activeTankTierRef.current;
        builtFramelessMode = targetFrameless;
        buildTankEnvironment(builtTankTier, builtFramelessMode);
      }

      const tank = TANK_TIERS[builtTankTier] || TANK_TIERS[0];
      const isFramelessNow = builtFramelessMode !== false;
      const targetPolyQuality =
        eco.graphicsSettings?.fishPolygonQuality || fishPolygonQualityRef.current || 'high';

      // Determine Daylight vs Bulb Light mode:
      // - When Daylight Mode is ON: use natural solar Daylight during daytime (06:00 - 18:30), and automatically switch to Bulb Lights at night!
      // - When Daylight Mode is OFF: always use warm aquarium Bulb Lights.
      const daylightModeEnabled = eco.graphicsSettings?.daylightMode !== false;
      const timeOverride = eco.graphicsSettings?.timeOfDayOverride || 'auto';
      const nowClock = new Date();
      const currentHourFloat = nowClock.getHours() + nowClock.getMinutes() / 60;
      const isDaytimeHours =
        timeOverride === 'day'
          ? true
          : timeOverride === 'night'
          ? false
          : currentHourFloat >= 6.0 && currentHourFloat < 18.5;
      const useSolarDaylight = daylightModeEnabled && isDaytimeHours;

      if (bulbLightGroup) {
        bulbLightGroup.visible = !useSolarDaylight;
      }

      // Apply user lighting & back-of-tank background brightness settings in real time
      const userLightIntensity = Math.max(
        0.15,
        Math.min(1.8, eco.graphicsSettings?.lightIntensity ?? 0.95)
      );
      const userBgBrightness = Math.max(
        0.0,
        Math.min(1.0, eco.graphicsSettings?.backgroundBrightness ?? 0.22)
      );
      const liveBgCol = computeUserBackgroundColor(
        tank,
        useSolarDaylight ? Math.min(1.0, userBgBrightness * 1.12 + 0.03) : userBgBrightness * 0.85,
        useSolarDaylight
      );
      if (scene.background instanceof THREE.Color) {
        scene.background.copy(liveBgCol);
      } else {
        scene.background = liveBgCol.clone();
      }
      if (scene.fog instanceof THREE.FogExp2) {
        scene.fog.color.copy(liveBgCol);
      }
      if (activeFrustumWallsMat) {
        activeFrustumWallsMat.color.copy(liveBgCol);
      }
      if (activeWaterSurfaceMat) {
        activeWaterSurfaceMat.color.setHex(useSolarDaylight ? 0xbae6fd : 0xfde68a);
        activeWaterSurfaceMat.opacity =
          (isFramelessNow ? 0.14 : 0.2) * Math.min(1.25, userLightIntensity);
      }

      if (useSolarDaylight) {
        hemiLight.color.setHex(0xbae6fd);
        hemiLight.groundColor.setHex(0x0c4a6e);
        hemiLight.intensity = 1.22 * userLightIntensity;
        if (!isVeryLowTier) {
          sunKeyLight.color.setHex(0xfffbeb);
          sunKeyLight.intensity = 1.85 * userLightIntensity;
          rimLight.color.setHex(0x38bdf8);
          rimLight.intensity = 0.88 * userLightIntensity;
          frontFillLight.color.setHex(0xe0f2fe);
          frontFillLight.intensity = 0.62 * userLightIntensity;
          renderer.toneMappingExposure = 0.92 + 0.28 * Math.min(1.4, userLightIntensity);
        }
      } else {
        // Bulb Light Mode (Nighttime or when Daylight is switched OFF)
        hemiLight.color.setHex(0xfde68a);
        hemiLight.groundColor.setHex(0x050b16);
        hemiLight.intensity = 0.92 * userLightIntensity;
        if (!isVeryLowTier) {
          sunKeyLight.color.setHex(0xffb74d);
          sunKeyLight.intensity = 1.48 * userLightIntensity;
          rimLight.color.setHex(0x818cf8);
          rimLight.intensity = 0.95 * userLightIntensity;
          frontFillLight.color.setHex(0xfef08a);
          frontFillLight.intensity = 0.48 * userLightIntensity;
          renderer.toneMappingExposure = 0.8 + 0.25 * Math.min(1.4, userLightIntensity);
        }
      }

      // Animate caustics & swaying kelp
      const showCaustics = !isVeryLowTier && eco.graphicsSettings?.showCaustics !== false;
      if (causticOverlayPlane) {
        causticOverlayPlane.visible = showCaustics;
        if (showCaustics) {
          causticMap.offset.x = (elapsedTotal * 0.03) % 1;
          causticMap.offset.y = (elapsedTotal * 0.022) % 1;
          const cMat = causticOverlayPlane.material as THREE.MeshBasicMaterial;
          if (cMat) {
            cMat.color.setHex(useSolarDaylight ? 0xffffff : 0xfde68a);
            cMat.opacity = 0.32 * tank.causticsIntensity * Math.min(1.3, userLightIntensity);
          }
        }
      }

      if (kelpInstancedMesh && !isVeryLowTier) {
        for (let k = 0; k < kelpCountCurrent; k++) {
          const kb = kelpBasePositions[k];
          _vec3A.set(kb.x, kb.y, kb.z);
          const sway = Math.sin(elapsedTotal * 1.4 + kb.phase) * 0.14;
          _euler.set(sway * 0.5, (k * 0.5) % Math.PI, sway);
          _quat.setFromEuler(_euler);
          _scaleVec.set(1, kb.scaleY, 1);
          _mat4.compose(_vec3A, _quat, _scaleVec);
          kelpInstancedMesh.setMatrixAt(k, _mat4);
        }
        kelpInstancedMesh.instanceMatrix.needsUpdate = true;
      }

      // Update rising oxygen bubbles inside frustum bounds
      const showParticles = !isVeryLowTier && eco.graphicsSettings?.showParticles !== false;
      bubbleInstanced.visible = showParticles;
      if (showParticles) {
        for (let i = 0; i < BUBBLE_COUNT; i++) {
          const base = i * 4;
          const bSlice = getTankBoundsAtZ(tank, bubbleStates[base + 2], isFramelessNow, camera.aspect);
          if (!isPausedRef.current) {
            bubbleStates[base + 1] += bubbleStates[base + 3] * rawDt;
            if (bubbleStates[base + 1] > bSlice.surfaceY) {
              const newBz = (Math.random() - 0.5) * (tank.depth * 0.74);
              const newSlice = getTankBoundsAtZ(tank, newBz, isFramelessNow, camera.aspect);
              bubbleStates[base + 2] = newBz;
              bubbleStates[base + 1] = newSlice.floorY;
              bubbleStates[base + 0] = (Math.random() - 0.5) * (newSlice.halfW * 1.72);
            }
          }
          const wobble = Math.sin(elapsedTotal * 3 + i) * 0.08;
          _vec3A.set(
            bubbleStates[base + 0] + wobble,
            bubbleStates[base + 1],
            bubbleStates[base + 2]
          );
          _quat.identity();
          const bScale = 0.7 + (i % 4) * 0.25;
          _scaleVec.set(bScale, bScale, bScale);
          _mat4.compose(_vec3A, _quat, _scaleVec);
          bubbleInstanced.setMatrixAt(i, _mat4);
        }
        bubbleInstanced.instanceMatrix.needsUpdate = true;
      }

      // Sync Food Pellets (Always keep pelletInstanced.visible = true so WebGL never lazily compiles shaders on first drop)
      const pellets = pelletsRef.current;
      const pCount = Math.min(MAX_PELLETS, pellets.length);
      if (pCount > 0) {
        pelletInstanced.count = pCount;
        for (let i = 0; i < pCount; i++) {
          const p = pellets[i];
          _vec3A.set(p.x, p.y, p.z);
          _quat.identity();
          _scaleVec.set(1, 1, 1);
          _mat4.compose(_vec3A, _quat, _scaleVec);
          pelletInstanced.setMatrixAt(i, _mat4);
        }
        pelletInstanced.instanceMatrix.needsUpdate = true;
        lastSyncedPelletCount = pCount;
      } else if (lastSyncedPelletCount !== 0) {
        pelletInstanced.count = 1;
        _vec3A.set(0, -999, 0);
        _quat.identity();
        _scaleVec.set(0.0001, 0.0001, 0.0001);
        _mat4.compose(_vec3A, _quat, _scaleVec);
        pelletInstanced.setMatrixAt(0, _mat4);
        pelletInstanced.instanceMatrix.needsUpdate = true;
        lastSyncedPelletCount = 0;
      }

      cursorGroup.visible = false;

      // Sync Individual Sculpted 3D Fish Rigs (Both Live Swimming Fishes & Dead / Greyed-Out Fishes)
      const activeIds = new Set<string>();
      let sampleTriCount = 0;

      for (let i = 0; i < eco.fishes.length; i++) {
        const fish = eco.fishes[i];
        activeIds.add(fish.lineage.fishId);

        let rig = fishRigs.get(fish.lineage.fishId);
        const targetMatTier: EnvironmentQualityTier = qualityTier;
        // Rebuild rig if newly spawned, polygon quality changed, material tier changed, OR admin replaced the fish's species!
        if (
          rig &&
          (rig.polygonQuality !== targetPolyQuality ||
            rig.materialTier !== targetMatTier ||
            rig.speciesId !== fish.lineage.speciesId)
        ) {
          fishContainer.remove(rig.group);
          fishContainer.remove(rig.shadowDisc);
          rig.bodyMat.dispose();
          rig.finMat.dispose();
          fishRigs.delete(fish.lineage.fishId);
          rig = undefined;
        }

        if (!rig) {
          const sp =
            eco.speciesList.find((s) => s.id === fish.lineage.speciesId) ||
            DEFAULT_SPECIES_LIST[0];
          rig = createSculpted3DFishRig(
            sp.id,
            sp.primaryColorHex,
            sp.secondaryColorHex,
            sp.accentColorHex,
            sp.bodyStyle,
            targetPolyQuality,
            targetMatTier
          );
          _color.set('#ffffff');
          _color.offsetHSL(fish.genetics.primaryHueShift / 360, 0, 0);
          rig.bodyMat.color.copy(_color);

          fishContainer.add(rig.group);
          fishContainer.add(rig.shadowDisc);
          fishRigs.set(fish.lineage.fishId, rig);
        }

        sampleTriCount = rig.triangleCount;
        const fishSlice = getTankBoundsAtZ(tank, fish.state.z, isFramelessNow, camera.aspect);
        const scale =
          Math.max(0.55, fish.state.growthProgress) * fish.genetics.bodyScaleGene * 1.18;

        if (!fish.lineage.alive) {
          // DEAD FISH VISUAL: Float belly-up (roll = PI) near the top water surface with PURE MONOCHROME GREYED-OUT COLORATION
          const targetDeadY = fishSlice.surfaceY - 0.26 + Math.sin(elapsedTotal * 1.1 + i) * 0.03;
          fish.state.y += (targetDeadY - fish.state.y) * Math.min(1, rawDt * 2.2);
          fish.state.vx *= 0.92;
          fish.state.vz *= 0.92;

          rig.group.position.set(fish.state.x, fish.state.y, fish.state.z);
          rig.group.scale.set(scale, scale, scale);
          rig.group.rotation.set(0.06, fish.state.yaw, Math.PI, 'YXZ');

          if (!rig.isDeadVisualApplied) {
            const { deadSkinMap, deadFinMap } = getOrCreateDeadFishGreyscaleTextures();
            rig.bodyMat.map = deadSkinMap;
            rig.bodyMat.color.setHex(0x9ca3af);
            rig.bodyMat.needsUpdate = true;

            rig.finMat.map = deadFinMap;
            rig.finMat.color.setHex(0x94a3b8);
            if ('emissive' in rig.finMat) {
              rig.finMat.emissive.setHex(0x334155);
              rig.finMat.emissiveIntensity = 0.0;
            }
            rig.finMat.needsUpdate = true;
            rig.isDeadVisualApplied = true;
          }

          // Zero out GPU spine wave and fin rotations (motionless dead fish)
          rig.spineUniforms.uSwimAmp.value = 0.0;
          rig.spineUniforms.uTailPhase.value = 0.0;
          rig.tailPeduncleGroup.rotation.y = 0;
          rig.tailBladeMesh.rotation.y = 0;
          rig.pectoralLeftGroup.rotation.y = 0.15;
          rig.pectoralLeftGroup.rotation.z = 0;
          rig.pectoralRightGroup.rotation.y = -0.15;
          rig.pectoralRightGroup.rotation.z = 0;

          rig.selectionRing.visible = selectedFishIdRef.current === fish.lineage.fishId;
          rig.shadowDisc.position.set(fish.state.x, fishSlice.floorY + 0.04, fish.state.z);
          rig.shadowDisc.scale.set(scale * 0.65, scale * 0.65, scale * 0.65);
          continue;
        }

        // Restore live species coloration if a fish was revived
        if (rig.isDeadVisualApplied) {
          rig.bodyMat.map = rig.liveSkinMap;
          _color.set('#ffffff');
          _color.offsetHSL(fish.genetics.primaryHueShift / 360, 0, 0);
          rig.bodyMat.color.copy(_color);
          rig.bodyMat.needsUpdate = true;

          rig.finMat.map = rig.liveFinMap;
          rig.finMat.color.copy(rig.liveAccentColor);
          if ('emissive' in rig.finMat) {
            rig.finMat.emissive.copy(rig.liveAccentColor);
          }
          rig.finMat.needsUpdate = true;
          rig.isDeadVisualApplied = false;
        }

        rig.group.position.set(fish.state.x, fish.state.y, fish.state.z);
        rig.group.scale.set(scale, scale, scale);
        rig.group.rotation.set(
          fish.state.pitch,
          fish.state.yaw,
          fish.state.roll || 0,
          'YXZ'
        );

        // 1. GPU Vertex Shader S-wave biomechanical spine undulation (zero CPU vertex loop!)
        rig.spineUniforms.uTailPhase.value = fish.state.tailPhase;
        rig.spineUniforms.uSwimAmp.value = 0.085 * fish.genetics.finAspectGene;

        // 2. Articulated 2-stage caudal tail fan
        const wag = Math.sin(fish.state.tailPhase) * 0.44 * fish.genetics.finAspectGene;
        const lagWag = Math.sin(fish.state.tailPhase - 0.65) * 0.28 * fish.genetics.finAspectGene;
        rig.tailPeduncleGroup.rotation.y = wag;
        rig.tailBladeMesh.rotation.y = lagWag;

        // 3. 3D Pectoral Wing Fins figure-8 sculling
        const scull = Math.cos(fish.state.tailPhase * 0.85);
        const feather = Math.sin(fish.state.tailPhase * 0.85);
        rig.pectoralLeftGroup.rotation.y = scull * 0.36;
        rig.pectoralLeftGroup.rotation.z = feather * 0.18;
        rig.pectoralRightGroup.rotation.y = -scull * 0.36;
        rig.pectoralRightGroup.rotation.z = -feather * 0.18;

        if ('emissiveIntensity' in rig.finMat) {
          rig.finMat.emissiveIntensity =
            0.24 +
            Math.sin(elapsedTotal * 3 + i) * 0.16 * fish.genetics.luminancePulseGene;
        }

        rig.selectionRing.visible = selectedFishIdRef.current === fish.lineage.fishId;

        rig.shadowDisc.position.set(fish.state.x, fishSlice.floorY + 0.04, fish.state.z);
        const heightAboveFloor = Math.max(0.1, fish.state.y - fishSlice.floorY);
        const shadowScale = Math.max(0.3, scale * (1.1 - heightAboveFloor * 0.05));
        rig.shadowDisc.scale.set(shadowScale, shadowScale, shadowScale);
      }

      // Dispose rigs of removed fishes (keep cached geometries intact)
      if (fishRigs.size !== activeIds.size) {
        for (const [id, rig] of fishRigs.entries()) {
          if (!activeIds.has(id)) {
            fishContainer.remove(rig.group);
            fishContainer.remove(rig.shadowDisc);
            rig.bodyMat.dispose();
            rig.finMat.dispose();
            fishRigs.delete(id);
          }
        }
      }

      if (
        onPolyStatsRef.current &&
        (lastReportedPolyQuality !== targetPolyQuality || lastReportedFishCount !== activeIds.size)
      ) {
        lastReportedPolyQuality = targetPolyQuality;
        lastReportedFishCount = activeIds.size;
        onPolyStatsRef.current({
          trianglesPerFish: sampleTriCount,
          totalFishTriangles: sampleTriCount * activeIds.size,
        });
      }

      // 10. Frustum-Fitted Full-Screen TV Camera vs Framed Tank View
      const dampFactor = 1 - Math.exp(-3.8 * rawDt);
      const orb = cameraOrbitRef.current;
      const centerSlice = getTankBoundsAtZ(tank, 0, isFramelessNow, camera.aspect);

      if (isFramelessNow) {
        const swayAngle = Math.sin(elapsedTotal * 0.05) * 0.032 + orb.yaw * 0.2;
        const baseDist = centerSlice.camZ * orb.zoom;
        _vec3CamTarget.set(
          Math.sin(swayAngle) * baseDist,
          Math.sin(elapsedTotal * 0.07) * 0.12 + orb.pitch * 1.8,
          Math.cos(swayAngle) * baseDist
        );
        _vec3LookTarget.set(
          Math.cos(elapsedTotal * 0.04) * 0.14,
          Math.sin(elapsedTotal * 0.06) * 0.08,
          0
        );
      } else {
        const swayAngle = Math.sin(elapsedTotal * 0.07) * 0.26 + orb.yaw * 0.5;
        const baseDist = (tank.width * 0.68 + 4.8) * orb.zoom;
        _vec3CamTarget.set(
          Math.sin(swayAngle) * baseDist,
          Math.sin(elapsedTotal * 0.09) * 0.65 + 0.9 + orb.pitch * 3.0,
          Math.cos(swayAngle) * baseDist
        );
        _vec3LookTarget.set(
          Math.cos(elapsedTotal * 0.05) * (tank.width * 0.06),
          Math.sin(elapsedTotal * 0.08) * 0.25,
          0
        );
      }

      camera.position.lerp(_vec3CamTarget, dampFactor);
      camera.lookAt(_vec3LookTarget);

      renderer.render(scene, camera);
      frameId = requestAnimationFrame(tick);
    }

    tick();

    return () => {
      isUnmounted = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
      sandMap.dispose();
      sandBump.dispose();
      causticMap.dispose();
      bubbleGeo.dispose();
      bubbleMat.dispose();
      pelletGeo.dispose();
      pelletMat.dispose();
      renderer.dispose();
    };
  }, [qualityTier]);

  return (
    <div
      ref={mountRef}
      data-testid="aquarium-3d-canvas"
      className="fixed inset-0 w-full h-full overflow-hidden bg-[#040b14]"
    />
  );
};
