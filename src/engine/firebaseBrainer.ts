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
  isActivelyPlaying: boolean;
  lastGameHeartbeatMs: number;
  autoFeederStock: number;
  fishBrains: CloudUserFishBrainItem[];
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

export function toFirestoreSafeBrain(brain: FishBrainInstance): FirestoreSafeBrain {
  const layers = brain.inheritedWeights.map((iw, idx) => ({
    iw: iw.map((n) => Number(n.toFixed(4))),
    ib: (brain.inheritedBiases[idx] || []).map((n) => Number(n.toFixed(4))),
    dw: (brain.learnedDeltaWeights[idx] || []).map((n) => Number(n.toFixed(4))),
    db: (brain.learnedDeltaBiases[idx] || []).map((n) => Number(n.toFixed(4))),
  }));
  return {
    architecture: { ...brain.architecture },
    layers,
    recurrentState: brain.recurrentState.map((n) => Number(n.toFixed(4))),
    attentionGates: brain.attentionGates.map((n) => Number(n.toFixed(4))),
    lastInputs: brain.lastInputs.map((n) => Number(n.toFixed(4))),
    lastOutputs: brain.lastOutputs.map((n) => Number(n.toFixed(4))),
  };
}

export function fromFirestoreSafeBrain(raw: any): FishBrainInstance {
  if (raw && Array.isArray(raw.inheritedWeights)) {
    return raw as FishBrainInstance;
  }
  const layers: Array<{ iw: number[]; ib: number[]; dw: number[]; db: number[] }> =
    raw?.layers || [];
  return {
    architecture: raw?.architecture || {
      inputCount: 10,
      hiddenLayers: [16, 12],
      outputCount: 4,
      activation: 'tanh',
      recurrentMemoryEnabled: true,
      attentionModuleEnabled: true,
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
 * Saves a trained or active Base Brain Model to the `base_models` collection in Firestore (`aquarium-caa2b`)
 * as well as `mypc_ai_models`, and mirrors it to local storage so both the Trainer and the Game can read it immediately.
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
    w: w.map((n) => Number(n.toFixed(4))),
    b: (model.biases[idx] || []).map((n) => Number(n.toFixed(4))),
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

  // Mirror to local base models cache
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
      localStorage.setItem(LOCAL_BASE_MODELS_CACHE_KEY, JSON.stringify(filtered.slice(0, 65)));
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
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads all trained Base Brain Models from the Firestore `base_models` collection.
 */
export async function fetchBaseModelsFromFirestore(): Promise<ModelVersionRecord[]> {
  try {
    const snap = await getDocs(query(collection(aiFirestore, 'base_models'), limit(80)));
    const models: ModelVersionRecord[] = [];
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
 * Immediately marks a MyPC user as Online (in-game) or Offline (in Keeper) in Firestore
 * so the 24/7 Fish Keeper dynamically removes their fishes when they open the game
 * and brings them back when they close the game.
 */
export async function setUserOnlineStatusInFirestore(
  username: string,
  profileId: string,
  isActivelyPlaying: boolean,
  autoFeederStock: number
): Promise<void> {
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
}

/**
 * Syncs AI-specific data (individual fish brains + active play heartbeat) to Firestore
 * keyed by the MyPC username (`MyPC.info().profile.name`), while game progress/items
 * remain in `MyPC.save`.
 */
export async function syncUserBrainsToFirestore(
  username: string,
  profileId: string,
  fishes: FishEntity[],
  isActivelyPlaying: boolean,
  autoFeederStock: number
): Promise<boolean> {
  try {
    const docId = sanitizeKey(username);
    const now = Date.now();
    const firestorePayload = {
      username: username || 'Keeper',
      profileId: profileId || 'default',
      updatedAtMs: now,
      isActivelyPlaying,
      lastGameHeartbeatMs: isActivelyPlaying ? now : 0,
      autoFeederStock,
      fishBrains: fishes.slice(0, 40).map((f) => ({
        fishId: f.lineage.fishId,
        name: f.lineage.name,
        speciesId: f.lineage.speciesId,
        generation: f.lineage.generation,
        modelVersion: f.lineage.modelVersion,
        motherId: f.lineage.motherId,
        fatherId: f.lineage.fatherId,
        alive: f.lineage.alive,
        causeOfDeath: f.lineage.causeOfDeath,
        energy: Number(f.state.energy.toFixed(2)),
        hunger: Number(f.state.hunger.toFixed(2)),
        ageSimHours: Number(f.state.ageSimHours.toFixed(3)),
        lifespanSimHours: 24,
        brain: toFirestoreSafeBrain(f.brain),
        foragingEfficiency: Number(
          (
            (f.state.metrics.foodPelletsEaten /
              Math.max(1, f.state.metrics.foragingAttempts)) *
            100
          ).toFixed(1)
        ),
        lifetimeReward: Number(f.state.metrics.lifetimeReward.toFixed(2)),
        decisionsMade: f.state.metrics.decisionsMade,
        foodPelletsEaten: f.state.metrics.foodPelletsEaten,
        inheritedMutations: f.lineage.inheritedMutations.slice(0, 8),
      })),
    };

    await setDoc(doc(aiFirestore, 'mypc_user_brains', docId), firestorePayload, {
      merge: true,
    });
    return true;
  } catch (err) {
    console.warn('[Firestore Brain Sync] Offline or restricted, using local cache:', err);
    return false;
  }
}

/**
 * Loads saved AI fish brains for a MyPC username from Firestore on startup so
 * any 24/7 offline evolution or training done while the player was away is applied
 * to their fishes.
 */
export async function loadUserBrainsFromFirestore(
  username: string
): Promise<CloudUserBrainRecord | null> {
  try {
    const docId = sanitizeKey(username);
    const snap = await getDoc(doc(aiFirestore, 'mypc_user_brains', docId));
    if (!snap.exists()) return null;
    const data = snap.data() as any;
    return {
      ...data,
      fishBrains: (data.fishBrains || []).map((fb: any) => ({
        ...fb,
        brain: fromFirestoreSafeBrain(fb.brain),
      })),
    } as CloudUserBrainRecord;
  } catch {
    return null;
  }
}

/**
 * Queries all MyPC users' fish brain records for the AI Trainer's 24/7 Offline Simulation Service.
 */
export async function fetchAllUserBrainRecordsFromFirestore(): Promise<
  CloudUserBrainRecord[]
> {
  try {
    const q = query(collection(aiFirestore, 'mypc_user_brains'), limit(25));
    const snap = await getDocs(q);
    const list: CloudUserBrainRecord[] = [];
    snap.forEach((d) => {
      const data = d.data() as any;
      list.push({
        ...data,
        fishBrains: (data.fishBrains || []).map((fb: any) => ({
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
 * removes a user's fishes when they open the game and restores them when they leave.
 */
export function subscribeToAllUserBrainRecords(
  onUpdate: (records: CloudUserBrainRecord[]) => void
): () => void {
  try {
    const q = query(collection(aiFirestore, 'mypc_user_brains'), limit(25));
    return onSnapshot(
      q,
      (snap) => {
        const list: CloudUserBrainRecord[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          list.push({
            ...data,
            fishBrains: (data.fishBrains || []).map((fb: any) => ({
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
 * Steps a remote MyPC user's offline fishes in the 24/7 Trainer Offline Service and persists
 * updated brains, energy, hunger, and starvation status back to Firestore (`mypc_user_brains`).
 *
 * When `trainerAutoFeedOverride` is disabled (`false`), the Keeper checks the owner's own
 * auto-feeder (`record.autoFeederStock > 0`) so fishes whose owner installed an auto-feeder
 * are still fed automatically using the owner's feeder!
 */
export async function stepAndSyncCloudUserOfflineFishes(
  record: CloudUserBrainRecord,
  simHoursDelta: number,
  trainerAutoFeedOverride: boolean
): Promise<{
  updatedLiveCount: number;
  newlyStarvedNames: string[];
  usedOwnerAutoFeeder: boolean;
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
    }
  }

  try {
    const docId = sanitizeKey(record.username);
    await setDoc(
      doc(aiFirestore, 'mypc_user_brains', docId),
      {
        ...record,
        updatedAtMs: Date.now(),
        fishBrains: record.fishBrains.map((fb) => ({
          ...fb,
          brain: toFirestoreSafeBrain(fb.brain),
        })),
      },
      { merge: true }
    );
  } catch {
    // ignore transient offline
  }

  return {
    updatedLiveCount,
    newlyStarvedNames,
    usedOwnerAutoFeeder: !trainerAutoFeedOverride && ownerHasAutoFeeder,
  };
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
