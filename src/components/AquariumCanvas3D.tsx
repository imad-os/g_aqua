import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DEFAULT_SPECIES_LIST, TANK_TIERS } from '../engine/defaults';
import { getTankBoundsAtZ } from '../engine/simulation';
import {
  FishEntity,
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
  qualityTier: 'low' | 'mid' | 'high';
  fishPolygonQuality?: FishPolygonQuality;
  framelessTvMode?: boolean;
  activeTankTier: number;
  isPaused: boolean;
  onTickSimulation: (dt: number) => void;
  onSelectFish?: (fishId: string) => void;
  onPolygonStatsUpdate?: (stats: { trianglesPerFish: number; totalFishTriangles: number }) => void;
}

interface FishMeshRig {
  group: THREE.Group;
  bodyGeo: THREE.BufferGeometry;
  basePositions: Float32Array;
  uCoords: Float32Array;
  bodyMat: THREE.MeshPhysicalMaterial;
  finMat: THREE.MeshPhysicalMaterial;
  tailPeduncleGroup: THREE.Group;
  tailBladeMesh: THREE.Mesh;
  pectoralLeftGroup: THREE.Group;
  pectoralRightGroup: THREE.Group;
  pelvicLeftMesh: THREE.Mesh;
  pelvicRightMesh: THREE.Mesh;
  dorsalFinMesh: THREE.Mesh;
  analFinMesh: THREE.Mesh;
  gillLeftMesh: THREE.Mesh;
  gillRightMesh: THREE.Mesh;
  lureMesh: THREE.Mesh;
  selectionRing: THREE.Mesh;
  shadowDisc: THREE.Mesh;
  speciesId: string;
  polygonQuality: FishPolygonQuality;
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
    case 'low':
      return {
        lengthRings: 16,
        radialSegments: 12,
        finSegmentsU: 6,
        finSegmentsV: 6,
        eyeSegments: 8,
        label: 'Low (~520 Polygons/Fish)',
      };
    case 'medium':
      return {
        lengthRings: 28,
        radialSegments: 20,
        finSegmentsU: 10,
        finSegmentsV: 10,
        eyeSegments: 12,
        label: 'Medium (~1,640 Polygons/Fish)',
      };
    case 'ultra':
      return {
        lengthRings: 60,
        radialSegments: 44,
        finSegmentsU: 20,
        finSegmentsV: 18,
        eyeSegments: 20,
        label: 'Ultra (~8,200 Polygons/Fish)',
      };
    case 'high':
    default:
      return {
        lengthRings: 42,
        radialSegments: 30,
        finSegmentsU: 14,
        finSegmentsV: 14,
        eyeSegments: 16,
        label: 'High (~3,850 Polygons/Fish)',
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
  for (let i = 0; i < 1800; i++) {
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
  skinCanvas.width = 512;
  skinCanvas.height = 256;
  const ctx = skinCanvas.getContext('2d')!;

  // Vertical countershading gradient (v=0 top dorsal -> v=0.5 flank -> v=1.0 ventral belly)
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, secondaryHex);
  grad.addColorStop(0.28, primaryHex);
  grad.addColorStop(0.48, accentHex);
  grad.addColorStop(0.62, primaryHex);
  grad.addColorStop(0.88, '#e2e8f0');
  grad.addColorStop(1.0, '#cbd5e1');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Glowing lateral line stripe from gill to tail
  const stripeGrad = ctx.createLinearGradient(80, 0, 490, 0);
  stripeGrad.addColorStop(0, 'rgba(255,255,255,0)');
  stripeGrad.addColorStop(0.2, accentHex);
  stripeGrad.addColorStop(0.85, accentHex);
  stripeGrad.addColorStop(1.0, secondaryHex);
  ctx.fillStyle = stripeGrad;
  ctx.fillRect(70, 108, 420, 34);

  // Overlapping fish scales pattern
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
  ctx.lineWidth = 1.4;
  const scaleCols = 28;
  const scaleRows = 14;
  const colW = 512 / scaleCols;
  const rowH = 256 / scaleRows;
  for (let r = 0; r < scaleRows; r++) {
    for (let c = 4; c < scaleCols; c++) {
      const cx = c * colW + (r % 2 === 0 ? 0 : colW * 0.5);
      const cy = r * rowH + rowH * 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, rowH * 0.54, -Math.PI * 0.42, Math.PI * 0.42);
      ctx.stroke();
    }
  }

  // Gill operculum contour curve near u = 0.26
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(118, 128, 76, -Math.PI * 0.36, Math.PI * 0.36);
  ctx.stroke();

  const skinMap = new THREE.CanvasTexture(skinCanvas);
  skinMap.colorSpace = THREE.SRGBColorSpace;
  skinMap.wrapS = THREE.ClampToEdgeWrapping;
  skinMap.wrapT = THREE.RepeatWrapping;

  // 2. Scale Bump Map (Linear grayscale)
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 256;
  bumpCanvas.height = 128;
  const bCtx = bumpCanvas.getContext('2d')!;
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, 256, 128);
  bCtx.strokeStyle = '#d4d4d4';
  bCtx.lineWidth = 1.5;
  for (let r = 0; r < 12; r++) {
    for (let c = 3; c < 22; c++) {
      const cx = c * 11.5 + (r % 2) * 5.75;
      const cy = r * 10.6 + 5;
      bCtx.beginPath();
      bCtx.arc(cx, cy, 5.5, -Math.PI * 0.4, Math.PI * 0.4);
      bCtx.stroke();
    }
  }
  const skinBump = new THREE.CanvasTexture(bumpCanvas);
  skinBump.wrapS = THREE.ClampToEdgeWrapping;
  skinBump.wrapT = THREE.RepeatWrapping;

  // 3. Fin Ray Striation Texture (for 3D Dorsal, Pectoral, Pelvic, Anal, and Caudal Tail fans)
  const finCanvas = document.createElement('canvas');
  finCanvas.width = 256;
  finCanvas.height = 256;
  const fCtx = finCanvas.getContext('2d')!;
  const finGrad = fCtx.createLinearGradient(0, 0, 256, 0);
  finGrad.addColorStop(0.0, secondaryHex);
  finGrad.addColorStop(0.45, primaryHex);
  finGrad.addColorStop(0.85, accentHex);
  finGrad.addColorStop(1.0, '#ffffff');
  fCtx.fillStyle = finGrad;
  fCtx.fillRect(0, 0, 256, 256);

  // Delicate radial fin rays
  fCtx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  fCtx.lineWidth = 2.0;
  for (let i = 0; i < 22; i++) {
    const y = (i / 21) * 256;
    fCtx.beginPath();
    fCtx.moveTo(0, 128 + (y - 128) * 0.35);
    fCtx.lineTo(256, y);
    fCtx.stroke();
  }
  const finMap = new THREE.CanvasTexture(finCanvas);
  finMap.colorSpace = THREE.SRGBColorSpace;

  const result = { skinMap, skinBump, finMap };
  _skinTextureCache.set(key, result);
  return result;
}

/**
 * Builds a true 3D anatomically lofted fish body BufferGeometry (+Z is forward snout, -Z is tail peduncle,
 * +Y is dorsal ridge, -Y is ventral belly, +X / -X are left / right sculpted flanks and gill plates).
 */
function buildSculptedFishBodyGeometry(
  bodyStyle: string,
  lengthRings: number,
  radialSegments: number
): { geometry: THREE.BufferGeometry; basePositions: Float32Array; uCoords: Float32Array } {
  const numVerts = (lengthRings + 1) * (radialSegments + 1);
  const positions = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);
  const uCoords = new Float32Array(numVerts);

  const totalLength = 1.32; // z from +0.66 (snout tip) down to -0.66 (peduncle end)
  const noseZ = 0.66;

  // Species silhouette multipliers
  const isAngel = bodyStyle === 'angel_disc';
  const isLantern = bodyStyle === 'biolum_Latern';
  const maxHalfHeight = isAngel ? 0.56 : isLantern ? 0.38 : 0.32;
  const maxHalfWidth = isAngel ? 0.22 : isLantern ? 0.27 : 0.24;

  let vIdx = 0;
  for (let i = 0; i <= lengthRings; i++) {
    const u = i / lengthRings; // 0 = snout tip, 1 = tail peduncle base
    const z = noseZ - u * totalLength;

    // Longitudinal anatomical profile for dorsal height (+Y), ventral depth (-Y), and lateral width (±X)
    let heightEnvelope: number;
    let widthEnvelope: number;
    let verticalCenterOffset = 0;

    if (u < 0.04) {
      // Rounded 3D mouth/snout tip
      const t = u / 0.04;
      const sphereCap = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
      heightEnvelope = sphereCap * 0.22;
      widthEnvelope = sphereCap * 0.24;
      verticalCenterOffset = -0.02 * (1 - t);
    } else if (u < 0.72) {
      // Smooth fullness from head (u=0.04) through gill operculum (u=0.26) and trunk (u=0.42)
      const norm = (u - 0.04) / 0.68;
      const arch = Math.sin(Math.pow(norm, 0.72) * Math.PI);
      heightEnvelope = 0.22 + 0.78 * arch;
      widthEnvelope = 0.24 + 0.76 * Math.sin(Math.pow(norm, 0.65) * Math.PI);

      // Sculpted 3D gill cover (operculum) flare at u ≈ 0.25..0.31
      const gillDist = Math.abs(u - 0.27);
      if (gillDist < 0.06) {
        const gillFlare = Math.cos((gillDist / 0.06) * (Math.PI / 2));
        widthEnvelope += 0.11 * gillFlare;
      }
      verticalCenterOffset = isAngel ? 0.04 * arch : 0.02 * arch;
    } else {
      // Muscular caudal peduncle tapering toward the tail joint (u = 0.72..1.0)
      const tailNorm = (u - 0.72) / 0.28;
      const smoothStep = 1 - tailNorm * tailNorm * (3 - 2 * tailNorm);
      heightEnvelope = 0.22 + 0.22 * smoothStep;
      widthEnvelope = 0.16 + 0.18 * smoothStep;
      // Flare slightly at u=0.95..1.0 where caudal tail fin rays emerge
      if (u > 0.92) {
        heightEnvelope += ((u - 0.92) / 0.08) * 0.08;
      }
    }

    const halfH = maxHalfHeight * heightEnvelope;
    const halfW = maxHalfWidth * widthEnvelope;

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const theta = v * Math.PI * 2; // 0 = top dorsal (+Y), PI/2 = right flank (+X), PI = ventral belly (-Y)

      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // Organic fish cross-section: slightly sharper dorsal keel, plumper mid-flanks, rounded belly
      const dorsalSharpness = cosT > 0 ? 1.0 - 0.12 * Math.pow(sinT, 2) : 1.0 + 0.08 * Math.pow(sinT, 2);
      let x = sinT * halfW * dorsalSharpness;
      let y = cosT * halfH + verticalCenterOffset;

      // Subtle 3D mouth lip groove at snout front (u < 0.08)
      if (u > 0.01 && u < 0.07 && Math.abs(cosT + 0.15) < 0.25) {
        x *= 0.92;
      }

      positions[vIdx * 3 + 0] = x;
      positions[vIdx * 3 + 1] = y;
      positions[vIdx * 3 + 2] = z;

      // Map U along spine (0..1) and V symmetrically from dorsal top (0) to ventral belly (1)
      const symV = Math.abs(v - 0.5) * 2;
      uvs[vIdx * 2 + 0] = u;
      uvs[vIdx * 2 + 1] = 1 - symV;
      uCoords[vIdx] = u;

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

  return {
    geometry,
    basePositions: new Float32Array(positions),
    uCoords,
  };
}

/**
 * Builds a 3D volumetric double-sided fin fan (used for Caudal Tail, Dorsal Fin, Anal Fin,
 * and Paired Pectoral/Pelvic Fins) with real thickness and 3D fin-ray corrugations so it NEVER
 * looks like a flat plane or disappears when turning.
 */
function build3DVolumetricFinGeometry(
  kind: 'caudal' | 'dorsal' | 'pectoral' | 'pelvic' | 'anal',
  bodyStyle: string,
  segU: number,
  segV: number
): THREE.BufferGeometry {
  // Build both left (+X) and right (-X) faces of a thick 3D foil with corrugated fin rays
  const cols = segU + 1;
  const rows = segV + 1;
  const sideVerts = cols * rows;
  const positions = new Float32Array(sideVerts * 2 * 3);
  const uvs = new Float32Array(sideVerts * 2 * 2);

  const isAngel = bodyStyle === 'angel_disc';

  function evalFinPoint(u: number, v: number, sideSign: 1 | -1): [number, number, number] {
    // u: 0 (root attached to body) -> 1 (outer fin tip)
    // v: 0 (lower/posterior edge) -> 1 (upper/anterior edge)
    const centeredV = (v - 0.5) * 2; // -1 .. +1
    const rayCorrugation = Math.sin(v * Math.PI * 10) * 0.014 * u;
    const baseThickness = (1 - u * 0.78) * 0.028 + 0.006;
    const xThickness = sideSign * (baseThickness + rayCorrugation * sideSign);

    if (kind === 'caudal') {
      // Forked 3D lunate/veil tail fan extending along -Z and spreading in ±Y and ±X
      const forkIndent = 1.0 - 0.36 * Math.exp(-centeredV * centeredV * 4.5);
      const spanZ = -u * (isAngel ? 0.68 : 0.54) * forkIndent;
      const spreadY = centeredV * (0.12 + u * (isAngel ? 0.62 : 0.46));
      // Slight 3D fan curvature in X so the tail is a real 3D scoop from behind
      const cupX = xThickness + Math.sin(u * Math.PI) * (centeredV * centeredV) * 0.04 * sideSign;
      return [cupX, spreadY, spanZ];
    }

    if (kind === 'dorsal') {
      // Swept 3D dorsal fin rising in +Y and sweeping backward along -Z
      const zRoot = (0.5 - v) * 0.52;
      const heightMax = isAngel ? 0.62 : 0.32;
      const profileH = Math.sin(Math.pow(v, 0.7) * Math.PI) * heightMax;
      const y = u * profileH;
      const z = zRoot - u * (isAngel ? 0.34 : 0.22);
      return [xThickness, y, z];
    }

    if (kind === 'anal') {
      // Lower rear anal fin sweeping down in -Y and back in -Z
      const zRoot = (0.5 - v) * 0.34;
      const depthMax = isAngel ? 0.48 : 0.24;
      const profileD = Math.sin(Math.pow(v, 0.75) * Math.PI) * depthMax;
      const y = -u * profileD;
      const z = zRoot - u * 0.2;
      return [xThickness, y, z];
    }

    if (kind === 'pectoral') {
      // 3D teardrop wing fin extending outward and slightly back, with 3D camber
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
  // Side 0 (+X face)
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * rows + j;
      const b = (i + 1) * rows + j;
      const c = (i + 1) * rows + (j + 1);
      const d = i * rows + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }
  // Side 1 (-X face, reversed winding so outer normals point outward)
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
 * Builds a complete, organic, multi-segmented 3D fish `THREE.Group` with configurable polygon quality.
 */
function createSculpted3DFishRig(
  speciesId: string,
  primaryHex: string,
  secondaryHex: string,
  accentHex: string,
  bodyStyle: string,
  polygonQuality: FishPolygonQuality
): FishMeshRig {
  const group = new THREE.Group();
  const polySpec = getPolygonSpecForQuality(polygonQuality);
  const { skinMap, skinBump, finMap } = getOrCreateFishSkinTextures(
    primaryHex,
    secondaryHex,
    accentHex
  );

  // Iridescent Wet Fish Scales Physical Material (DoubleSide so no angle ever clips)
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#ffffff'),
    map: skinMap,
    bumpMap: skinBump,
    bumpScale: 0.028,
    roughness: 0.24,
    metalness: 0.14,
    clearcoat: 0.72,
    clearcoatRoughness: 0.16,
    side: THREE.DoubleSide,
  });

  // Volumetric Translucent Fin Material with Fin-Ray Texture
  const finMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(accentHex).lerp(new THREE.Color('#ffffff'), 0.35),
    map: finMap,
    roughness: 0.28,
    metalness: 0.1,
    emissive: new THREE.Color(accentHex),
    emissiveIntensity: 0.28,
    transparent: true,
    opacity: 0.92,
    clearcoat: 0.5,
    side: THREE.DoubleSide,
  });

  const irisMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accentHex).lerp(new THREE.Color('#fbbf24'), 0.5),
    roughness: 0.2,
    metalness: 0.75,
  });

  const pupilMat = new THREE.MeshStandardMaterial({
    color: 0x030712,
    roughness: 0.05,
    metalness: 0.1,
  });

  const eyeHighlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // 1. Anatomically Lofted 3D Fish Body (+Z Snout, -Z Peduncle)
  const { geometry: bodyGeo, basePositions, uCoords } = buildSculptedFishBodyGeometry(
    bodyStyle,
    polySpec.lengthRings,
    polySpec.radialSegments
  );
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  // 2. Sculpted 3D Gill Operculum Plates (Left & Right — gentle breathing flare visible from front & back)
  const gillGeo = new THREE.SphereGeometry(0.14, polySpec.eyeSegments, polySpec.eyeSegments);
  gillGeo.scale(0.28, 1.35, 0.95);
  const gillLeftMesh = new THREE.Mesh(gillGeo, bodyMat);
  gillLeftMesh.position.set(0.21, -0.01, 0.31);
  gillLeftMesh.rotation.y = 0.22;
  group.add(gillLeftMesh);

  const gillRightMesh = new THREE.Mesh(gillGeo, bodyMat);
  gillRightMesh.position.set(-0.21, -0.01, 0.31);
  gillRightMesh.rotation.y = -0.22;
  group.add(gillRightMesh);

  // 3. Articulated 3D Caudal Tail Fan (Mounted at rear peduncle z = -0.62)
  const tailPeduncleGroup = new THREE.Group();
  tailPeduncleGroup.position.set(0, 0, -0.61);
  const tailGeo = build3DVolumetricFinGeometry(
    'caudal',
    bodyStyle,
    polySpec.finSegmentsU,
    polySpec.finSegmentsV
  );
  const tailBladeMesh = new THREE.Mesh(tailGeo, finMat);
  tailBladeMesh.castShadow = true;
  tailPeduncleGroup.add(tailBladeMesh);
  group.add(tailPeduncleGroup);

  // 4. Volumetric 3D Dorsal Fin (Top Ridge)
  const isAngel = bodyStyle === 'angel_disc';
  const dorsalGeo = build3DVolumetricFinGeometry(
    'dorsal',
    bodyStyle,
    polySpec.finSegmentsU,
    polySpec.finSegmentsV
  );
  const dorsalFinMesh = new THREE.Mesh(dorsalGeo, finMat);
  dorsalFinMesh.position.set(0, isAngel ? 0.44 : 0.26, -0.04);
  group.add(dorsalFinMesh);

  // 5. Volumetric 3D Anal / Ventral Keel Fin (Bottom Rear)
  const analGeo = build3DVolumetricFinGeometry(
    'anal',
    bodyStyle,
    Math.max(4, Math.floor(polySpec.finSegmentsU * 0.75)),
    Math.max(4, Math.floor(polySpec.finSegmentsV * 0.75))
  );
  const analFinMesh = new THREE.Mesh(analGeo, finMat);
  analFinMesh.position.set(0, isAngel ? -0.38 : -0.22, -0.22);
  group.add(analFinMesh);

  // 6 & 7. Paired 3D Pectoral Wing Fins (Left +X and Right -X — visible from Front, Side & Back!)
  const pecGeo = build3DVolumetricFinGeometry(
    'pectoral',
    bodyStyle,
    polySpec.finSegmentsU,
    polySpec.finSegmentsV
  );

  const pectoralLeftGroup = new THREE.Group();
  pectoralLeftGroup.position.set(0.21, -0.06, 0.22);
  const pecLeftMesh = new THREE.Mesh(pecGeo, finMat);
  pecLeftMesh.rotation.y = 0.58; // Fanned outward in 3D
  pecLeftMesh.rotation.z = -0.24;
  pectoralLeftGroup.add(pecLeftMesh);
  group.add(pectoralLeftGroup);

  const pectoralRightGroup = new THREE.Group();
  pectoralRightGroup.position.set(-0.21, -0.06, 0.22);
  const pecRightMesh = new THREE.Mesh(pecGeo, finMat);
  pecRightMesh.scale.x = -1;
  pecRightMesh.rotation.y = -0.58; // Fanned outward in 3D
  pecRightMesh.rotation.z = 0.24;
  pectoralRightGroup.add(pecRightMesh);
  group.add(pectoralRightGroup);

  // 8 & 9. Paired 3D Pelvic Ventral Fins (Underneath chest, fanned outward left & right)
  const pelvicGeo = build3DVolumetricFinGeometry(
    'pelvic',
    bodyStyle,
    Math.max(4, Math.floor(polySpec.finSegmentsU * 0.65)),
    Math.max(4, Math.floor(polySpec.finSegmentsV * 0.65))
  );
  const pelvicLeftMesh = new THREE.Mesh(pelvicGeo, finMat);
  pelvicLeftMesh.position.set(0.08, isAngel ? -0.36 : -0.23, 0.14);
  pelvicLeftMesh.rotation.z = 0.32;
  group.add(pelvicLeftMesh);

  const pelvicRightMesh = new THREE.Mesh(pelvicGeo, finMat);
  pelvicRightMesh.position.set(-0.08, isAngel ? -0.36 : -0.23, 0.14);
  pelvicRightMesh.rotation.z = -0.32;
  group.add(pelvicRightMesh);

  // 10 & 11. 3D Multi-Part Eyes (Iris + Protruding Pupil + Specular Catchlight on Left & Right Head)
  const irisGeo = new THREE.SphereGeometry(0.068, polySpec.eyeSegments, polySpec.eyeSegments);
  irisGeo.scale(0.65, 1.0, 1.0);
  const pupilGeo = new THREE.SphereGeometry(0.044, polySpec.eyeSegments, polySpec.eyeSegments);
  const catchGeo = new THREE.SphereGeometry(0.018, 8, 8);

  const buildEyeAssembly = (sideSign: 1 | -1) => {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(sideSign * 0.165, 0.075, 0.44);
    eyeGroup.rotation.y = sideSign * 0.24; // Angled slightly forward so visible from front & side!

    const irisMesh = new THREE.Mesh(irisGeo, irisMat);
    const pupilMesh = new THREE.Mesh(pupilGeo, pupilMat);
    pupilMesh.position.set(sideSign * 0.025, 0, 0.015);
    const catchMesh = new THREE.Mesh(catchGeo, eyeHighlightMat);
    catchMesh.position.set(sideSign * 0.042, 0.022, 0.028);

    eyeGroup.add(irisMesh, pupilMesh, catchMesh);
    return eyeGroup;
  };

  group.add(buildEyeAssembly(1));
  group.add(buildEyeAssembly(-1));

  // 12. Bioluminescent Dorsal Photophore Node
  const lureGeo = new THREE.SphereGeometry(0.045, 10, 10);
  const lureMesh = new THREE.Mesh(lureGeo, finMat);
  lureMesh.position.set(0, isAngel ? 0.48 : 0.28, 0.25);
  group.add(lureMesh);

  // Selection Halo Ring
  const ringGeo = new THREE.RingGeometry(0.72, 0.82, 32);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const selectionRing = new THREE.Mesh(ringGeo, ringMat);
  selectionRing.position.set(0, -0.48, 0);
  selectionRing.visible = false;
  group.add(selectionRing);

  // Soft Radial Contact Shadow Disc on Seabed
  const shadowGeo = new THREE.CircleGeometry(0.55, 16);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x02060d,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  });
  const shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);

  // Count total triangles in this 3D fish rig
  let triangleCount = 0;
  group.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const g = (obj as THREE.Mesh).geometry;
      if (g.index) {
        triangleCount += g.index.count / 3;
      } else if (g.attributes.position) {
        triangleCount += g.attributes.position.count / 3;
      }
    }
  });

  return {
    group,
    bodyGeo,
    basePositions,
    uCoords,
    bodyMat,
    finMat,
    tailPeduncleGroup,
    tailBladeMesh,
    pectoralLeftGroup,
    pectoralRightGroup,
    pelvicLeftMesh,
    pelvicRightMesh,
    dorsalFinMesh,
    analFinMesh,
    gillLeftMesh,
    gillRightMesh,
    lureMesh,
    selectionRing,
    shadowDisc,
    speciesId,
    polygonQuality,
    triangleCount: Math.round(triangleCount),
  };
}

/**
 * Applies a real-time biomechanical S-wave swimming deformation along the fish's 3D body spine
 * so the head, trunk, and tail undulate fluidly through the water instead of rotating like a rigid box.
 */
function deformFishSpineSWave(rig: FishMeshRig, tailPhase: number, finAspect: number) {
  const posAttr = rig.bodyGeo.getAttribute('position') as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const base = rig.basePositions;
  const uArr = rig.uCoords;
  const count = uArr.length;
  const amp = 0.085 * finAspect;

  for (let i = 0; i < count; i++) {
    const u = uArr[i];
    // Traveling S-wave amplitude increases smoothly from head (u=0) toward tail peduncle (u=1)
    const envelope = u * u * 1.15 + u * 0.15;
    const waveX = Math.sin(tailPhase - u * 4.2) * amp * envelope;
    arr[i * 3 + 0] = base[i * 3 + 0] + waveX;
  }
  posAttr.needsUpdate = true;
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

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // 1. Software-WebGL Detection from GPU Renderer String
    const isSoftwareGl = (() => {
      try {
        const probeCanvas = document.createElement('canvas');
        const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return true;
      }
    })();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl && qualityTier !== 'low',
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.setPixelRatio(
      isSoftwareGl || qualityTier === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    renderer.shadowMap.enabled = !isSoftwareGl && qualityTier !== 'low';
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

    // 2. Studio Environment Map via RoomEnvironment + PMREMGenerator
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 3. Multi-Light Underwater Studio Rig (Overhead Sun + Cyan Rim + Front Fill so fish faces are well-lit)
    const hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x081c30, 1.15);
    hemiLight.position.set(0, 25, 0);
    scene.add(hemiLight);

    const sunKeyLight = new THREE.DirectionalLight(0xfff7e0, 1.85);
    sunKeyLight.position.set(7, 22, 12);
    if (!isSoftwareGl && qualityTier !== 'low') {
      sunKeyLight.castShadow = true;
      sunKeyLight.shadow.mapSize.width = 1024;
      sunKeyLight.shadow.mapSize.height = 1024;
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
    scene.add(rimLight);

    const frontFillLight = new THREE.DirectionalLight(0xbae6fd, 0.65);
    frontFillLight.position.set(0, 4, 18);
    scene.add(frontFillLight);

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const { sandMap, sandBump, causticMap } = createProceduralSandAndCausticsTextures(maxAniso);

    // 4. Aquarium Habitat Container Group
    const habitatGroup = new THREE.Group();
    scene.add(habitatGroup);

    let causticOverlayPlane: THREE.Mesh | null = null;
    let activeFrustumWallsMat: THREE.MeshBasicMaterial | null = null;
    let activeWaterSurfaceMat: THREE.MeshBasicMaterial | null = null;
    let kelpInstancedMesh: THREE.InstancedMesh | null = null;
    let kelpCountCurrent = 0;
    const kelpBasePositions: Array<{ x: number; y: number; z: number; scaleY: number; phase: number }> = [];
    let builtTankTier = -1;
    let builtFramelessMode: boolean | null = null;
    let builtAspect = camera.aspect;
    const _abyssBlack = new THREE.Color(0x010409);
    const _baseWaterColor = new THREE.Color();
    const _ambientWaterColor = new THREE.Color();
    const _computedBgColor = new THREE.Color();

    function computeUserBackgroundColor(
      tank: { waterTintHex: string; ambientLightColorHex: string },
      bgBrightness: number
    ): THREE.Color {
      const b = Math.max(0, Math.min(1, bgBrightness));
      _baseWaterColor.set(tank.waterTintHex);
      _ambientWaterColor.set(tank.ambientLightColorHex);
      if (b <= 0.35) {
        // 0.00 = pitch abyss (#010409), 0.22 (default) = deep dark midnight ocean, 0.35 = base waterTint
        const t = b / 0.35;
        return _computedBgColor.copy(_abyssBlack).lerp(_baseWaterColor, t);
      } else {
        // 0.35 .. 1.00 = smoothly brighten from base waterTint toward ambient reef blue
        const t = ((b - 0.35) / 0.65) * 0.52;
        return _computedBgColor.copy(_baseWaterColor).lerp(_ambientWaterColor, t);
      }
    }

    /**
     * Builds a custom 3D Trapezoidal Perspective-Frustum surface mesh (smaller width in front `z > 0`,
     * wider width in back `z < 0`, sloped along the camera frustum's bottom or top ray) so Full-Screen
     * TV Mode shows 100% of the tank's contents edge-to-edge without hiding front sides or seeing outside.
     */
    function buildTrapezoidalFrustumSurfaceGeometry(
      tank: { width: number; height: number; depth: number },
      aspect: number,
      mode: 'floor' | 'caustic' | 'surface',
      widthScale: number = 1.12
    ): THREE.BufferGeometry {
      const segX = 24;
      const segZ = 18;
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
        const v = iz / segZ; // 0 = front (close to camera, narrower), 1 = back (far from camera, wider)
        const z = zFront + (zBack - zFront) * v;
        const slice = getTankBoundsAtZ(tank, z, true, aspect);
        const spanW = slice.frustumHalfW * 2 * widthScale;

        for (let ix = 0; ix <= segX; ix++) {
          const u = ix / segX; // 0 = left, 1 = right
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
          // Winding so normal points +Y (upward into the tank)
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

    /**
     * Builds the 3D Trapezoidal Frustum Side & Back Sanctuary Walls for Full-Screen TV Mode
     * with vertical depth vertex shading (darker at the bottom abyss, slightly lighter near top surface)
     * so the viewer never sees outside the aquarium volume and the back wall never glares.
     */
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

      // 3 quads: Left frustum wall, Right frustum wall, Back frustum wall
      const positions = new Float32Array([
        // Left wall (0..3: bot-front, bot-back, top-back, top-front)
        -wf, yfBot, zFront,
        -wb, ybBot, zBack,
        -wb, ybTop, zBack,
        -wf, yfTop, zFront,
        // Right wall (4..7: bot-back, bot-front, top-front, top-back)
        wb, ybBot, zBack,
        wf, yfBot, zFront,
        wf, yfTop, zFront,
        wb, ybTop, zBack,
        // Back wall (8..11: bot-left, bot-right, top-right, top-left)
        -wb, ybBot, zBack,
        wb, ybBot, zBack,
        wb, ybTop, zBack,
        -wb, ybTop, zBack,
      ]);

      // Vertex colors provide natural underwater depth shading (deep dark bottom -> ocean top)
      const botShade = 0.48;
      const topShade = 1.0;
      const colors = new Float32Array([
        // Left wall
        botShade, botShade, botShade,
        botShade, botShade, botShade,
        topShade, topShade, topShade,
        topShade, topShade, topShade,
        // Right wall
        botShade, botShade, botShade,
        botShade, botShade, botShade,
        topShade, topShade, topShade,
        topShade, topShade, topShade,
        // Back wall
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

      const floorMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: sandMap,
        bumpMap: sandBump,
        bumpScale: 0.08,
        roughness: 0.88,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });

      const causticMat = new THREE.MeshBasicMaterial({
        map: causticMap,
        transparent: true,
        opacity: 0.36 * tank.causticsIntensity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
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
        // A. Perspective-Frustum Trapezoidal Seabed Floor (narrower in front, wider in back)
        const frustumFloorGeo = buildTrapezoidalFrustumSurfaceGeometry(tank, aspect, 'floor', 1.14);
        const floorMesh = new THREE.Mesh(frustumFloorGeo, floorMat);
        floorMesh.receiveShadow = true;
        habitatGroup.add(floorMesh);

        // B. Perspective-Frustum Caustic Shimmer Overlay
        const frustumCausticGeo = buildTrapezoidalFrustumSurfaceGeometry(tank, aspect, 'caustic', 1.12);
        causticOverlayPlane = new THREE.Mesh(frustumCausticGeo, causticMat);
        habitatGroup.add(causticOverlayPlane);

        // C. Perspective-Frustum Top Water Surface Meniscus
        const frustumSurfaceGeo = buildTrapezoidalFrustumSurfaceGeometry(tank, aspect, 'surface', 1.14);
        const waterSurfaceMesh = new THREE.Mesh(frustumSurfaceGeo, surfaceMat);
        habitatGroup.add(waterSurfaceMesh);

        // D. Frustum Sanctuary Side & Back Enclosure Walls (Unlit MeshBasicMaterial with vertex depth gradient
        // so directional/studio lights never cause bright blue glare on the back wall!)
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
      } else {
        // Classic Framed Box Tank Mode
        const floorGeo = new THREE.BoxGeometry(W, 0.45, D);
        const floorMesh = new THREE.Mesh(floorGeo, floorMat);
        floorMesh.position.set(0, floorY - 0.225, 0);
        floorMesh.receiveShadow = true;
        habitatGroup.add(floorMesh);

        const causticGeo = new THREE.PlaneGeometry(W * 0.98, D * 0.98);
        causticGeo.rotateX(-Math.PI / 2);
        causticOverlayPlane = new THREE.Mesh(causticGeo, causticMat);
        causticOverlayPlane.position.set(0, floorY + 0.025, 0);
        habitatGroup.add(causticOverlayPlane);

        const frameMat = new THREE.MeshStandardMaterial({
          color: 0x0f172a,
          roughness: 0.28,
          metalness: 0.85,
        });
        const trimMat = new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          roughness: 0.2,
          metalness: 0.6,
          emissive: 0x0284c7,
          emissiveIntensity: 0.25,
        });

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

        const glassMat = new THREE.MeshPhysicalMaterial({
          color: 0xbae6fd,
          roughness: 0.08,
          metalness: 0.0,
          transmission: isSoftwareGl ? 0 : 0.85,
          transparent: true,
          opacity: isSoftwareGl ? 0.14 : 0.28,
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

      // D. Composite Basalt Rock Arches & Reef Formations (Positioned inside the Frustum!)
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        bumpMap: sandBump,
        bumpScale: 0.12,
        roughness: 0.82,
        metalness: 0.12,
      });
      const mossMat = new THREE.MeshStandardMaterial({
        color: 0x0f766e,
        roughness: 0.65,
        metalness: 0.08,
      });

      const dodecaGeo = new THREE.DodecahedronGeometry(1.1, 1);
      for (let r = 0; r < tank.rockArchCount; r++) {
        const archGroup = new THREE.Group();
        const angle = (r / Math.max(1, tank.rockArchCount)) * Math.PI * 1.6 - Math.PI * 0.8;
        const rz = -D * 0.14 + Math.cos(angle * 2) * (D * 0.22);
        const rSlice = getTankBoundsAtZ(tank, rz, isFrameless, aspect);
        const rx = Math.sin(angle) * (rSlice.halfW * 0.72);

        const baseLeft = new THREE.Mesh(dodecaGeo, rockMat);
        baseLeft.scale.set(1.2, 1.4, 1.0);
        baseLeft.position.set(-0.9, 0.7, 0);

        const baseRight = new THREE.Mesh(dodecaGeo, rockMat);
        baseRight.scale.set(1.1, 1.3, 0.9);
        baseRight.position.set(0.9, 0.65, 0.1);

        const bridge = new THREE.Mesh(dodecaGeo, rockMat);
        bridge.scale.set(1.6, 0.65, 0.85);
        bridge.position.set(0, 1.55, 0.05);

        const mossCap = new THREE.Mesh(dodecaGeo, mossMat);
        mossCap.scale.set(1.3, 0.28, 0.7);
        mossCap.position.set(0, 1.92, 0.05);

        archGroup.add(baseLeft, baseRight, bridge, mossCap);
        archGroup.position.set(rx, rSlice.floorY, rz);
        archGroup.rotation.y = (r * 1.1) % Math.PI;
        habitatGroup.add(archGroup);
      }

      // E. Bioluminescent Coral Colonies (Scaled to Frustum Width & Floor Height at Z)
      const coralColors = [0xf43f5e, 0xf59e0b, 0xa855f7, 0x06b6d4, 0x10b981];
      const branchGeo = new THREE.CylinderGeometry(0.06, 0.14, 0.9, 8);
      branchGeo.translate(0, 0.45, 0);
      const tipGeo = new THREE.SphereGeometry(0.11, 8, 8);

      for (let c = 0; c < tank.coralCount; c++) {
        const colHex = coralColors[c % coralColors.length];
        const coralMat = new THREE.MeshStandardMaterial({
          color: colHex,
          roughness: 0.45,
          metalness: 0.15,
          emissive: colHex,
          emissiveIntensity: 0.28,
        });
        const coralGroup = new THREE.Group();
        for (let b = 0; b < 4; b++) {
          const branch = new THREE.Mesh(branchGeo, coralMat);
          branch.rotation.z = (b - 1.5) * 0.32;
          branch.rotation.x = ((b % 2) - 0.5) * 0.28;
          const s = 0.65 + (b % 3) * 0.25;
          branch.scale.set(s, s, s);
          const tip = new THREE.Mesh(tipGeo, coralMat);
          tip.position.set(0, 0.9, 0);
          branch.add(tip);
          coralGroup.add(branch);
        }
        const cz = (((c * 43) % 100) / 100 - 0.5) * (D * 0.74);
        const cSlice = getTankBoundsAtZ(tank, cz, isFrameless, aspect);
        const cx = (((c * 67) % 100) / 100 - 0.5) * (cSlice.halfW * 1.72);
        coralGroup.position.set(cx, cSlice.floorY, cz);
        habitatGroup.add(coralGroup);
      }

      // F. Swaying Botanical Kelp Blades (`InstancedMesh`, Distributed inside Frustum)
      kelpCountCurrent = tank.kelpCount;
      const kelpGeo = new THREE.CylinderGeometry(0.03, 0.08, 2.6, 7, 5);
      kelpGeo.scale(1.8, 1.0, 0.45);
      kelpGeo.translate(0, 1.3, 0);
      const kelpMat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        roughness: 0.5,
        metalness: 0.1,
      });
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
    const BUBBLE_COUNT = qualityTier === 'low' ? 24 : 56;
    const bubbleGeo = new THREE.SphereGeometry(0.065, 10, 10);
    const bubbleMat = new THREE.MeshStandardMaterial({
      color: 0xe0f2fe,
      roughness: 0.1,
      metalness: 0.2,
      transparent: true,
      opacity: 0.55,
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

    // 6. Food Pellet `InstancedMesh` Pool
    const MAX_PELLETS = 64;
    const pelletGeo = new THREE.SphereGeometry(0.11, 10, 10);
    const pelletMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.35,
      metalness: 0.1,
      emissive: 0xd97706,
      emissiveIntensity: 0.45,
    });
    const pelletInstanced = new THREE.InstancedMesh(pelletGeo, pelletMat, MAX_PELLETS);
    pelletInstanced.frustumCulled = false;
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

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = Math.max(1, container.clientHeight || window.innerHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // 9. Paced Render & Simulation Loop
    let frameId = 0;
    let isUnmounted = false;
    let lastTimeMs = performance.now();
    let elapsedTotal = 0;
    let lastReportedPolyQuality: FishPolygonQuality | null = null;
    let lastReportedFishCount = -1;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (isUnmounted) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (isUnmounted) return;
      const nowMs = performance.now();
      const rawDt = Math.min(0.05, Math.max(0.001, (nowMs - lastTimeMs) / 1000));
      lastTimeMs = nowMs;

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

      // Apply user lighting & back-of-tank background brightness settings in real time
      const userLightIntensity = Math.max(
        0.15,
        Math.min(1.8, eco.graphicsSettings?.lightIntensity ?? 0.95)
      );
      const userBgBrightness = Math.max(
        0.0,
        Math.min(1.0, eco.graphicsSettings?.backgroundBrightness ?? 0.22)
      );
      const liveBgCol = computeUserBackgroundColor(tank, userBgBrightness);
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
        activeWaterSurfaceMat.opacity =
          (isFramelessNow ? 0.14 : 0.2) * Math.min(1.25, userLightIntensity);
      }

      hemiLight.intensity = 1.05 * userLightIntensity;
      sunKeyLight.intensity = 1.65 * userLightIntensity;
      rimLight.intensity = 0.8 * userLightIntensity;
      frontFillLight.intensity = 0.55 * userLightIntensity;
      renderer.toneMappingExposure = 0.85 + 0.28 * Math.min(1.4, userLightIntensity);

      // Animate caustics & swaying kelp
      causticMap.offset.x = (elapsedTotal * 0.03) % 1;
      causticMap.offset.y = (elapsedTotal * 0.022) % 1;
      if (causticOverlayPlane) {
        causticOverlayPlane.visible = eco.graphicsSettings?.showCaustics !== false;
        const cMat = causticOverlayPlane.material as THREE.MeshBasicMaterial;
        if (cMat) {
          cMat.opacity = 0.32 * tank.causticsIntensity * Math.min(1.3, userLightIntensity);
        }
      }

      if (kelpInstancedMesh) {
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
      const showParticles = eco.graphicsSettings?.showParticles !== false;
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

      // Sync Food Pellets
      const pellets = pelletsRef.current;
      for (let i = 0; i < MAX_PELLETS; i++) {
        if (i < pellets.length) {
          const p = pellets[i];
          _vec3A.set(p.x, p.y, p.z);
          _quat.identity();
          _scaleVec.set(1, 1, 1);
          _mat4.compose(_vec3A, _quat, _scaleVec);
        } else {
          _vec3A.set(0, -999, 0);
          _scaleVec.set(0, 0, 0);
          _mat4.compose(_vec3A, _quat, _scaleVec);
        }
        pelletInstanced.setMatrixAt(i, _mat4);
      }
      pelletInstanced.instanceMatrix.needsUpdate = true;

      // Hide 3D cursor ring — food is sprinkled naturally on top of the water surface
      cursorGroup.visible = false;

      // Sync Individual Sculpted 3D Fish Rigs (Both Live Swimming Fishes & Dead / Starved Fishes)
      const activeIds = new Set<string>();
      let sampleTriCount = 0;

      for (let i = 0; i < eco.fishes.length; i++) {
        const fish = eco.fishes[i];
        activeIds.add(fish.lineage.fishId);

        let rig = fishRigs.get(fish.lineage.fishId);
        // Rebuild rig if newly spawned OR if user changed the 3D Fish Polygon Quality setting!
        if (rig && rig.polygonQuality !== targetPolyQuality) {
          fishContainer.remove(rig.group);
          fishContainer.remove(rig.shadowDisc);
          rig.bodyGeo.dispose();
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
            targetPolyQuality
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
          // DEAD FISH VISUAL: Float belly-up (roll = PI) near the top water surface with pale desaturated scales and motionless fins
          const targetDeadY = fishSlice.surfaceY - 0.26 + Math.sin(elapsedTotal * 1.1 + i) * 0.03;
          fish.state.y += (targetDeadY - fish.state.y) * Math.min(1, rawDt * 2.2);
          fish.state.vx *= 0.92;
          fish.state.vz *= 0.92;

          rig.group.position.set(fish.state.x, fish.state.y, fish.state.z);
          rig.group.scale.set(scale, scale, scale);
          rig.group.rotation.set(0.06, fish.state.yaw, Math.PI, 'YXZ');

          // Pale, desaturated gray-blue body & dim fins to clearly indicate death/starvation
          rig.bodyMat.color.setHex(0x64748b);
          rig.bodyMat.roughness = 0.75;
          rig.finMat.emissiveIntensity = 0.02;
          rig.finMat.opacity = 0.55;

          // Zero out spine wave and fin rotations (motionless dead fish)
          deformFishSpineSWave(rig, 0, 0);
          rig.tailPeduncleGroup.rotation.y = 0;
          rig.tailBladeMesh.rotation.y = 0;
          rig.dorsalFinMesh.rotation.z = 0;
          rig.analFinMesh.rotation.z = 0;
          rig.pectoralLeftGroup.rotation.y = 0.15;
          rig.pectoralLeftGroup.rotation.z = 0;
          rig.pectoralRightGroup.rotation.y = -0.15;
          rig.pectoralRightGroup.rotation.z = 0;
          rig.gillLeftMesh.rotation.y = 0.18;
          rig.gillRightMesh.rotation.y = -0.18;

          rig.selectionRing.visible = selectedFishIdRef.current === fish.lineage.fishId;
          rig.shadowDisc.position.set(fish.state.x, fishSlice.floorY + 0.04, fish.state.z);
          rig.shadowDisc.scale.set(scale * 0.65, scale * 0.65, scale * 0.65);
          continue;
        }

        // Restore live coloration if a fish was revived
        _color.set('#ffffff');
        _color.offsetHSL(fish.genetics.primaryHueShift / 360, 0, 0);
        rig.bodyMat.color.copy(_color);
        rig.bodyMat.roughness = 0.24;
        rig.finMat.opacity = 0.92;

        rig.group.position.set(fish.state.x, fish.state.y, fish.state.z);
        rig.group.scale.set(scale, scale, scale);
        rig.group.rotation.set(
          fish.state.pitch,
          fish.state.yaw,
          fish.state.roll || 0,
          'YXZ'
        );

        // 1. Real-time S-wave biomechanical spine undulation
        deformFishSpineSWave(rig, fish.state.tailPhase, fish.genetics.finAspectGene);

        // 2. Articulated 2-stage caudal tail fan & dorsal/anal ripple
        const wag = Math.sin(fish.state.tailPhase) * 0.44 * fish.genetics.finAspectGene;
        const lagWag = Math.sin(fish.state.tailPhase - 0.65) * 0.28 * fish.genetics.finAspectGene;
        rig.tailPeduncleGroup.rotation.y = wag;
        rig.tailBladeMesh.rotation.y = lagWag;
        rig.dorsalFinMesh.rotation.z = Math.sin(fish.state.tailPhase - 0.4) * 0.14;
        rig.analFinMesh.rotation.z = -Math.sin(fish.state.tailPhase - 0.4) * 0.14;

        // 3. 3D Pectoral Wing Fins figure-8 sculling & Gill breathing
        const scull = Math.cos(fish.state.tailPhase * 0.85);
        const feather = Math.sin(fish.state.tailPhase * 0.85);
        rig.pectoralLeftGroup.rotation.y = scull * 0.36;
        rig.pectoralLeftGroup.rotation.z = feather * 0.18;
        rig.pectoralRightGroup.rotation.y = -scull * 0.36;
        rig.pectoralRightGroup.rotation.z = -feather * 0.18;

        const breathe = Math.sin(elapsedTotal * 4.2 + i) * 0.08 + 0.08;
        rig.gillLeftMesh.rotation.y = 0.2 + breathe;
        rig.gillRightMesh.rotation.y = -0.2 - breathe;

        rig.finMat.emissiveIntensity =
          0.24 +
          Math.sin(elapsedTotal * 3 + i) * 0.16 * fish.genetics.luminancePulseGene;

        rig.selectionRing.visible = selectedFishIdRef.current === fish.lineage.fishId;

        // Grounded contact shadow on the sloped frustum seabed at the fish's Z depth
        rig.shadowDisc.position.set(fish.state.x, fishSlice.floorY + 0.04, fish.state.z);
        const heightAboveFloor = Math.max(0.1, fish.state.y - fishSlice.floorY);
        const shadowScale = Math.max(0.3, scale * (1.1 - heightAboveFloor * 0.05));
        rig.shadowDisc.scale.set(shadowScale, shadowScale, shadowScale);
      }

      // Dispose rigs of removed fishes
      for (const [id, rig] of fishRigs.entries()) {
        if (!activeIds.has(id)) {
          fishContainer.remove(rig.group);
          fishContainer.remove(rig.shadowDisc);
          rig.bodyGeo.dispose();
          rig.bodyMat.dispose();
          rig.finMat.dispose();
          fishRigs.delete(id);
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
        // Locked to the exact apex of the 3D perspective-frustum aquarium so:
        // - Front fishes (z > 0) are close and crisp without ever hiding off the front-left/right sides
        // - Back fishes (z < 0) span the full wide rear frustum
        // - You see 100% of the tank's contents edge-to-edge without seeing outside the tank
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

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    return () => {
      isUnmounted = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
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
