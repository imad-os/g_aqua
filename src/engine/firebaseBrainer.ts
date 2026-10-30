import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  query,
  limit,
} from 'firebase/firestore';
import { applyFishLifetimeLearning, forwardFishBrain } from './brain';
import { DEFAULT_BRAIN_CONFIG } from './defaults';
import {
  AdminUserRecord,
  ExperimentComparisonResult,
  FishBrainInstance,
  FishEntity,
  ModelVersionRecord,
} from './types';

// Provided Firebase configuration dedicated to AI brains, training, model registry, admins, and offline brain simulation
const firebaseConfig = {
  apiKey: 'AIzaSyCMfZ34sql74cMZIBc_bmI0cDM1CSIcv_s',
  authDomain: 'aquarium-caa2b.firebaseapp.com',
  projectId: 'aquarium-caa2b',
  storageBucket: 'aquarium-caa2b.firebasestorage.app',
  messagingSenderId: '673598540723',
  appId: '1:673598540723:web:08841931d7f6f4ad5859c6',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const aiFirestore = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

function getSafeAuth() {
  try {
    return getAuth(app);
  } catch {
    return null;
  }
}

const LOCAL_ADMINS_CACHE_KEY = 'abyssal_evo_admins_cache_v1';
const LOCAL_BASE_MODELS_CACHE_KEY = 'abyssal_evo_base_models_v1';
const DEFAULT_OWNER_EMAIL = 'elkholtiimad@gmail.com';

export interface CloudUserFishBrainItem {
  fishId: string;
  name: string;
  speciesId: string;
  generation: number;
  modelVersion: string;
  motherId: string | null;
  fatherId: string | null;
  alive: boolean;
  causeOfDeath: string | null;
  energy: number;
  hunger: number;
  ageSimHours: number;
  lifespanSimHours: number;
  brain: FishBrainInstance;
  foragingEfficiency: number;
  lifetimeReward: number;
  decisionsMade?: number;
  foodPelletsEaten?: number;
  inheritedMutations: string[];
}

export interface CloudUserBrainRecord {
  username: string;
  profileId: string;
  updatedAtMs: number;
  updatedAtIso?: string;
  adminOverrideAtMs?: number;
  lastAdminAction?: string;
  removedFishIds?: string[];
  isActivelyPlaying: boolean;
  lastGameHeartbeatMs: number;
  autoFeederStock: number;
  fishBrains: CloudUserFishBrainItem[];
}

export type UserFishBrainItem = CloudUserFishBrainItem;

export const MAX_VERSIONS_PER_SPECIES = 5;

// Track last Firestore write timestamp per username so background Keeper ticks only write every 4 minutes
const _lastCloudUserFirestoreWriteMs = new Map<string, number>();
export const FIRESTORE_CHECKPOINT_INTERVAL_MS = 240_000; // 4 minutes (3-5 min range)

/**
 * Sorts model versions so the latest version is first and the oldest is last.
 */
export function sortSpeciesModelVersionsNewestFirst(
  versions: ModelVersionRecord[]
): ModelVersionRecord[] {
  return [...versions].sort((a, b) => {
    const tA = Date.parse(a.createdAtIso || '') || 0;
    const tB = Date.parse(b.createdAtIso || '') || 0;
    if (tB !== tA) return tB - tA;
    const genA = a.generationTrained || 0;
    const genB = b.generationTrained || 0;
    if (genB !== genA) return genB - genA;
    return b.versionId.localeCompare(a.versionId);
  });
}

/**
 * Enforces that each fish species keeps at most the last 5 versions (`MAX_VERSIONS_PER_SPECIES`),
 * sorted with the latest version first and the oldest version last.
 * Deletes any oldest versions beyond 5.
 */
export function pruneSpeciesModelVersions(
  registry: ModelVersionRecord[],
  speciesId: string,
  maxPerSpecies: number = MAX_VERSIONS_PER_SPECIES
): { keptRegistry: ModelVersionRecord[]; prunedForSpecies: ModelVersionRecord[] } {
  const otherSpeciesModels: ModelVersionRecord[] = [];
  const sameSpeciesModels: ModelVersionRecord[] = [];

  for (const m of registry) {
    if (m.speciesId === speciesId) {
      sameSpeciesModels.push(m);
    } else {
      otherSpeciesModels.push(m);
    }
  }

  // Sort sameSpeciesModels strictly newest first, oldest last
  const sortedSame = sortSpeciesModelVersionsNewestFirst(sameSpeciesModels);

  if (sortedSame.length <= maxPerSpecies) {
    return {
      keptRegistry: [...sortedSame, ...otherSpeciesModels],
      prunedForSpecies: [],
    };
  }

  const keptForSpecies = sortedSame.slice(0, maxPerSpecies);
  const prunedForSpecies = sortedSame.slice(maxPerSpecies);

  // If the promoted base model fell into prunedForSpecies, promote the newest kept version instead
  // so we strictly keep only the 5 newest versions and delete the oldest ones
  if (!keptForSpecies.some((m) => m.isPromotedBase) && keptForSpecies.length > 0) {
    keptForSpecies[0].isPromotedBase = true;
  }

  return {
    keptRegistry: [...keptForSpecies, ...otherSpeciesModels],
    prunedForSpecies,
  };
}

function sanitizeKey(name: string): string {
  return (name || 'Keeper').trim().replace(/[^a-zA-Z0-9_@.-]/g, '_') || 'Keeper';
}

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

// Firestore does not allow direct nested 2D arrays (number[][]), so we wrap each layer in a map object
interface FirestoreSafeBrain {
  architecture: FishBrainInstance['architecture'];
  layers: Array<{
    iw: number[];
    ib: number[];
    dw: number[];
    db: number[];
  }>;
  recurrentState: number[];
  attentionGates: number[];
  lastInputs: number[];
  lastOutputs: number[];
}

function round4(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/**
 * Recursively strips `undefined` properties from objects and replaces `undefined` array items with `null`
 * so Firestore `setDoc()` NEVER throws `FirebaseError: Unsupported field value: undefined`.
 */
function stripUndefinedDeep<T>(val: T): T {
  if (val === undefined) return null as unknown as T;
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => (item === undefined ? null : stripUndefinedDeep(item))) as unknown as T;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val as Record<string, any>)) {
    if (v !== undefined) {
      out[k] = stripUndefinedDeep(v);
    }
  }
  return out as T;
}

export function toFirestoreSafeBrain(brain: any): FirestoreSafeBrain {
  // If already converted to FirestoreSafeBrain (has .layers and no .inheritedWeights), return cleanly
  if (brain && Array.isArray(brain.layers) && !Array.isArray(brain.inheritedWeights)) {
    return {
      architecture: brain.architecture || {
        inputCount: 10,
        hiddenLayers: [16, 12],
        outputCount: 4,
        activation: 'tanh',
        recurrentMemoryEnabled: true,
        attentionModuleEnabled: true,
      },
      layers: brain.layers.map((l: any) => ({
        iw: Array.isArray(l?.iw) ? l.iw.map(round4) : [],
        ib: Array.isArray(l?.ib) ? l.ib.map(round4) : [],
        dw: Array.isArray(l?.dw) ? l.dw.map(round4) : [],
        db: Array.isArray(l?.db) ? l.db.map(round4) : [],
      })),
      recurrentState: Array.isArray(brain.recurrentState) ? brain.recurrentState.map(round4) : [],
      attentionGates: Array.isArray(brain.attentionGates) ? brain.attentionGates.map(round4) : [],
      lastInputs: Array.isArray(brain.lastInputs) ? brain.lastInputs.map(round4) : [],
      lastOutputs: Array.isArray(brain.lastOutputs) ? brain.lastOutputs.map(round4) : [],
    };
  }

  const inheritedWeights: number[][] = Array.isArray(brain?.inheritedWeights)
    ? brain.inheritedWeights
    : [];
  const inheritedBiases: number[][] = Array.isArray(brain?.inheritedBiases)
    ? brain.inheritedBiases
    : [];
  const learnedDeltaWeights: number[][] = Array.isArray(brain?.learnedDeltaWeights)
    ? brain.learnedDeltaWeights
    : [];
  const learnedDeltaBiases: number[][] = Array.isArray(brain?.learnedDeltaBiases)
    ? brain.learnedDeltaBiases
    : [];

  const layers = inheritedWeights.map((iw, idx) => ({
    iw: (Array.isArray(iw) ? iw : []).map(round4),
    ib: (Array.isArray(inheritedBiases[idx]) ? inheritedBiases[idx] : []).map(round4),
    dw: (Array.isArray(learnedDeltaWeights[idx]) ? learnedDeltaWeights[idx] : []).map(round4),
    db: (Array.isArray(learnedDeltaBiases[idx]) ? learnedDeltaBiases[idx] : []).map(round4),
  }));

  return {
    architecture: brain?.architecture
      ? { ...brain.architecture, aggressiveness: brain.architecture.aggressiveness ?? 0 }
      : {
          inputCount: 10,
          hiddenLayers: [16, 12],
          outputCount: 4,
          activation: 'tanh',
          recurrentMemoryEnabled: true,
          attentionModuleEnabled: true,
          aggressiveness: 0,
        },
    layers,
    recurrentState: (Array.isArray(brain?.recurrentState) ? brain.recurrentState : []).map(round4),
    attentionGates: (Array.isArray(brain?.attentionGates) ? brain.attentionGates : []).map(round4),
    lastInputs: (Array.isArray(brain?.lastInputs) ? brain.lastInputs : []).map(round4),
    lastOutputs: (Array.isArray(brain?.lastOutputs) ? brain.lastOutputs : []).map(round4),
  };
}

export function fromFirestoreSafeBrain(raw: any): FishBrainInstance {
  if (raw && Array.isArray(raw.inheritedWeights)) {
    return raw as FishBrainInstance;
  }
  const layers: Array<{ iw: number[]; ib: number[]; dw: number[]; db: number[] }> =
    raw?.layers || [];
  return {
    architecture: raw?.architecture
      ? { ...raw.architecture, aggressiveness: raw.architecture.aggressiveness ?? 0 }
      : {
          inputCount: 10,
          hiddenLayers: [16, 12],
          outputCount: 4,
          activation: 'tanh',
          recurrentMemoryEnabled: true,
          attentionModuleEnabled: true,
          aggressiveness: 0,
        },
    inheritedWeights: layers.map((l) => l.iw || []),
    inheritedBiases: layers.map((l) => l.ib || []),
    learnedDeltaWeights: layers.map((l) => l.dw || []),
    learnedDeltaBiases: layers.map((l) => l.db || []),
    recurrentState: raw?.recurrentState || [],
    attentionGates: raw?.attentionGates || [],
    lastInputs: raw?.lastInputs || [],
    lastOutputs: raw?.lastOutputs || [],
  };
}

// ============================================================================
// 1. GMAIL AUTHENTICATION & `admins` FIRESTORE COLLECTION
// ============================================================================

function getLocalCachedAdmins(): AdminUserRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_ADMINS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // ignore
  }
  return [
    {
      email: DEFAULT_OWNER_EMAIL,
      displayName: 'Primary Owner Admin',
      role: 'owner',
      addedAtIso: new Date().toISOString(),
      addedBy: 'system-bootstrap',
    },
  ];
}

function saveLocalCachedAdmins(admins: AdminUserRecord[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_ADMINS_CACHE_KEY, JSON.stringify(admins));
  } catch {
    // ignore
  }
}

/**
 * Fetches all admin records from the `admins` collection in Firestore (`aquarium-caa2b`).
 * Bootstraps the owner admin if the collection is empty.
 */
export async function fetchAdminsFromFirestore(): Promise<AdminUserRecord[]> {
  try {
    const snap = await getDocs(query(collection(aiFirestore, 'admins'), limit(50)));
    const list: AdminUserRecord[] = [];
    snap.forEach((d) => {
      const data = d.data() as any;
      if (data && data.email) {
        list.push({
          email: normalizeEmail(data.email),
          displayName: data.displayName || data.email,
          role: data.role === 'owner' ? 'owner' : 'admin',
          addedAtIso: data.addedAtIso || new Date().toISOString(),
          addedBy: data.addedBy || 'firestore',
        });
      }
    });

    if (list.length === 0) {
      const ownerRecord: AdminUserRecord = {
        email: DEFAULT_OWNER_EMAIL,
        displayName: 'Project Owner',
        role: 'owner',
        addedAtIso: new Date().toISOString(),
        addedBy: 'bootstrap',
      };
      await setDoc(doc(aiFirestore, 'admins', sanitizeKey(DEFAULT_OWNER_EMAIL)), ownerRecord, {
        merge: true,
      });
      list.push(ownerRecord);
    }

    saveLocalCachedAdmins(list);
    return list;
  } catch {
    return getLocalCachedAdmins();
  }
}

/**
 * Checks whether `email` exists in the Firestore `admins` collection.
 * If the `admins` collection is empty or the email is the founding owner, registers it in `admins`.
 */
export async function verifyAdminInFirestoreCollection(
  email: string,
  displayName?: string
): Promise<{ authorized: boolean; adminRecord: AdminUserRecord | null; adminsList: AdminUserRecord[] }> {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) {
    return { authorized: false, adminRecord: null, adminsList: [] };
  }

  const adminsList = await fetchAdminsFromFirestore();
  let matched = adminsList.find((a) => normalizeEmail(a.email) === cleanEmail) || null;

  // Auto-bootstrap if owner email or if collection had no custom admins yet
  if (!matched && cleanEmail === DEFAULT_OWNER_EMAIL) {
    matched = {
      email: cleanEmail,
      displayName: displayName || 'Owner Admin',
      role: 'owner',
      addedAtIso: new Date().toISOString(),
      addedBy: 'owner-bootstrap',
    };
    try {
      await setDoc(doc(aiFirestore, 'admins', sanitizeKey(cleanEmail)), matched, { merge: true });
    } catch {
      // ignore offline
    }
    adminsList.push(matched);
    saveLocalCachedAdmins(adminsList);
  }

  return {
    authorized: Boolean(matched),
    adminRecord: matched,
    adminsList,
  };
}

export async function addAdminToFirestore(
  newAdminEmail: string,
  displayName: string,
  addedByEmail: string
): Promise<AdminUserRecord[]> {
  const cleanEmail = normalizeEmail(newAdminEmail);
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return fetchAdminsFromFirestore();
  }
  const record: AdminUserRecord = {
    email: cleanEmail,
    displayName: displayName.trim() || cleanEmail.split('@')[0],
    role: cleanEmail === DEFAULT_OWNER_EMAIL ? 'owner' : 'admin',
    addedAtIso: new Date().toISOString(),
    addedBy: normalizeEmail(addedByEmail) || 'admin',
  };

  try {
    await setDoc(doc(aiFirestore, 'admins', sanitizeKey(cleanEmail)), record, { merge: true });
  } catch {
    // fallback to local cache if Firestore rules restrict write
  }
  const current = await fetchAdminsFromFirestore();
  if (!current.some((a) => normalizeEmail(a.email) === cleanEmail)) {
    current.push(record);
    saveLocalCachedAdmins(current);
  }
  return current;
}

export async function removeAdminFromFirestore(targetEmail: string): Promise<AdminUserRecord[]> {
  const cleanEmail = normalizeEmail(targetEmail);
  if (cleanEmail === DEFAULT_OWNER_EMAIL) {
    return fetchAdminsFromFirestore();
  }
  try {
    await deleteDoc(doc(aiFirestore, 'admins', sanitizeKey(cleanEmail)));
  } catch {
    // ignore
  }
  const updated = (await fetchAdminsFromFirestore()).filter(
    (a) => normalizeEmail(a.email) !== cleanEmail
  );
  saveLocalCachedAdmins(updated);
  return updated;
}

export async function signInWithGmailPopup(): Promise<{
  success: boolean;
  email: string | null;
  displayName: string | null;
  authorizedAdmin: boolean;
  errorMessage: string | null;
  errorCode: string | null;
}> {
  try {
    const authInstance = getSafeAuth();
    if (!authInstance) {
      return {
        success: false,
        email: null,
        displayName: null,
        authorizedAdmin: false,
        errorMessage: 'Firebase Auth is not initialized in this environment; please use Firestore Admin Verification below.',
        errorCode: 'auth/unavailable',
      };
    }
    const cred = await signInWithPopup(authInstance, googleProvider);
    const user: User = cred.user;
    const email = normalizeEmail(user.email || '');
    const displayName = user.displayName || email;
    const check = await verifyAdminInFirestoreCollection(email, displayName);
    if (!check.authorized) {
      await signOut(authInstance);
      return {
        success: false,
        email,
        displayName,
        authorizedAdmin: false,
        errorMessage: `Gmail account "${email}" is not listed in the Firestore "admins" collection.`,
        errorCode: 'not-in-admins-collection',
      };
    }
    return {
      success: true,
      email,
      displayName,
      authorizedAdmin: true,
      errorMessage: null,
      errorCode: null,
    };
  } catch (err: any) {
    const code = err?.code || 'auth/popup-error';
    const msg = err?.message || 'Google Sign-In popup could not complete.';
    return {
      success: false,
      email: null,
      displayName: null,
      authorizedAdmin: false,
      errorMessage: msg,
      errorCode: code,
    };
  }
}

export async function signOutAdminUser(): Promise<void> {
  try {
    const authInstance = getSafeAuth();
    if (authInstance) await signOut(authInstance);
  } catch {
    // ignore
  }
}

export function subscribeToFirebaseAuth(cb: (user: User | null) => void): () => void {
  const authInstance = getSafeAuth();
  if (!authInstance) {
    cb(null);
    return () => {};
  }
  return onAuthStateChanged(authInstance, cb);
}

// ============================================================================
// 2. BASE MODELS STORAGE (`base_models` COLLECTION IN FIRESTORE + LOCAL CACHE)
// ============================================================================

/**
 * Saves a trained or active Base Brain Model to the `base_models` collection in Firestore (`aquarium-caa2b`),
 * and enforces the strict retention cap of at most 10 versions per species (`MAX_VERSIONS_PER_SPECIES`).
 *
 * Firestore Path:
 * - Version doc: `base_models/{speciesId}__{versionId}`
 * - Active species pointer doc (when promoted): `base_models/active__{speciesId}`
 */
export async function saveModelVersionToFirestore(
  usernameOrEmail: string,
  model: ModelVersionRecord
): Promise<boolean> {
  const layers = model.weights.map((w, idx) => ({
    w: w.map(round4),
    b: (model.biases[idx] || []).map(round4),
  }));

  const payload = {
    savedBy: usernameOrEmail,
    versionId: model.versionId,
    speciesId: model.speciesId,
    parentVersionId: model.parentVersionId,
    createdAtIso: model.createdAtIso,
    generationTrained: model.generationTrained,
    isPromotedBase: model.isPromotedBase,
    notes: model.notes,
    brainConfig: model.brainConfig,
    speciesConfig: model.speciesConfig || null,
    layers,
    benchmark: model.benchmark,
    savedAtMs: Date.now(),
    firestorePath: `base_models/${model.speciesId}__${model.versionId}`,
  };

  let prunedVersionsToDelete: ModelVersionRecord[] = [];

  // Mirror to local base models cache and enforce Max 10 Versions per Species
  try {
    if (typeof localStorage !== 'undefined') {
      const existingRaw = localStorage.getItem(LOCAL_BASE_MODELS_CACHE_KEY);
      const list: ModelVersionRecord[] = existingRaw ? JSON.parse(existingRaw) : [];
      const filtered = list.filter(
        (m) => !(m.speciesId === model.speciesId && m.versionId === model.versionId)
      );
      if (model.isPromotedBase) {
        filtered.forEach((m) => {
          if (m.speciesId === model.speciesId) m.isPromotedBase = false;
        });
      }
      filtered.unshift(model);

      const { keptRegistry, prunedForSpecies } = pruneSpeciesModelVersions(
        filtered,
        model.speciesId,
        MAX_VERSIONS_PER_SPECIES
      );
      prunedVersionsToDelete = prunedForSpecies;
      localStorage.setItem(LOCAL_BASE_MODELS_CACHE_KEY, JSON.stringify(keptRegistry.slice(0, 150)));
    }
  } catch {
    // ignore
  }

  try {
    const versionDocId = `${sanitizeKey(model.speciesId)}__${sanitizeKey(model.versionId)}`;
    await setDoc(doc(aiFirestore, 'base_models', versionDocId), payload, { merge: true });

    if (model.isPromotedBase) {
      const activeDocId = `active__${sanitizeKey(model.speciesId)}`;
      await setDoc(doc(aiFirestore, 'base_models', activeDocId), payload, { merge: true });
    }

    // Delete any overflow versions beyond the last 5 for this species from Firestore
    if (prunedVersionsToDelete.length > 0) {
      await Promise.allSettled(
        prunedVersionsToDelete.map((oldVer) => {
          const oldDocId = `${sanitizeKey(oldVer.speciesId)}__${sanitizeKey(oldVer.versionId)}`;
          return deleteDoc(doc(aiFirestore, 'base_models', oldDocId));
        })
      );
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Loads all trained Base Brain Models from the Firestore `base_models` collection,
 * capped at the latest 5 versions per species (and deletes any older overflow versions).
 */
export async function fetchBaseModelsFromFirestore(): Promise<ModelVersionRecord[]> {
  try {
    const snap = await getDocs(query(collection(aiFirestore, 'base_models'), limit(120)));
    let models: ModelVersionRecord[] = [];
    snap.forEach((d) => {
      if (d.id.startsWith('active__')) return; // Skip pointer duplicates in version list
      const data = d.data() as any;
      if (data && data.versionId && data.speciesId) {
        const layers: Array<{ w: number[]; b: number[] }> = data.layers || [];
        models.push({
          versionId: data.versionId,
          speciesId: data.speciesId,
          parentVersionId: data.parentVersionId || null,
          createdAtIso: data.createdAtIso || new Date().toISOString(),
          generationTrained: Number(data.generationTrained) || 1,
          isPromotedBase: Boolean(data.isPromotedBase),
          notes: data.notes || '',
          brainConfig: data.brainConfig,
          speciesConfig: data.speciesConfig || undefined,
          weights: layers.map((l) => l.w || []),
          biases: layers.map((l) => l.b || []),
          benchmark: data.benchmark,
        });
      }
    });

    // Enforce Max 5 Versions per Species across loaded models and delete any older overflow versions from Firestore
    const speciesIds = Array.from(new Set(models.map((m) => m.speciesId)));
    const allPrunedOverflow: ModelVersionRecord[] = [];
    for (const spId of speciesIds) {
      const res = pruneSpeciesModelVersions(models, spId, MAX_VERSIONS_PER_SPECIES);
      models = res.keptRegistry;
      if (res.prunedForSpecies.length > 0) {
        allPrunedOverflow.push(...res.prunedForSpecies);
      }
    }

    if (allPrunedOverflow.length > 0) {
      Promise.allSettled(
        allPrunedOverflow.map((oldVer) => {
          const oldDocId = `${sanitizeKey(oldVer.speciesId)}__${sanitizeKey(oldVer.versionId)}`;
          return deleteDoc(doc(aiFirestore, 'base_models', oldDocId));
        })
      ).catch(() => {});
    }

    if (models.length > 0 && typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCAL_BASE_MODELS_CACHE_KEY, JSON.stringify(models));
    }
    return models;
  } catch {
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(LOCAL_BASE_MODELS_CACHE_KEY);
        if (raw) return JSON.parse(raw);
      } catch {
        // ignore
      }
    }
    return [];
  }
}

// ============================================================================
// 3. USER FISH BRAINS & 24/7 DYNAMIC OFFLINE FISH KEEPER (`mypc_user_brains`)
// ============================================================================

/**
 * Marks a MyPC user as Online (in-game) or Offline (in Keeper) in Firestore
 * on session transitions (open/close/visibility change) so the 24/7 Fish Keeper
 * dynamically removes their fishes when they open the game and brings them back when they close it.
 */
export function setUserOnlineStatusInFirestore(
  username: string,
  profileId: string,
  isActivelyPlaying: boolean,
  autoFeederStock: number
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const docId = sanitizeKey(username);
        const now = Date.now();
        await setDoc(
          doc(aiFirestore, 'mypc_user_brains', docId),
          {
            username: username || 'Keeper',
            profileId: profileId || 'default',
            updatedAtMs: now,
            isActivelyPlaying,
            lastGameHeartbeatMs: isActivelyPlaying ? now : 0,
            autoFeederStock,
          },
          { merge: true }
        );
      } catch {
        // ignore transient offline
      }
      resolve();
    }, 0);
  });
}

export function serializeFishEntityToCloudBrainItem(
  f: FishEntity,
  lifespanHours = 24
): CloudUserFishBrainItem {
  return {
    fishId: f.lineage.fishId,
    name: f.lineage.name || 'Fish',
    speciesId: f.lineage.speciesId,
    generation: f.lineage.generation || 1,
    modelVersion: f.lineage.modelVersion || 'v1.0-base',
    motherId: f.lineage.motherId ?? null,
    fatherId: f.lineage.fatherId ?? null,
    alive: Boolean(f.lineage.alive),
    causeOfDeath: f.lineage.causeOfDeath ?? null,
    energy: Math.round((Number(f.state.energy) || 0) * 100) / 100,
    hunger: Math.round((Number(f.state.hunger) || 0) * 100) / 100,
    ageSimHours: Math.round((Number(f.state.ageSimHours) || 0) * 1000) / 1000,
    lifespanSimHours: lifespanHours || 24,
    // Keep a valid FishBrainInstance in memory so Trainer simulation & reproduction never fail
    brain: fromFirestoreSafeBrain(f.brain),
    foragingEfficiency:
      Math.round(
        ((f.state.metrics?.foodPelletsEaten || 0) /
          Math.max(1, f.state.metrics?.foragingAttempts || 1)) *
          1000
      ) / 10,
    lifetimeReward: Math.round((f.state.metrics?.lifetimeReward || 0) * 100) / 100,
    decisionsMade: f.state.metrics?.decisionsMade || 0,
    foodPelletsEaten: f.state.metrics?.foodPelletsEaten || 0,
    inheritedMutations: Array.isArray(f.lineage.inheritedMutations)
      ? f.lineage.inheritedMutations.slice(0, 8)
      : [],
  };
}

/**
 * Syncs AI-specific data (individual fish brains + active play status) to Firestore
 * keyed by the MyPC username (`MyPC.info().profile.name`).
 * Runs 100% asynchronously in a background macrotask so serialization and network I/O
 * never block a single animation frame!
 */
export function syncUserBrainsToFirestore(
  username: string,
  profileId: string,
  fishes: FishEntity[],
  isActivelyPlaying: boolean,
  autoFeederStock: number,
  adminOverrideOpts?: {
    adminOverrideAtMs?: number;
    lastAdminAction?: string;
    removedFishIds?: string[];
  }
): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const docId = sanitizeKey(username);
        const now = Date.now();
        _lastCloudUserFirestoreWriteMs.set(docId, now);

        const removedSet = new Set(adminOverrideOpts?.removedFishIds || []);
        const filteredFishes = fishes.filter((f) => !removedSet.has(f.lineage.fishId));

        const firestorePayload: Record<string, any> = {
          username: username || 'Keeper',
          profileId: profileId || 'default',
          updatedAtMs: now,
          isActivelyPlaying: Boolean(isActivelyPlaying),
          lastGameHeartbeatMs: isActivelyPlaying ? now : 0,
          autoFeederStock: Number(autoFeederStock || 0),
          fishBrains: filteredFishes.slice(0, 50).map((f) => {
            const item = serializeFishEntityToCloudBrainItem(f, 24);
            return {
              ...item,
              brain: toFirestoreSafeBrain(item.brain),
            };
          }),
        };

        if (adminOverrideOpts?.adminOverrideAtMs) {
          firestorePayload.adminOverrideAtMs = adminOverrideOpts.adminOverrideAtMs;
        }
        if (adminOverrideOpts?.lastAdminAction) {
          firestorePayload.lastAdminAction = adminOverrideOpts.lastAdminAction;
        }
        if (Array.isArray(adminOverrideOpts?.removedFishIds)) {
          firestorePayload.removedFishIds = adminOverrideOpts!.removedFishIds.slice(-200);
        }

        const existingSnap = await getDoc(doc(aiFirestore, 'mypc_user_brains', docId));
        if (existingSnap.exists()) {
          const existingData = existingSnap.data() as any;
          const remoteOverrideMs = Number(existingData?.adminOverrideAtMs || 0);
          const localOverrideMs = Number(adminOverrideOpts?.adminOverrideAtMs || 0);
          if (remoteOverrideMs > localOverrideMs) {
            // Do not clobber a newer Admin Override in Firestore with stale game state!
            resolve(false);
            return;
          }
        }

        const safePayload = stripUndefinedDeep(firestorePayload);
        await setDoc(doc(aiFirestore, 'mypc_user_brains', docId), safePayload, {
          merge: true,
        });
        resolve(true);
      } catch (err) {
        console.warn('[Firestore Brain Sync] Offline or restricted, using local cache:', err);
        resolve(false);
      }
    }, 0);
  });
}

/**
 * Authoritatively saves an Admin action (Kill/Starve, Revive, Reproduce, Give Fish, Replace Fish, or Remove Dead)
 * on any CloudUserBrainRecord directly to Firestore so even if the user has the game open,
 * their live game immediately receives the override via `onSnapshot` and applies it!
 */
export async function saveAdminOverrideForUserInFirestore(
  recordOrUsername: CloudUserBrainRecord | string,
  profileIdOrActionSummary?: string,
  fishBrains?: CloudUserFishBrainItem[],
  isActivelyPlaying?: boolean,
  autoFeederStock?: number,
  actionSummary?: string,
  removedFishIds?: string[]
): Promise<boolean> {
  try {
    let record: CloudUserBrainRecord;
    let summary: string;

    if (typeof recordOrUsername === 'object' && recordOrUsername !== null) {
      record = { ...recordOrUsername };
      summary =
        typeof profileIdOrActionSummary === 'string'
          ? profileIdOrActionSummary
          : 'Admin Override';
    } else {
      summary = actionSummary || 'Admin Override';
      record = {
        username: String(recordOrUsername || 'Keeper'),
        profileId:
          typeof profileIdOrActionSummary === 'string'
            ? profileIdOrActionSummary
            : 'local-caretaker',
        updatedAtMs: Date.now(),
        isActivelyPlaying: Boolean(isActivelyPlaying),
        lastGameHeartbeatMs: isActivelyPlaying ? Date.now() : 0,
        autoFeederStock: Number(autoFeederStock || 0),
        fishBrains: Array.isArray(fishBrains) ? fishBrains : [],
      };
      if (Array.isArray(removedFishIds)) {
        record.removedFishIds = removedFishIds.slice(-200);
      }
    }

    const docId = sanitizeKey(record.username);
    const now = Date.now();
    record.updatedAtMs = now;
    record.adminOverrideAtMs = now;
    record.lastAdminAction = summary;
    _lastCloudUserFirestoreWriteMs.set(docId, now);

    const removedSet = new Set(record.removedFishIds || []);
    const cleanBrains = (record.fishBrains || []).filter(
      (fb) => fb && !removedSet.has(fb.fishId)
    );

    const payload: Record<string, any> = {
      username: record.username || 'Keeper',
      profileId: record.profileId || 'local-caretaker',
      updatedAtMs: now,
      adminOverrideAtMs: now,
      lastAdminAction: summary,
      isActivelyPlaying: Boolean(record.isActivelyPlaying),
      lastGameHeartbeatMs: record.isActivelyPlaying ? Number(record.lastGameHeartbeatMs || now) : 0,
      autoFeederStock: Number(record.autoFeederStock || 0),
      fishBrains: cleanBrains.map((fb) => ({
        fishId: fb.fishId,
        name: fb.name || 'Fish',
        speciesId: fb.speciesId,
        generation: Number(fb.generation) || 1,
        modelVersion: fb.modelVersion || 'v1.0-base',
        motherId: fb.motherId ?? null,
        fatherId: fb.fatherId ?? null,
        alive: Boolean(fb.alive),
        causeOfDeath: fb.causeOfDeath ?? null,
        energy: Number(fb.energy) || 0,
        hunger: Number(fb.hunger) || 0,
        ageSimHours: Number(fb.ageSimHours) || 0.1,
        lifespanSimHours: Number(fb.lifespanSimHours) || 24,
        brain: toFirestoreSafeBrain(fb.brain),
        foragingEfficiency: Number(fb.foragingEfficiency) || 65,
        lifetimeReward: Number(fb.lifetimeReward) || 0,
        decisionsMade: Number(fb.decisionsMade) || 0,
        foodPelletsEaten: Number(fb.foodPelletsEaten) || 0,
        inheritedMutations: Array.isArray(fb.inheritedMutations)
          ? fb.inheritedMutations.slice(0, 8)
          : [],
      })),
    };
    if (Array.isArray(record.removedFishIds)) {
      payload.removedFishIds = record.removedFishIds.slice(-200);
    }

    const safePayload = stripUndefinedDeep(payload);
    await setDoc(doc(aiFirestore, 'mypc_user_brains', docId), safePayload, { merge: true });
    return true;
  } catch (err) {
    console.error('[saveAdminOverrideForUserInFirestore] Failed to write override:', err);
    return false;
  }
}

/**
 * Loads saved AI fish brains for a MyPC username from Firestore on startup so
 * any 24/7 offline evolution or admin action done while the player was away is applied.
 */
export async function loadUserBrainsFromFirestore(
  username: string
): Promise<CloudUserBrainRecord | null> {
  try {
    const docId = sanitizeKey(username);
    const snap = await getDoc(doc(aiFirestore, 'mypc_user_brains', docId));
    if (!snap.exists()) return null;
    const data = snap.data() as any;
    const removedSet = new Set<string>(
      Array.isArray(data?.removedFishIds) ? data.removedFishIds : []
    );
    return {
      ...data,
      removedFishIds: Array.from(removedSet),
      fishBrains: (data.fishBrains || [])
        .filter((fb: any) => fb && !removedSet.has(fb.fishId))
        .map((fb: any) => ({
          ...fb,
          brain: fromFirestoreSafeBrain(fb.brain),
        })),
    } as CloudUserBrainRecord;
  } catch {
    return null;
  }
}

/**
 * Real-time subscription to a SINGLE user's `mypc_user_brains/{username}` document.
 * Used by the player game (`App.tsx`) so if an Admin kills, revives, gives, reproduces, or replaces a fish
 * while the player has the game open, the player's game immediately applies the change in real time!
 */
export function subscribeToSingleUserBrainRecord(
  username: string,
  onUpdate: (record: CloudUserBrainRecord) => void
): () => void {
  try {
    const docId = sanitizeKey(username);
    return onSnapshot(
      doc(aiFirestore, 'mypc_user_brains', docId),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as any;
        const removedSet = new Set<string>(
          Array.isArray(data?.removedFishIds) ? data.removedFishIds : []
        );
        setTimeout(() => {
          onUpdate({
            ...data,
            removedFishIds: Array.from(removedSet),
            fishBrains: (data.fishBrains || [])
              .filter((fb: any) => fb && !removedSet.has(fb.fishId))
              .map((fb: any) => ({
                ...fb,
                brain: fromFirestoreSafeBrain(fb.brain),
              })),
          } as CloudUserBrainRecord);
        }, 0);
      },
      () => {
        // Ignore snapshot error when offline
      }
    );
  } catch {
    return () => {};
  }
}

/**
 * Queries all MyPC users' fish brain records for the AI Trainer's 24/7 Offline Simulation Service.
 */
export async function fetchAllUserBrainRecordsFromFirestore(): Promise<
  CloudUserBrainRecord[]
> {
  try {
    const q = query(collection(aiFirestore, 'mypc_user_brains'), limit(100));
    const snap = await getDocs(q);
    const list: CloudUserBrainRecord[] = [];
    snap.forEach((d) => {
      const data = d.data() as any;
      const removedSet = new Set<string>(Array.isArray(data?.removedFishIds) ? data.removedFishIds : []);
      list.push({
        ...data,
        removedFishIds: Array.from(removedSet),
        fishBrains: (data.fishBrains || [])
          .filter((fb: any) => fb && !removedSet.has(fb.fishId))
          .map((fb: any) => ({
            ...fb,
            brain: fromFirestoreSafeBrain(fb.brain),
          })),
      } as CloudUserBrainRecord);
    });
    return list;
  } catch {
    return [];
  }
}

/**
 * Real-time subscription to `mypc_user_brains` so the 24/7 Fish Keeper immediately
 * shows all users and their fishes, removes a user's fishes when they open the game,
 * and restores them when they leave.
 */
export function subscribeToAllUserBrainRecords(
  onUpdate: (records: CloudUserBrainRecord[]) => void
): () => void {
  try {
    const q = query(collection(aiFirestore, 'mypc_user_brains'), limit(100));
    return onSnapshot(
      q,
      (snap) => {
        const list: CloudUserBrainRecord[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          const removedSet = new Set<string>(Array.isArray(data?.removedFishIds) ? data.removedFishIds : []);
          list.push({
            ...data,
            removedFishIds: Array.from(removedSet),
            fishBrains: (data.fishBrains || [])
              .filter((fb: any) => fb && !removedSet.has(fb.fishId))
              .map((fb: any) => ({
                ...fb,
                brain: fromFirestoreSafeBrain(fb.brain),
              })),
          } as CloudUserBrainRecord);
        });
        onUpdate(list);
      },
      () => {
        // Fallback if snapshot listener errors
      }
    );
  } catch {
    return () => {};
  }
}

const _cloudSensory = new Float32Array(32);

/**
 * Steps a remote MyPC user's offline fishes in the 24/7 Trainer Offline Service.
 * To respect the 20,000 daily Firestore write quota, this function updates the user's
 * fishes in memory on every tick and ONLY writes to Firestore when:
 * 1. A fish dies of starvation or old age (`newlyStarvedNames.length > 0`), OR
 * 2. `forceWriteNow` is true, OR
 * 3. At least 4 minutes (`FIRESTORE_CHECKPOINT_INTERVAL_MS`) have elapsed since the last write for this user.
 */
export async function stepAndSyncCloudUserOfflineFishes(
  record: CloudUserBrainRecord,
  simHoursDelta: number,
  trainerAutoFeedOverride: boolean,
  forceWriteNow = false
): Promise<{
  updatedLiveCount: number;
  newlyStarvedNames: string[];
  usedOwnerAutoFeeder: boolean;
  wroteToFirestore: boolean;
}> {
  let updatedLiveCount = 0;
  const newlyStarvedNames: string[] = [];
  const ownerHasAutoFeeder = Number(record.autoFeederStock || 0) > 0;
  const effectiveFeederActive = trainerAutoFeedOverride || ownerHasAutoFeeder;

  for (const fb of record.fishBrains) {
    if (!fb.alive) continue;
    updatedLiveCount++;

    fb.ageSimHours = Number((fb.ageSimHours + simHoursDelta).toFixed(3));
    const burn = 7.2 * simHoursDelta;
    fb.energy = Math.max(0, Number((fb.energy - burn).toFixed(2)));
    fb.hunger = Number((100 - fb.energy).toFixed(2));

    // Run neural brain forward decision pass
    _cloudSensory.fill(0);
    _cloudSensory[0] = Math.sin(fb.ageSimHours * 5);
    _cloudSensory[2] = Math.cos(fb.ageSimHours * 5);
    _cloudSensory[3] = effectiveFeederActive ? 0.75 : 0.0;
    _cloudSensory[7] = fb.hunger / 100;
    _cloudSensory[8] = fb.energy / 100;

    forwardFishBrain(fb.brain, _cloudSensory, 0.05);
    fb.decisionsMade = (fb.decisionsMade || 0) + 1;

    // If trainer override feeder OR owner's own auto-feeder is active, hungry fish eats & learns
    if (effectiveFeederActive && fb.hunger > 28) {
      fb.energy = Math.min(100, Number((fb.energy + 22 * simHoursDelta * 4).toFixed(2)));
      fb.hunger = Number((100 - fb.energy).toFixed(2));
      fb.foodPelletsEaten = (fb.foodPelletsEaten || 0) + 1;
      fb.lifetimeReward = Number(((fb.lifetimeReward || 0) + 0.35).toFixed(2));
      applyFishLifetimeLearning(fb.brain, 0.35, DEFAULT_BRAIN_CONFIG);
    }

    // Check starvation or old age death
    if (fb.energy <= 0.05) {
      fb.alive = false;
      fb.energy = 0;
      fb.hunger = 100;
      fb.causeOfDeath = 'starvation';
      newlyStarvedNames.push(`${fb.name} (${record.username})`);
    } else if (fb.ageSimHours >= (fb.lifespanSimHours || 24)) {
      fb.alive = false;
      fb.causeOfDeath = 'old_age';
      newlyStarvedNames.push(`${fb.name} (${record.username})`);
    }
  }

  const docId = sanitizeKey(record.username);
  const now = Date.now();
  const lastWrite = _lastCloudUserFirestoreWriteMs.get(docId) || 0;
  const shouldWriteToFirestore =
    forceWriteNow ||
    newlyStarvedNames.length > 0 ||
    (updatedLiveCount > 0 && now - lastWrite >= FIRESTORE_CHECKPOINT_INTERVAL_MS);

  let wroteToFirestore = false;
  if (shouldWriteToFirestore) {
    _lastCloudUserFirestoreWriteMs.set(docId, now);
    try {
      const existingSnap = await getDoc(doc(aiFirestore, 'mypc_user_brains', docId));
      if (existingSnap.exists()) {
        const existingData = existingSnap.data() as any;
        const remoteOverrideMs = Number(existingData?.adminOverrideAtMs || 0);
        const localOverrideMs = Number(record.adminOverrideAtMs || 0);
        if (remoteOverrideMs > localOverrideMs) {
          return {
            updatedLiveCount,
            newlyStarvedNames,
            usedOwnerAutoFeeder: !trainerAutoFeedOverride && ownerHasAutoFeeder,
            wroteToFirestore: false,
          };
        }
      }

      const safePayload = stripUndefinedDeep({
        ...record,
        updatedAtMs: now,
        fishBrains: record.fishBrains.map((fb) => ({
          ...fb,
          brain: toFirestoreSafeBrain(fb.brain),
        })),
      });
      await setDoc(doc(aiFirestore, 'mypc_user_brains', docId), safePayload, {
        merge: true,
      });
      wroteToFirestore = true;
    } catch {
      // ignore transient offline
    }
  }

  return {
    updatedLiveCount,
    newlyStarvedNames,
    usedOwnerAutoFeeder: !trainerAutoFeedOverride && ownerHasAutoFeeder,
    wroteToFirestore,
  };
}

/**
 * Resets all user fish brain records in Firestore (`mypc_user_brains`) while keeping
 * `base_models` and `admins` untouched.
 */
export async function resetAllUserFishesInFirestore(
  username: string,
  profileId: string,
  freshFishes: FishEntity[],
  autoFeederStock: number
): Promise<boolean> {
  try {
    const q = query(collection(aiFirestore, 'mypc_user_brains'), limit(100));
    const snap = await getDocs(q);
    const primaryDocId = sanitizeKey(username);
    const deletePromises: Promise<void>[] = [];
    snap.forEach((d) => {
      if (d.id !== primaryDocId) {
        deletePromises.push(deleteDoc(doc(aiFirestore, 'mypc_user_brains', d.id)));
      }
    });
    if (deletePromises.length > 0) {
      await Promise.allSettled(deletePromises);
    }
    return await syncUserBrainsToFirestore(
      username,
      profileId,
      freshFishes,
      false,
      autoFeederStock,
      {
        adminOverrideAtMs: Date.now(),
        lastAdminAction: 'Reset all fishes to fresh Gen 1 starters',
      }
    );
  } catch {
    return false;
  }
}

/**
 * Saves an AI Trainer benchmark/experiment report to Firestore (`mypc_ai_experiments`).
 */
export async function saveExperimentToFirestore(
  username: string,
  experiment: ExperimentComparisonResult
): Promise<boolean> {
  try {
    const docId = `${sanitizeKey(username)}_${experiment.id}`;
    await setDoc(doc(aiFirestore, 'mypc_ai_experiments', docId), {
      username,
      ...experiment,
      savedAtMs: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}


