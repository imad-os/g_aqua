import React, { useEffect, useRef, useState } from 'react';
import {
  createBaseBrainInstance,
  validateAndEstimateBrain,
} from '../engine/brain';
import {
  DEFAULT_BRAIN_CONFIG,
  DEFAULT_SPECIES_LIST,
  TANK_TIERS,
} from '../engine/defaults';
import {
  createSpeciesConfigFromFamousFish,
  FAMOUS_AQUARIUM_FISHES_50,
  FamousAquariumFishTemplate,
} from '../engine/famousFishCatalog';
import {
  addAdminToFirestore,
  CloudUserBrainRecord,
  fetchAdminsFromFirestore,
  fetchAllUserBrainRecordsFromFirestore,
  fetchBaseModelsFromFirestore,
  FIRESTORE_CHECKPOINT_INTERVAL_MS,
  MAX_VERSIONS_PER_SPECIES,
  pruneSpeciesModelVersions,
  removeAdminFromFirestore,
  resetAllUserFishesInFirestore,
  saveAdminOverrideForUserInFirestore,
  saveExperimentToFirestore,
  saveModelVersionToFirestore,
  serializeFishEntityToCloudBrainItem,
  signInWithGmailPopup,
  signOutAdminUser,
  sortSpeciesModelVersionsNewestFirst,
  stepAndSyncCloudUserOfflineFishes,
  subscribeToAllUserBrainRecords,
  subscribeToFirebaseAuth,
  syncUserBrainsToFirestore,
  UserFishBrainItem,
  verifyAdminInFirestoreCollection,
} from '../engine/firebaseBrainer';
import { getMyPC } from '../engine/mypc';
import {
  evaluateBrainOnBenchmarks,
  reproduceOffspringFish,
  runAcceleratedHeadlessTraining,
  runControlledExperiment,
  spawnFoundingFish,
  stepEcosystemSimulation,
} from '../engine/simulation';
import {
  getActiveGameSessionTankIds,
  isForceOfflineOverrideActive,
  loadEcosystemState,
  publishActiveGameSessionLease,
  resetFishesKeepBaseModels,
  saveEcosystemState,
  setForceOfflineOverride,
} from '../engine/storage';
import {
  ActivationType,
  AdminUserRecord,
  FishBrainInstance,
  FishEntity,
  FoodPellet,
  ModelVersionRecord,
  OfflineServiceTelemetry,
  SavedEcosystemState,
  SpeciesConfig,
} from '../engine/types';
import {
  FISH_3D_MODELS_CATALOG,
  FishModelPreview3D,
} from './AquariumCanvas3D';

export type TrainerTabId =
  | 'train_models'
  | 'offline_service'
  | 'species_editor'
  | 'brain_lab'
  | 'evolution_lab'
  | 'models_3d';

interface TrainerHelpItem {
  title: string;
  explanation: string;
  example: string;
}

const TRAINER_HELP: Record<string, TrainerHelpItem> = {
  where_base_model_saved: {
    title: 'Where Are Base Models & Species Saved?',
    explanation:
      'Every trained Base Brain Model and edited Species configuration is saved in your Firebase Firestore database (project: "aquarium-caa2b") inside the "base_models" collection. Each fish type and version gets its own document (for example: base_models/neon-tetra__v1.2-G100), plus an active pointer document (base_models/active__neon-tetra) so the main 3D Aquarium game automatically loads both the promoted neural brain and your edited lifespan/species properties.',
    example:
      'When you edit a species’ Lifespan Hours or train 250 generations and click "Save / Promote", all fishes of that species in the game use those updated settings.',
  },
  cpu_usage_limit: {
    title: 'CPU Usage Limit (10% to Max)',
    explanation:
      'Controls how much of your PC or phone processor is used while training AI models (even across 500 or 1,000 generations) or running the 24/7 Offline Fish Keeper. At 10%–25%, the trainer works in micro-slices and sleeps in between so your computer stays cool and responsive for daily work.',
    example:
      'Set CPU Usage to 15%–25% when working on your PC, or slide it to 100% Max when you want a 1,000-generation run to finish at top speed.',
  },
  training_focus: {
    title: 'Extended Multi-Generation Training (5 to 1,000+ Generations)',
    explanation:
      'Simulates entire generations of fishes foraging, evading hazards, and passing their neural weights and lifetime Hebbian learning to offspring. You can run quick 5–30 generation passes or deep 100, 250, 500, or 1,000+ generation evolutionary runs.',
    example:
      'Pick 100 or 250 Generations with "Fast Food Finder" to evolve highly accurate surface-feeding reflexes.',
  },
  offline_24_7_service: {
    title: 'Dynamic 24/7 Fish Keeper & Owner Auto-Feeder Check',
    explanation:
      'Fishes live 24/7. When a player opens the aquarium game, their fishes are dynamically REMOVED from this Keeper so they live exclusively inside the player’s active game. The moment the player closes the game, their fishes dynamically RETURN here! Furthermore, when the Keeper Override Auto-Feeder is disabled, the Keeper checks each owner’s own Auto-Feeder from their tank—feeding their fishes if the owner installed a feeder.',
    example:
      'Turn OFF "Trainer Global Override Auto-Feeder" to let each owner’s own purchased Auto-Feeder take responsibility for feeding their offline fishes.',
  },
  species_property_editor: {
    title: 'Base Model Property Editor & 50 Famous Aquarium Fishes',
    explanation:
      'Allows you to edit any biological property of an existing species (Lifespan Hours, Maturity Age, Reproduction Interval, Metabolism Burn, Required Owner Level, Shop Price, 3D Body Style, and Colors) or pick from a curated catalog of 50 world-famous aquarium fishes with realistic traits.',
    example:
      'Select "Royal Turquoise Discus" or "Ocellaris Clownfish" from the 50 Famous Fishes catalog, customize its lifespan to 48 hours, and save it to Firestore.',
  },
  brain_architecture_lab: {
    title: 'Neural Brain Architecture Lab',
    explanation:
      'Configures the deep neural network inside each fish: sensory input channels, hidden layer neuron counts, activation functions (Tanh, ReLU, Leaky ReLU, Sigmoid), recurrent spatial memory, attention gates, and Hebbian lifetime learning rates.',
    example:
      'Use hidden layers [24, 16] with Recurrent Memory enabled for species that need strong spatial memory of feeding zones.',
  },
  evolution_and_ab_lab: {
    title: 'Evolution Rules, Lineage Inspector & Controlled A/B Experiments',
    explanation:
      'Tune mutation probabilities, maternal vs. paternal brain crossover, and environmental pressures. Run side-by-side A/B Experiments comparing your current Control base model against a mutated Variant across 7 observable benchmarks, or export/import models as JSON.',
    example:
      'Run a Controlled A/B Trial before promoting a new model to verify that Foraging Efficiency and Harm Avoidance improved.',
  },
  admins_collection: {
    title: 'Gmail Authentication & Firestore "admins" Collection',
    explanation:
      'This Trainer App is a standalone back-office studio for administrators only. When you sign in with Google (Gmail), the app verifies your email against the "admins" collection in your Firestore database (aquarium-caa2b).',
    example:
      'Add trusted team members’ Gmail addresses in the Admins panel so they can also train models and monitor the 24/7 Fish Keeper.',
  },
};

export const TrainerApp: React.FC = () => {
  const mypc = getMyPC();
  const profileName = mypc.info()?.profile?.name || 'Keeper';
  const profileId = mypc.info()?.profile?.id || 'local-caretaker';

  // ============================================================================
  // 1. GMAIL ADMIN AUTHENTICATION STATE (`admins` COLLECTION IN FIRESTORE)
  // ============================================================================
  const [adminUser, setAdminUser] = useState<AdminUserRecord | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [adminsList, setAdminsList] = useState<AdminUserRecord[]>([]);
  const [manualVerifyEmail, setManualVerifyEmail] = useState<string>('elkholtiimad@gmail.com');
  const [newAdminEmailInput, setNewAdminEmailInput] = useState<string>('');
  const [newAdminNameInput, setNewAdminNameInput] = useState<string>('');

  // Help Modal State ("?" Button)
  const [activeHelp, setActiveHelp] = useState<TrainerHelpItem | null>(null);

  // Main Navigation Tab (5 Restored Studio Tabs)
  const [activeTab, setActiveTab] = useState<TrainerTabId>('train_models');

  const [ecosystem, setEcosystem] = useState<SavedEcosystemState>(() =>
    loadEcosystemState()
  );
  const ecosystemRef = useRef<SavedEcosystemState>(ecosystem);
  ecosystemRef.current = ecosystem;

  // CPU Usage Throttling State (10% -> 100% Max)
  const [cpuUsageLimitPct, setCpuUsageLimitPct] = useState<number>(25);

  // Tab 1: Train Base Models State (Extended Generations up to 1,000+ & Multi-Species Batch Loop)
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<string>(
    ecosystem.speciesList[0]?.id || DEFAULT_SPECIES_LIST[0].id
  );
  const [batchSelectedSpeciesIds, setBatchSelectedSpeciesIds] = useState<string[]>(() => [
    ecosystem.speciesList[0]?.id || DEFAULT_SPECIES_LIST[0].id,
  ]);
  const [batchCurrentIndex, setBatchCurrentIndex] = useState<number>(0);
  const [batchTotalCount, setBatchTotalCount] = useState<number>(1);
  const [batchCurrentSpeciesName, setBatchCurrentSpeciesName] = useState<string>('');
  const [trainingGoal, setTrainingGoal] = useState<'forager' | 'survivor' | 'balanced'>('balanced');
  const [trainGenerations, setTrainGenerations] = useState<number>(50);
  const [trainPopulationSize, setTrainPopulationSize] = useState<number>(28);
  const [isTrainingNow, setIsTrainingNow] = useState<boolean>(false);
  const [trainingProgressGen, setTrainingProgressGen] = useState<number>(0);
  const [lastTrainingSummary, setLastTrainingSummary] = useState<string | null>(null);
  const cancelTrainingRef = useRef<boolean>(false);

  // Tab 2: 24/7 Dynamic Offline Fish Keeper Service State
  // Default time speed is 1x, and default feeder is the fish's Owner Feeder (trainerOverrideFeederEnabled = false)
  const [serviceRunning, setServiceRunning] = useState<boolean>(true);
  const [visualModeEnabled, setVisualModeEnabled] = useState<boolean>(false);
  const [serviceSpeed, setServiceSpeed] = useState<number>(1);
  // When false (default), Keeper checks and uses the owner's own auto-feeder!
  const [trainerOverrideFeederEnabled, setTrainerOverrideFeederEnabled] = useState<boolean>(false);
  const [disableAllFeedersInKeeper, setDisableAllFeedersInKeeper] = useState<boolean>(false);
  const [selectedFishId, setSelectedFishId] = useState<string | null>(
    () => ecosystem.fishes[0]?.lineage.fishId || null
  );
  const [selectedFishOwnerUsername, setSelectedFishOwnerUsername] = useState<string>(profileName);
  const [selectedKeeperUserFilter, setSelectedKeeperUserFilter] = useState<string>('ALL');
  const [fishListFilter, setFishListFilter] = useState<'all' | 'offline' | 'dead'>('all');
  const [cloudUsers, setCloudUsers] = useState<CloudUserBrainRecord[]>([]);
  const [giftTargetUsername, setGiftTargetUsername] = useState<string>(profileName);
  const [giftSpeciesId, setGiftSpeciesId] = useState<string>(
    () => ecosystem.speciesList[0]?.id || DEFAULT_SPECIES_LIST[0].id
  );
  const [giftQuantity, setGiftQuantity] = useState<number>(1);
  const [replaceSpeciesId, setReplaceSpeciesId] = useState<string>(
    () => ecosystem.speciesList[0]?.id || DEFAULT_SPECIES_LIST[0].id
  );
  const [activeSessionTankIds, setActiveSessionTankIds] = useState<string[]>(() =>
    getActiveGameSessionTankIds()
  );
  const [firestoreSyncStatus, setFirestoreSyncStatus] = useState<string>(
    'Connected to Firestore (aquarium-caa2b)'
  );
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const lastKeeperFirestoreSyncMsRef = useRef<number>(0);
  const cloudUsersRef = useRef<CloudUserBrainRecord[]>(cloudUsers);
  cloudUsersRef.current = cloudUsers;
  const lastAdminWriteByUserMsRef = useRef<Record<string, number>>({});
  const hasAutoSelectedRealUserRef = useRef<boolean>(false);

  const pelletsRef = useRef<FoodPellet[]>([]);
  const threatsRef = useRef([]);
  const cursorPosRef = useRef({ x: 0, y: 0, z: 0 });
  const cameraOrbitRef = useRef({ yaw: 0.2, pitch: 0.1, zoom: 1.0 });

  const [serviceStats, setServiceStats] = useState<OfflineServiceTelemetry>({
    running: true,
    visualModeEnabled: false,
    speedMultiplier: 1,
    cpuUsageLimitPct: 25,
    activeInGameTankIds: [],
    offlineLiveFishCount: 0,
    offlineDeceasedFishCount: 0,
    skippedActivePlayFishCount: 0,
    totalBrainUpdatesExecuted: 0,
    ticksPerSecond: 1,
    simHoursElapsedInService: 0,
    autoFeederEnabledInService: false,
    lastDeathEvent: null,
  });

  // Tab 3: Base Model Property Editor & 50 Famous Aquarium Fishes Catalog State
  const [catalogSearch, setCatalogSearch] = useState<string>('');
  const [catalogCategory, setCatalogCategory] = useState<
    'all' | 'freshwater' | 'marine' | 'cichlid' | 'specialty'
  >('all');

  // Tab 4: Brain Architecture Lab State
  const [hiddenLayersText, setHiddenLayersText] = useState<string>('16, 12');

  // Tab 5: Evolution, Lineage, A/B Experiments & JSON Import/Export State
  const [experimentNameInput, setExperimentNameInput] = useState<string>(
    'Foraging & Surface Reflex A/B Trial'
  );
  const [jsonExportText, setJsonExportText] = useState<string>('');

  // Tab 6: 3D Models Catalog Studio State
  const [selectedCatalogModelId, setSelectedCatalogModelId] = useState<SpeciesConfig['bodyStyle']>(
    () => ecosystem.speciesList[0]?.bodyStyle || 'fusiform_reef'
  );
  const [catalogColorMode, setCatalogColorMode] = useState<'default' | 'species'>('default');

  const selectedSpecies =
    ecosystem.speciesList.find((s) => s.id === selectedSpeciesId) ||
    ecosystem.speciesList[0];

  // Sync hiddenLayersText when selectedSpecies changes
  useEffect(() => {
    if (selectedSpecies?.baseBrainConfig?.hiddenLayers) {
      setHiddenLayersText(selectedSpecies.baseBrainConfig.hiddenLayers.join(', '));
    }
  }, [selectedSpecies?.id]);

  // Check Firebase Auth & Subscribe to real-time `mypc_user_brains` + `base_models`
  useEffect(() => {
    let mounted = true;

    const savedAdminRaw =
      typeof sessionStorage !== 'undefined'
        ? sessionStorage.getItem('abyssal_evo_verified_admin')
        : null;
    if (savedAdminRaw) {
      try {
        const parsed = JSON.parse(savedAdminRaw) as AdminUserRecord;
        if (parsed && parsed.email) {
          setAdminUser(parsed);
        }
      } catch {
        // ignore
      }
    }

    fetchAdminsFromFirestore().then((list) => {
      if (mounted) setAdminsList(list);
    });

    fetchBaseModelsFromFirestore().then((cloudModels) => {
      if (!mounted || cloudModels.length === 0) return;
      const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
      for (const cm of cloudModels) {
        if (cm.speciesConfig) {
          const spIdx = next.speciesList.findIndex((s) => s.id === cm.speciesConfig!.id);
          if (spIdx >= 0) {
            next.speciesList[spIdx] = {
              ...next.speciesList[spIdx],
              ...cm.speciesConfig,
            };
          } else {
            next.speciesList.push(cm.speciesConfig);
          }
        }
        const exists = next.modelRegistry.some(
          (m) => m.speciesId === cm.speciesId && m.versionId === cm.versionId
        );
        if (!exists) {
          next.modelRegistry.push(cm);
        }
      }
      // Enforce max 5 saved versions per species, sorted newest first
      for (const sp of next.speciesList) {
        const pruneRes = pruneSpeciesModelVersions(
          next.modelRegistry,
          sp.id,
          MAX_VERSIONS_PER_SPECIES
        );
        next.modelRegistry = pruneRes.keptRegistry;
      }
      saveEcosystemState(next);
      ecosystemRef.current = next;
      setEcosystem(next);
    });

    const mergeIncomingCloudUsersWithAdminProtection = (
      incoming: CloudUserBrainRecord[]
    ): CloudUserBrainRecord[] => {
      const now = Date.now();
      const currentList = cloudUsersRef.current;
      const merged = incoming.map((inc) => {
        const lastAdminMs = lastAdminWriteByUserMsRef.current[inc.username] || 0;
        if (now - lastAdminMs < 15000 && (inc.adminOverrideAtMs || 0) < lastAdminMs) {
          const localProtected = currentList.find((c) => c.username === inc.username);
          if (localProtected) return localProtected;
        }
        return inc;
      });
      // Also preserve any brand-new user created by Admin Gift within the last 15s
      for (const cur of currentList) {
        const lastAdminMs = lastAdminWriteByUserMsRef.current[cur.username] || 0;
        if (now - lastAdminMs < 15000 && !merged.some((m) => m.username === cur.username)) {
          merged.unshift(cur);
        }
      }
      return merged;
    };

    const syncLocalOwnerFromCloudRecords = (records: CloudUserBrainRecord[]) => {
      // Auto-select the first real non-Keeper user if one exists in Firestore so Admin gifts target the real player by default
      if (!hasAutoSelectedRealUserRef.current && records.length > 0) {
        const activeNonDefaultUser =
          records.find((r) => r.username !== profileName && r.isActivelyPlaying) ||
          records.find((r) => r.username !== profileName);
        if (activeNonDefaultUser) {
          hasAutoSelectedRealUserRef.current = true;
          setGiftTargetUsername(activeNonDefaultUser.username);
          setSelectedFishOwnerUsername(activeNonDefaultUser.username);
          if (activeNonDefaultUser.fishBrains[0]) {
            setSelectedFishId(activeNonDefaultUser.fishBrains[0].fishId);
          }
        }
      }

      const myRecord = records.find((r) => r.username === profileName);
      if (!myRecord) return;

      const lastAdminMs = lastAdminWriteByUserMsRef.current[profileName] || 0;
      if (
        Date.now() - lastAdminMs < 15000 &&
        (myRecord.adminOverrideAtMs || 0) < lastAdminMs
      ) {
        // Protect recent local Admin override from being reverted by an older snapshot
        return;
      }

      const eco = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
      const removedSet = new Set<string>([
        ...(eco.removedFishIds || []),
        ...(myRecord.removedFishIds || []),
      ]);
      const cloudFishMap = new Map(myRecord.fishBrains.map((b) => [b.fishId, b]));
      let changed = false;

      if (removedSet.size !== (eco.removedFishIds || []).length) {
        eco.removedFishIds = Array.from(removedSet).slice(-200);
        changed = true;
      }

      const prevCount = eco.fishes.length;
      const prevArchCount = eco.deceasedArchive.length;

      // Remove any fish explicitly in removedFishIds OR any local dead fish that was already cleared in Firestore
      eco.fishes = eco.fishes.filter((f) => {
        if (removedSet.has(f.lineage.fishId)) return false;
        if (!f.lineage.alive && !cloudFishMap.has(f.lineage.fishId)) return false;
        return true;
      });
      eco.deceasedArchive = eco.deceasedArchive.filter(
        (d) => !removedSet.has(d.fishId) && cloudFishMap.has(d.fishId)
      );

      if (eco.fishes.length !== prevCount || eco.deceasedArchive.length !== prevArchCount) {
        changed = true;
      }

      // Sync custom player-assigned fish names [name123] and status from Firestore into local Trainer state
      for (const f of eco.fishes) {
        const cb = cloudFishMap.get(f.lineage.fishId);
        if (cb) {
          if (cb.name && cb.name !== f.lineage.name) {
            f.lineage.name = cb.name;
            changed = true;
          }
          if (cb.speciesId && cb.speciesId !== f.lineage.speciesId) {
            f.lineage.speciesId = cb.speciesId;
            changed = true;
          }
        }
      }

      // Also add any new fishes born or bought in the player's game for `profileName`
      const localIds = new Set(eco.fishes.map((f) => f.lineage.fishId));
      for (const cb of myRecord.fishBrains) {
        if (removedSet.has(cb.fishId) || localIds.has(cb.fishId)) continue;
        let sp = eco.speciesList.find((s) => s.id === cb.speciesId);
        if (!sp) {
          const famousTpl = FAMOUS_AQUARIUM_FISHES_50.find((ft) => ft.id === cb.speciesId);
          if (famousTpl) {
            sp = createSpeciesConfigFromFamousFish(famousTpl);
            eco.speciesList.push(sp);
          } else {
            sp = eco.speciesList[0] || DEFAULT_SPECIES_LIST[0];
          }
        }
        const spawned = spawnFoundingFish(
          sp,
          eco.activeTankTier,
          eco.simHoursTotal,
          eco.fishes.length,
          cb.brain
        );
        spawned.lineage.fishId = cb.fishId;
        spawned.lineage.name = cb.name || spawned.lineage.name;
        spawned.lineage.speciesId = sp.id;
        spawned.lineage.generation = cb.generation || 1;
        spawned.lineage.alive = Boolean(cb.alive);
        spawned.lineage.causeOfDeath = (cb.causeOfDeath as FishEntity['lineage']['causeOfDeath']) || null;
        spawned.state.energy = cb.energy ?? 85;
        spawned.state.hunger = cb.hunger ?? 15;
        spawned.state.ageSimHours = cb.ageSimHours ?? 0.5;
        eco.fishes.push(spawned);
        changed = true;
      }

      if ((myRecord.adminOverrideAtMs || 0) > (eco.adminOverrideAtMs || 0)) {
        eco.adminOverrideAtMs = myRecord.adminOverrideAtMs;
        eco.lastAdminAction = myRecord.lastAdminAction;
        changed = true;
      }

      if (changed) {
        saveEcosystemState(eco);
        ecosystemRef.current = eco;
        setEcosystem(eco);
      }
    };

    fetchAllUserBrainRecordsFromFirestore().then((records) => {
      if (mounted && records.length > 0) {
        const merged = mergeIncomingCloudUsersWithAdminProtection(records);
        syncLocalOwnerFromCloudRecords(merged);
        cloudUsersRef.current = merged;
        setCloudUsers(merged);
      }
    });

    // Real-time Firestore listener so when a user opens or closes the game, Keeper updates immediately
    const unsubCloudUsers = subscribeToAllUserBrainRecords((records) => {
      if (mounted) {
        const merged = mergeIncomingCloudUsersWithAdminProtection(records);
        syncLocalOwnerFromCloudRecords(merged);
        cloudUsersRef.current = merged;
        setCloudUsers(merged);
      }
    });

    // Real-time storage listener for instant cross-tab hand-off when user opens/closes index.html
    const handleStorageChange = () => {
      if (!mounted) return;
      setActiveSessionTankIds(getActiveGameSessionTankIds());
      const lastAdminMs = lastAdminWriteByUserMsRef.current[profileName] || 0;
      if (Date.now() - lastAdminMs < 15000) {
        // Never allow a background game tab storage write to revert a recent Trainer Admin action!
        return;
      }
      const freshEco = loadEcosystemState();
      if ((freshEco.adminOverrideAtMs || 0) < (ecosystemRef.current.adminOverrideAtMs || 0)) {
        return;
      }
      ecosystemRef.current = freshEco;
      setEcosystem(freshEco);
    };
    window.addEventListener('storage', handleStorageChange);

    const unsubAuth = subscribeToFirebaseAuth(async (fbUser) => {
      if (!mounted) return;
      if (fbUser && fbUser.email) {
        const check = await verifyAdminInFirestoreCollection(
          fbUser.email,
          fbUser.displayName || fbUser.email
        );
        if (check.authorized && check.adminRecord) {
          setAdminUser(check.adminRecord);
          setAdminsList(check.adminsList);
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(
              'abyssal_evo_verified_admin',
              JSON.stringify(check.adminRecord)
            );
          }
        } else {
          setAuthError(
            `Account "${fbUser.email}" is not in the Firestore "admins" collection.`
          );
        }
      }
      setAuthChecking(false);
    });

    return () => {
      mounted = false;
      unsubCloudUsers();
      unsubAuth();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // ============================================================================
  // 2. DYNAMIC 24/7 OFFLINE FISH KEEPER LOOP (WITH OWNER AUTO-FEEDER CHECK)
  // ============================================================================
  useEffect(() => {
    if (!adminUser || !serviceRunning) return;

    // Interval scales inversely with CPU Usage Limit:
    // 100% CPU -> ticks every 150ms; 25% CPU -> ticks every 600ms; 10% CPU -> ticks every 1400ms
    const intervalMs = Math.max(140, Math.round(15000 / Math.max(10, cpuUsageLimitPct)));

    let ticksCounter = 0;
    let totalUpdates = serviceStats.totalBrainUpdatesExecuted;
    let simHoursAccum = serviceStats.simHoursElapsedInService;
    let lastDeathMsg = serviceStats.lastDeathEvent;

    const timer = window.setInterval(async () => {
      // Dynamically check which tanks are currently open in an active player game session
      const localActiveTankIds = getActiveGameSessionTankIds();
      setActiveSessionTankIds(localActiveTankIds);

      const currentEco = ecosystemRef.current;
      const activeTank = TANK_TIERS[currentEco.activeTankTier] || TANK_TIERS[0];
      const nowMs = Date.now();
      const myCloudRecord = cloudUsers.find((cu) => cu.username === profileName);
      const isMyCloudOnline =
        Boolean(myCloudRecord?.isActivelyPlaying) &&
        nowMs - (myCloudRecord?.lastGameHeartbeatMs || 0) < 300000;
      const isOwnerOnlineInGame =
        localActiveTankIds.includes(activeTank.id) || isMyCloudOnline;

      let stepRes = {
        liveFishUpdated: 0,
        birthsThisStep: 0,
        deathsThisStep: 0,
        simHoursDelta: 0,
      };

      // STRICT SINGLE-LOCATION RULE:
      // A fish must run in ONLY ONE place: either in its owner's open game OR in this Trainer Keeper.
      // When the owner has the game open, Keeper does NOT step or overwrite localStorage — instead it reads the live state.
      if (isOwnerOnlineInGame) {
        const lastAdminMs = lastAdminWriteByUserMsRef.current[profileName] || 0;
        if (
          localActiveTankIds.includes(activeTank.id) &&
          nowMs - lastAdminMs >= 15000
        ) {
          const latestFromGame = loadEcosystemState();
          if (
            (latestFromGame.adminOverrideAtMs || 0) >=
            (ecosystemRef.current.adminOverrideAtMs || 0)
          ) {
            ecosystemRef.current = latestFromGame;
            setEcosystem(latestFromGame);
          }
        }
      } else {
        const eco = ecosystemRef.current;
        const removedSet = new Set(eco.removedFishIds || []);
        if (removedSet.size > 0) {
          eco.fishes = eco.fishes.filter((f) => !removedSet.has(f.lineage.fishId));
          eco.deceasedArchive = eco.deceasedArchive.filter((d) => !removedSet.has(d.fishId));
        }
        const prevMultiplier = eco.timeMultiplier;
        const prevPaused = eco.paused;
        eco.paused = false;
        eco.timeMultiplier = serviceSpeed;

        stepRes = stepEcosystemSimulation(eco, pelletsRef.current, [], 0.4, {
          allowAutoFeeders: !disableAllFeedersInKeeper && trainerOverrideFeederEnabled,
          useOwnerAutoFeederWhenOverrideOff: !disableAllFeedersInKeeper,
          onlyOfflineFish: true,
          activeSessionTankIds: localActiveTankIds,
          onDeath: (fish, reason) => {
            lastDeathMsg = `[${fish.lineage.name}] (Gen ${fish.lineage.generation}) died of ${reason} at ${fish.state.ageSimHours.toFixed(1)}h`;
          },
        });

        eco.timeMultiplier = prevMultiplier;
        eco.paused = prevPaused;

        saveEcosystemState(eco);
        setEcosystem({ ...eco });
      }

      const eco = ecosystemRef.current;
      ticksCounter++;
      totalUpdates += stepRes.liveFishUpdated;
      simHoursAccum += stepRes.simHoursDelta;

      let offlineLive = 0;
      let offlineDead = 0;
      let skippedActive = 0;

      for (const f of eco.fishes) {
        const isOnline = localActiveTankIds.includes(f.lineage.tankId) || isMyCloudOnline;
        if (isOnline) {
          if (f.lineage.alive) skippedActive++;
        } else {
          if (f.lineage.alive) offlineLive++;
          else offlineDead++;
        }
      }

      // Also step any remote offline MyPC users stored in Firestore (`mypc_user_brains`)
      let cloudOfflineLiveCount = 0;
      let cloudOnlineSkippedCount = 0;
      const cloudSimHoursDelta =
        stepRes.simHoursDelta > 0 ? stepRes.simHoursDelta : (0.4 * serviceSpeed) / 60;

      for (const cu of cloudUsersRef.current) {
        if (cu.username === profileName) continue;
        const lastAdminMs = lastAdminWriteByUserMsRef.current[cu.username] || 0;
        if (nowMs - lastAdminMs < 15000) {
          // Do not step or overwrite a user record right after an Admin action
          continue;
        }
        const isUserOnlineNow =
          cu.isActivelyPlaying && nowMs - (cu.lastGameHeartbeatMs || 0) < 300000;
        if (isUserOnlineNow) {
          // User has the game open right now — their fishes are removed from Keeper!
          cloudOnlineSkippedCount += cu.fishBrains.filter((b) => b.alive).length;
        } else {
          // User is offline — Keeper keeps their fishes alive & checks cu.autoFeederStock when trainerOverrideFeederEnabled is false
          const cloudStep = await stepAndSyncCloudUserOfflineFishes(
            cu,
            cloudSimHoursDelta,
            !disableAllFeedersInKeeper && trainerOverrideFeederEnabled
          );
          cloudOfflineLiveCount += cloudStep.updatedLiveCount;
          totalUpdates += cloudStep.updatedLiveCount;
          if (cloudStep.newlyStarvedNames.length > 0) {
            lastDeathMsg = `[${cloudStep.newlyStarvedNames[0]}] starved (no owner feeder)`;
          }
        }
      }

      const ownerFeederCount = eco.autoFeederCountByTank[activeTank.id] || 0;

      setServiceStats({
        running: true,
        visualModeEnabled,
        speedMultiplier: serviceSpeed,
        cpuUsageLimitPct,
        activeInGameTankIds: localActiveTankIds,
        offlineLiveFishCount: offlineLive + cloudOfflineLiveCount,
        offlineDeceasedFishCount: offlineDead,
        skippedActivePlayFishCount: skippedActive + cloudOnlineSkippedCount,
        totalBrainUpdatesExecuted: totalUpdates,
        ticksPerSecond: Number(((1000 / intervalMs) * Math.max(1, offlineLive)).toFixed(1)),
        simHoursElapsedInService: Number(simHoursAccum.toFixed(3)),
        autoFeederEnabledInService:
          !disableAllFeedersInKeeper && (trainerOverrideFeederEnabled || ownerFeederCount > 0),
        lastDeathEvent: lastDeathMsg,
      });

      // Optimize Firestore writes (20k daily limit protection):
      // Only write when a fish is born or dies, or on a 4-minute checkpoint!
      const hasLifecycleEvent = stepRes.deathsThisStep > 0 || stepRes.birthsThisStep > 0;
      const checkpointDue =
        nowMs - lastKeeperFirestoreSyncMsRef.current >= FIRESTORE_CHECKPOINT_INTERVAL_MS;

      if (!isOwnerOnlineInGame && (hasLifecycleEvent || checkpointDue)) {
        lastKeeperFirestoreSyncMsRef.current = nowMs;
        const removedSet = new Set(eco.removedFishIds || []);
        const cleanFishes = eco.fishes.filter((f) => !removedSet.has(f.lineage.fishId));
        syncUserBrainsToFirestore(
          profileName,
          profileId,
          cleanFishes,
          false,
          ownerFeederCount,
          { removedFishIds: eco.removedFishIds || [] }
        ).then((ok) => {
          setFirestoreSyncStatus(
            ok
              ? `Synced ${offlineLive + cloudOfflineLiveCount} offline fishes to Firestore (aquarium-caa2b)`
              : 'Saved locally (Firestore offline fallback)'
          );
        });
      }
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    adminUser,
    serviceRunning,
    serviceSpeed,
    cpuUsageLimitPct,
    trainerOverrideFeederEnabled,
    disableAllFeedersInKeeper,
    visualModeEnabled,
    cloudUsers,
    profileName,
    profileId,
  ]);

  // ============================================================================
  // 3. CPU-THROTTLED BASE MODEL TRAINING (5 TO 1,000+ GENERATIONS)
  //    Saves ONLY 1 new version (the final generation of the run) and writes to
  //    Firestore ONLY once when training ends, keeping max 10 versions per fish.
  // ============================================================================
  const handleStartCpuThrottledTraining = async () => {
    if (isTrainingNow) return;
    setIsTrainingNow(true);
    setTrainingProgressGen(0);
    cancelTrainingRef.current = false;

    const totalGens = Math.max(1, Math.min(5000, trainGenerations));
    const popSize = Math.max(8, Math.min(128, trainPopulationSize));
    const workingState = JSON.parse(
      JSON.stringify(ecosystemRef.current)
    ) as SavedEcosystemState;

    // Resolve target species queue (multi-select batch loop or current selected species)
    const validQueueIds = batchSelectedSpeciesIds.filter((id) =>
      workingState.speciesList.some((s) => s.id === id)
    );
    const targetSpeciesQueueIds =
      validQueueIds.length > 0 ? validQueueIds : [selectedSpecies.id];

    setBatchTotalCount(targetSpeciesQueueIds.length);
    const trainedResults: string[] = [];
    let grandTotalSimulated = 0;

    for (let idx = 0; idx < targetSpeciesQueueIds.length; idx++) {
      if (cancelTrainingRef.current) break;
      const targetSpId = targetSpeciesQueueIds[idx];
      const sp =
        workingState.speciesList.find((s) => s.id === targetSpId) ||
        workingState.speciesList[0];

      setBatchCurrentIndex(idx + 1);
      setBatchCurrentSpeciesName(sp.name);
      setSelectedSpeciesId(sp.id);
      setTrainingProgressGen(0);

      if (trainingGoal === 'forager') {
        workingState.evolutionConfig.selectionStrengthForaging = 0.95;
        workingState.evolutionConfig.selectionStrengthSurvival = 0.65;
        sp.baseBrainConfig.learningRate = 0.035;
      } else if (trainingGoal === 'survivor') {
        workingState.evolutionConfig.selectionStrengthSurvival = 0.95;
        workingState.evolutionConfig.selectionStrengthForaging = 0.65;
        sp.baseBrainConfig.evasionModuleEnabled = true;
      } else {
        workingState.evolutionConfig.selectionStrengthForaging = 0.85;
        workingState.evolutionConfig.selectionStrengthSurvival = 0.85;
      }

      // Determine cumulative base generation before this run (0 if only v1.0-base exists)
      const priorTrainedModels = workingState.modelRegistry.filter(
        (m) => m.speciesId === sp.id && m.versionId !== 'v1.0-base'
      );
      const baseGenBeforeRun =
        priorTrainedModels.length > 0
          ? Math.max(...priorTrainedModels.map((m) => m.generationTrained || 0))
          : 0;

      let runningBrain: FishBrainInstance | undefined = undefined;
      let totalSimulated = 0;
      let totalGensCompleted = 0;

      const batchGens =
        totalGens >= 250 && cpuUsageLimitPct >= 50 ? 5 : totalGens >= 100 ? 2 : 1;

      for (let g = 1; g <= totalGens; g += batchGens) {
        if (cancelTrainingRef.current) break;
        const gensThisChunk = Math.min(batchGens, totalGens - g + 1);

        const stepRes = runAcceleratedHeadlessTraining(
          workingState,
          sp.id,
          gensThisChunk,
          popSize,
          0.1,
          {
            commitVersionToRegistry: false,
            initialBrainOverride: runningBrain,
            totalGenerationsTrained: baseGenBeforeRun + totalGensCompleted + gensThisChunk,
          }
        );
        runningBrain = stepRes.evolvedBrain;
        totalSimulated += stepRes.fishSimulatedCount;
        grandTotalSimulated += stepRes.fishSimulatedCount;
        totalGensCompleted += gensThisChunk;
        setTrainingProgressGen(totalGensCompleted);

        const sleepMs =
          cpuUsageLimitPct >= 95
            ? 6
            : Math.round(((100 - cpuUsageLimitPct) / Math.max(10, cpuUsageLimitPct)) * 28);
        await new Promise((r) => window.setTimeout(r, sleepMs));
      }

      // Commit 1 final version for this species at the end of its run, set as default, prune to 5 versions, and save to Firestore
      if (totalGensCompleted > 0 && runningBrain) {
        const finalGenLabel = baseGenBeforeRun + totalGensCompleted;
        const finalCommit = runAcceleratedHeadlessTraining(
          workingState,
          sp.id,
          0,
          popSize,
          0.1,
          {
            commitVersionToRegistry: true,
            initialBrainOverride: runningBrain,
            totalGenerationsTrained: finalGenLabel,
          }
        );
        const lastCandidate = finalCommit.candidateModel;

        // Ensure the newly finished model is set as the active/default base model for this species
        workingState.modelRegistry.forEach((m) => {
          if (m.speciesId === sp.id) {
            m.isPromotedBase = m.versionId === lastCandidate.versionId;
          }
        });
        lastCandidate.isPromotedBase = true;
        sp.activeBaseModelVersion = lastCandidate.versionId;
        if ((lastCandidate.brainConfig.aggressiveness ?? 0) > 0) {
          sp.baseBrainConfig.aggressiveness = lastCandidate.brainConfig.aggressiveness;
        }
        lastCandidate.speciesConfig = { ...sp };

        const pruneResult = pruneSpeciesModelVersions(
          workingState.modelRegistry,
          sp.id,
          MAX_VERSIONS_PER_SPECIES
        );
        workingState.modelRegistry = pruneResult.keptRegistry;

        await saveModelVersionToFirestore(adminUser?.email || profileName, lastCandidate);

        saveEcosystemState(workingState);
        ecosystemRef.current = workingState;
        setEcosystem({ ...workingState });

        trainedResults.push(
          `${sp.name} -> ${lastCandidate.versionId} [DEFAULT] (${lastCandidate.benchmark.overallComposite}% Composite)`
        );
      }
    }

    if (trainedResults.length > 0) {
      const summary =
        trainedResults.length === 1
          ? `Trained 1 species (${trainedResults[0]}) across ${totalGens} generations (${grandTotalSimulated.toLocaleString()} fishes simulated at ${cpuUsageLimitPct}% CPU) — Saved to Firestore "base_models".`
          : `Batch Trained ${trainedResults.length} species sequentially (${totalGens}G each, ${grandTotalSimulated.toLocaleString()} total fishes simulated at ${cpuUsageLimitPct}% CPU): ${trainedResults.join(' · ')}`;
      setLastTrainingSummary(summary);
      setStatusBanner(summary);
    }

    setIsTrainingNow(false);
  };

  const handleSetActiveBaseModel = async (versionId: string) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    let promotedModel: ModelVersionRecord | null = null;
    const sp = next.speciesList.find((s) => s.id === selectedSpecies.id);

    next.modelRegistry.forEach((m) => {
      if (m.speciesId === selectedSpecies.id) {
        m.isPromotedBase = m.versionId === versionId;
        if (m.isPromotedBase) {
          if (sp) m.speciesConfig = { ...sp };
          promotedModel = m;
        }
      }
    });
    if (sp) {
      sp.activeBaseModelVersion = versionId;
    }

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    if (promotedModel) {
      await saveModelVersionToFirestore(adminUser?.email || profileName, promotedModel);
    }
    setStatusBanner(
      `Active Base Model for ${selectedSpecies.name} set to ${versionId} and synced to Firestore "base_models/active__${selectedSpecies.id}".`
    );
  };

  // ============================================================================
  // 4. EDIT BASE MODEL / SPECIES PROPERTIES & 50 FAMOUS FISHES CATALOG
  // ============================================================================
  const handleUpdateSelectedSpeciesField = (updater: (sp: SpeciesConfig) => void) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const sp = next.speciesList.find((s) => s.id === selectedSpecies.id);
    if (!sp) return;
    updater(sp);
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
  };

  const handleSaveSpeciesPropertiesToFirestore = async () => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const sp = next.speciesList.find((s) => s.id === selectedSpecies.id);
    if (!sp) return;

    let activeModel = next.modelRegistry.find(
      (m) => m.speciesId === sp.id && m.isPromotedBase
    );
    if (!activeModel) {
      const baseBrain = createBaseBrainInstance(sp.baseBrainConfig, 707);
      const bench = evaluateBrainOnBenchmarks(baseBrain, sp, next.evolutionConfig, 707);
      activeModel = {
        versionId: sp.activeBaseModelVersion || 'v1.0-base',
        speciesId: sp.id,
        parentVersionId: null,
        createdAtIso: new Date().toISOString(),
        generationTrained: 1,
        isPromotedBase: true,
        notes: `Updated properties for ${sp.name}`,
        brainConfig: { ...sp.baseBrainConfig },
        speciesConfig: { ...sp },
        weights: baseBrain.inheritedWeights,
        biases: baseBrain.inheritedBiases,
        benchmark: bench,
      };
      next.modelRegistry.unshift(activeModel);
    } else {
      activeModel.brainConfig = { ...sp.baseBrainConfig };
      activeModel.speciesConfig = { ...sp };
    }

    const pruneRes = pruneSpeciesModelVersions(
      next.modelRegistry,
      sp.id,
      MAX_VERSIONS_PER_SPECIES
    );
    next.modelRegistry = pruneRes.keptRegistry;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const ok = await saveModelVersionToFirestore(adminUser?.email || profileName, activeModel);
    setStatusBanner(
      ok
        ? `Saved "${sp.name}" properties (Lifespan: ${sp.lifespan.lifespanSimHours}h, Owner Lv.${
            sp.requiredOwnerLevel || 1
          }, Price: ${sp.shopPriceCredits || 45} Cr, Aggressiveness: ${(
            (sp.baseBrainConfig.aggressiveness ?? 0) * 100
          ).toFixed(0)}%) to Firestore "base_models/active__${sp.id}".`
        : `Saved "${sp.name}" properties locally (Firestore offline fallback).`
    );
  };

  const handleAddOrLoadFamousFish = async (tpl: FamousAquariumFishTemplate) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    let sp = next.speciesList.find((s) => s.id === tpl.id);
    if (!sp) {
      sp = createSpeciesConfigFromFamousFish(tpl);
      next.speciesList.push(sp);
    }

    let model = next.modelRegistry.find((m) => m.speciesId === sp!.id && m.isPromotedBase);
    if (!model) {
      const baseBrain = createBaseBrainInstance(sp.baseBrainConfig, 800 + tpl.rank);
      const bench = evaluateBrainOnBenchmarks(
        baseBrain,
        sp,
        next.evolutionConfig,
        800 + tpl.rank
      );
      model = {
        versionId: 'v1.0-base',
        speciesId: sp.id,
        parentVersionId: null,
        createdAtIso: new Date().toISOString(),
        generationTrained: 1,
        isPromotedBase: true,
        notes: `Famous Aquarium Species #${tpl.rank}: ${tpl.name} (${tpl.scientificName})`,
        brainConfig: { ...sp.baseBrainConfig },
        speciesConfig: { ...sp },
        weights: baseBrain.inheritedWeights,
        biases: baseBrain.inheritedBiases,
        benchmark: bench,
      };
      next.modelRegistry.unshift(model);
    }

    const pruneRes = pruneSpeciesModelVersions(
      next.modelRegistry,
      sp.id,
      MAX_VERSIONS_PER_SPECIES
    );
    next.modelRegistry = pruneRes.keptRegistry;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setSelectedSpeciesId(sp.id);

    await saveModelVersionToFirestore(adminUser?.email || profileName, model);
    setStatusBanner(
      `Loaded Famous Aquarium Fish #${tpl.rank} "${tpl.name}" (${tpl.scientificName}) into Base Models and synced to Firestore.`
    );
  };

  // ============================================================================
  // RESET ALL FISHES (KEEP BASE MODELS ONLY) & INDIVIDUAL FISH ACTIONS
  // ============================================================================
  const handleResetAllFishesKeepBaseModels = async () => {
    pelletsRef.current.length = 0;
    const freshEco = resetFishesKeepBaseModels(ecosystemRef.current);
    ecosystemRef.current = freshEco;
    setEcosystem(freshEco);
    setSelectedFishId(freshEco.fishes[0]?.lineage.fishId || null);

    const activeTank = TANK_TIERS[freshEco.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = freshEco.autoFeederCountByTank[activeTank.id] || 0;

    await resetAllUserFishesInFirestore(
      profileName,
      profileId,
      freshEco.fishes,
      ownerFeederCount
    );

    setStatusBanner(
      `Reset Complete: Cleared all evolved & dead fishes and spawned ${freshEco.fishes.length} fresh Gen 1 starter fishes while keeping all ${freshEco.modelRegistry.length} trained Base Models & ${freshEco.speciesList.length} Species intact!`
    );
  };

  // Helper to get a promoted Base Model brain for any species
  const getPromotedBrainForSpecies = (
    sp: SpeciesConfig,
    ecoState: SavedEcosystemState
  ): FishBrainInstance => {
    const promoted = ecoState.modelRegistry.find(
      (m) => m.speciesId === sp.id && m.isPromotedBase
    );
    const base = createBaseBrainInstance(
      promoted?.brainConfig || sp.baseBrainConfig,
      Date.now() & 0xffff
    );
    if (promoted && promoted.weights?.length) {
      base.inheritedWeights = promoted.weights.map((w) => [...w]);
      base.inheritedBiases = promoted.biases.map((b) => [...b]);
    }
    return base;
  };

  // Starve a specific fish (local or any cloud user) with authoritative override so even if owner has game open it immediately turns dead & greyed out
  const handleStarveFish = async (targetFishId?: string, ownerUsername?: string) => {
    const resolvedOwner = ownerUsername || selectedFishOwnerUsername || profileName;
    const candidateId = targetFishId || selectedFishId;
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[resolvedOwner] = now;

    if (resolvedOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === resolvedOwner);
      if (cuIdx === -1) {
        setStatusBanner(`User "${resolvedOwner}" not found.`);
        return;
      }
      const cu = cloudUsersRef.current[cuIdx];
      const updatedBrains = cu.fishBrains.map((b) => ({ ...b }));
      let targetB = updatedBrains.find((b) => b.fishId === candidateId && b.alive);
      if (!targetB) targetB = updatedBrains.find((b) => b.alive);
      if (!targetB) {
        setStatusBanner(`No live fish found for user "${resolvedOwner}" to starve.`);
        return;
      }
      targetB.alive = false;
      targetB.causeOfDeath = 'starvation';
      targetB.energy = 0;
      targetB.hunger = 100;

      const actionDesc = `Admin starved [${targetB.name}] (${resolvedOwner})`;
      const nextCloudUsers = [...cloudUsersRef.current];
      nextCloudUsers[cuIdx] = {
        ...cu,
        fishBrains: updatedBrains,
        updatedAtMs: now,
        adminOverrideAtMs: now,
        lastAdminAction: actionDesc,
      };
      cloudUsersRef.current = nextCloudUsers;
      setCloudUsers(nextCloudUsers);
      setSelectedFishId(targetB.fishId);
      setSelectedFishOwnerUsername(resolvedOwner);

      await saveAdminOverrideForUserInFirestore(
        cu.username,
        cu.profileId,
        updatedBrains,
        cu.isActivelyPlaying,
        cu.autoFeederStock,
        actionDesc,
        cu.removedFishIds || []
      );
      setStatusBanner(
        `Killed "[${targetB.name}]" (Owner: ${resolvedOwner}) by STARVATION! Authoritative override pushed — even if ${resolvedOwner} has the game open right now, "[${targetB.name}]" immediately turns dead and greyed out.`
      );
      return;
    }

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    let target = next.fishes.find((f) => f.lineage.fishId === candidateId && f.lineage.alive);
    if (!target) {
      target = next.fishes.find((f) => f.lineage.alive);
    }
    if (!target) {
      setStatusBanner('No live fish found to starve.');
      return;
    }

    target.state.energy = 0;
    target.state.hunger = 100;
    target.state.health = 0;
    target.state.stress = 100;
    target.lineage.alive = false;
    target.lineage.causeOfDeath = 'starvation';
    target.lineage.deathSimHour = next.simHoursTotal;

    const alreadyInArchive = next.deceasedArchive.some(
      (d) => d.fishId === target!.lineage.fishId
    );
    if (!alreadyInArchive) {
      next.deceasedArchive.unshift({ ...target.lineage });
    }

    const actionDesc = `Admin starved [${target.lineage.name}]`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setSelectedFishId(target.lineage.fishId);
    setSelectedFishOwnerUsername(profileName);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    const serialized = next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f));

    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      serialized,
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner(
      `Fish "[${target.lineage.name}]" (Gen ${target.lineage.generation}) died from STARVATION! Authoritative override pushed — even if the owner has the game open right now, "[${target.lineage.name}]" turns dead and greyed out immediately.`
    );
  };

  // Reproduce a specific fish (make it have a baby immediately for local or cloud user)
  const handleReproduceFish = async (targetFishId?: string, ownerUsername?: string) => {
    const resolvedOwner = ownerUsername || selectedFishOwnerUsername || profileName;
    const candidateId = targetFishId || selectedFishId;
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[resolvedOwner] = now;

    if (resolvedOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === resolvedOwner);
      if (cuIdx === -1) return;
      const cu = cloudUsersRef.current[cuIdx];
      const updatedBrains = cu.fishBrains.map((b) => ({ ...b }));
      let parentB = updatedBrains.find((b) => b.fishId === candidateId && b.alive);
      if (!parentB) parentB = updatedBrains.find((b) => b.alive);
      if (!parentB) {
        setStatusBanner(`Select a live fish of "${resolvedOwner}" to reproduce.`);
        return;
      }
      const sp =
        ecosystem.speciesList.find((s) => s.id === parentB!.speciesId) ||
        ecosystem.speciesList[0] ||
        DEFAULT_SPECIES_LIST[0];
      const babySpawned = spawnFoundingFish(
        sp,
        0,
        ecosystem.simHoursTotal,
        updatedBrains.length,
        parentB.brain
      );
      babySpawned.lineage.generation = (parentB.generation || 1) + 1;
      babySpawned.lineage.motherId = parentB.fishId;
      babySpawned.state.lifeStage = 'juvenile';
      babySpawned.state.ageSimHours = 0.2;
      const babyItem = serializeFishEntityToCloudBrainItem(babySpawned);
      updatedBrains.push(babyItem);

      const actionDesc = `Admin reproduced [${parentB.name}] -> baby [${babyItem.name}]`;
      const nextCloudUsers = [...cloudUsersRef.current];
      nextCloudUsers[cuIdx] = {
        ...cu,
        fishBrains: updatedBrains,
        updatedAtMs: now,
        adminOverrideAtMs: now,
        lastAdminAction: actionDesc,
      };
      cloudUsersRef.current = nextCloudUsers;
      setCloudUsers(nextCloudUsers);

      await saveAdminOverrideForUserInFirestore(
        cu.username,
        cu.profileId,
        updatedBrains,
        cu.isActivelyPlaying,
        cu.autoFeederStock,
        actionDesc,
        cu.removedFishIds || []
      );
      setStatusBanner(
        `"[${parentB.name}]" (Owner: ${resolvedOwner}) reproduced! Baby "[${babyItem.name}]" (Gen ${babyItem.generation}) added to ${resolvedOwner}'s aquarium.`
      );
      return;
    }

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    let parentFish = next.fishes.find((f) => f.lineage.fishId === candidateId && f.lineage.alive);
    if (!parentFish) {
      parentFish = next.fishes.find((f) => f.lineage.alive);
    }
    if (!parentFish) {
      setStatusBanner('Select a live fish to reproduce (dead fishes cannot have babies).');
      return;
    }

    const sp =
      next.speciesList.find((s) => s.id === parentFish!.lineage.speciesId) ||
      next.speciesList[0] ||
      DEFAULT_SPECIES_LIST[0];

    const coParent =
      next.fishes.find(
        (f) =>
          f.lineage.alive &&
          f.lineage.fishId !== parentFish!.lineage.fishId &&
          f.lineage.speciesId === parentFish!.lineage.speciesId
      ) || null;

    const babyFish = reproduceOffspringFish(
      parentFish,
      coParent,
      sp,
      next.evolutionConfig,
      next.simHoursTotal
    );

    parentFish.state.metrics.offspringProduced += 1;
    parentFish.state.reproductionCooldownHours = sp.lifespan.reproductionIntervalHours;
    next.fishes.push(babyFish);

    const actionDesc = `Admin reproduced [${parentFish.lineage.name}] -> baby [${babyFish.lineage.name}]`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner(
      `"[${parentFish.lineage.name}]" reproduced! New baby "[${babyFish.lineage.name}]" (Gen ${babyFish.lineage.generation}, Juvenile) was born into the tank.`
    );
  };

  // Feed a single selected fish (local or cloud user)
  const handleFeedSingleFish = async (targetFishId?: string, ownerUsername?: string) => {
    const resolvedOwner = ownerUsername || selectedFishOwnerUsername || profileName;
    const candidateId = targetFishId || selectedFishId;
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[resolvedOwner] = now;

    if (resolvedOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === resolvedOwner);
      if (cuIdx === -1) return;
      const cu = cloudUsersRef.current[cuIdx];
      const updatedBrains = cu.fishBrains.map((b) => ({ ...b }));
      const targetB = updatedBrains.find((b) => b.fishId === candidateId && b.alive);
      if (!targetB) {
        setStatusBanner('Select a live fish to feed.');
        return;
      }
      targetB.energy = Math.min(100, targetB.energy + 50);
      targetB.hunger = Math.max(0, 100 - targetB.energy);
      const actionDesc = `Admin fed [${targetB.name}]`;
      const nextCloudUsers = [...cloudUsersRef.current];
      nextCloudUsers[cuIdx] = {
        ...cu,
        fishBrains: updatedBrains,
        updatedAtMs: now,
        adminOverrideAtMs: now,
        lastAdminAction: actionDesc,
      };
      cloudUsersRef.current = nextCloudUsers;
      setCloudUsers(nextCloudUsers);
      await saveAdminOverrideForUserInFirestore(
        cu.username,
        cu.profileId,
        updatedBrains,
        cu.isActivelyPlaying,
        cu.autoFeederStock,
        actionDesc,
        cu.removedFishIds || []
      );
      setStatusBanner(
        `Fed "[${targetB.name}]" (Owner: ${resolvedOwner}, Energy ${targetB.energy.toFixed(0)}%).`
      );
      return;
    }

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const target = next.fishes.find((f) => f.lineage.fishId === candidateId && f.lineage.alive);
    if (!target) {
      setStatusBanner('Select a live fish to feed.');
      return;
    }
    target.state.energy = Math.min(100, target.state.energy + 50);
    target.state.hunger = Math.max(0, 100 - target.state.energy);
    target.state.health = Math.min(100, target.state.health + 20);
    const actionDesc = `Admin fed [${target.lineage.name}]`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner(
      `Fed "[${target.lineage.name}]" (+50% Energy, Health ${target.state.health.toFixed(0)}%).`
    );
  };

  // Revive a dead fish (local or cloud user)
  const handleReviveFish = async (targetFishId?: string, ownerUsername?: string) => {
    const resolvedOwner = ownerUsername || selectedFishOwnerUsername || profileName;
    const candidateId = targetFishId || selectedFishId;
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[resolvedOwner] = now;

    if (resolvedOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === resolvedOwner);
      if (cuIdx === -1) return;
      const cu = cloudUsersRef.current[cuIdx];
      const updatedBrains = cu.fishBrains.map((b) => ({ ...b }));
      const targetB = updatedBrains.find((b) => b.fishId === candidateId && !b.alive);
      if (!targetB) return;
      targetB.alive = true;
      targetB.causeOfDeath = null;
      targetB.energy = 85;
      targetB.hunger = 15;
      const actionDesc = `Admin revived [${targetB.name}]`;
      const nextCloudUsers = [...cloudUsersRef.current];
      nextCloudUsers[cuIdx] = {
        ...cu,
        fishBrains: updatedBrains,
        updatedAtMs: now,
        adminOverrideAtMs: now,
        lastAdminAction: actionDesc,
      };
      cloudUsersRef.current = nextCloudUsers;
      setCloudUsers(nextCloudUsers);
      await saveAdminOverrideForUserInFirestore(
        cu.username,
        cu.profileId,
        updatedBrains,
        cu.isActivelyPlaying,
        cu.autoFeederStock,
        actionDesc,
        cu.removedFishIds || []
      );
      setStatusBanner(`Revived "[${targetB.name}]" (Owner: ${resolvedOwner}) with 85% Energy!`);
      return;
    }

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const target = next.fishes.find((f) => f.lineage.fishId === candidateId && !f.lineage.alive);
    if (!target) return;
    target.lineage.alive = true;
    target.lineage.causeOfDeath = null;
    target.lineage.deathSimHour = null;
    target.state.energy = 85;
    target.state.hunger = 15;
    target.state.health = 100;
    target.state.stress = 5;
    next.deceasedArchive = next.deceasedArchive.filter((d) => d.fishId !== target.lineage.fishId);
    const actionDesc = `Admin revived [${target.lineage.name}]`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner(`Revived "[${target.lineage.name}]" with 85% Energy and 100% Health!`);
  };

  // Permanently remove a dead fish body from database & Trainer so neither user nor Trainer sees it again
  const handleDeleteDeadFishInTrainer = async (targetFishId?: string, ownerUsername?: string) => {
    const resolvedOwner = ownerUsername || selectedFishOwnerUsername || profileName;
    const candidateId = targetFishId || selectedFishId;
    if (!candidateId) return;
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[resolvedOwner] = now;

    if (resolvedOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === resolvedOwner);
      if (cuIdx === -1) return;
      const cu = cloudUsersRef.current[cuIdx];
      const targetB = cu.fishBrains.find((b) => b.fishId === candidateId);
      const updatedBrains = cu.fishBrains.filter((b) => b.fishId !== candidateId);
      const updatedRemoved = Array.from(
        new Set([...(cu.removedFishIds || []), candidateId])
      ).slice(-200);
      const actionDesc = `Removed dead fish [${targetB?.name || candidateId}] from database`;
      const nextCloudUsers = [...cloudUsersRef.current];
      nextCloudUsers[cuIdx] = {
        ...cu,
        fishBrains: updatedBrains,
        removedFishIds: updatedRemoved,
        updatedAtMs: now,
        adminOverrideAtMs: now,
        lastAdminAction: actionDesc,
      };
      cloudUsersRef.current = nextCloudUsers;
      setCloudUsers(nextCloudUsers);
      await saveAdminOverrideForUserInFirestore(
        cu.username,
        cu.profileId,
        updatedBrains,
        cu.isActivelyPlaying,
        cu.autoFeederStock,
        actionDesc,
        updatedRemoved
      );
      setStatusBanner(
        `Permanently removed dead fish "[${targetB?.name || candidateId}]" (Owner: ${resolvedOwner}) from Firestore database.`
      );
      return;
    }

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const target = next.fishes.find((f) => f.lineage.fishId === candidateId);
    const removedName = target?.lineage.name || candidateId;
    next.fishes = next.fishes.filter((f) => f.lineage.fishId !== candidateId);
    next.deceasedArchive = next.deceasedArchive.filter((d) => d.fishId !== candidateId);
    next.removedFishIds = Array.from(
      new Set([...(next.removedFishIds || []), candidateId])
    ).slice(-200);
    next.acknowledgedDeadFishIds = Array.from(
      new Set([...(next.acknowledgedDeadFishIds || []), candidateId])
    ).slice(-200);
    const actionDesc = `Removed dead fish [${removedName}] from database`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds
    );

    setStatusBanner(
      `Permanently removed dead fish "[${removedName}]" from tank and Firestore database.`
    );
  };

  // Give fishes of any species to ANY user from Trainer UI (Bypasses player tank capacity limit!)
  const handleGiveFishToUser = async () => {
    const targetUser = (giftTargetUsername || profileName).trim();
    const qty = Math.max(1, Math.min(10, giftQuantity || 1));
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[targetUser] = now;
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;

    // Ensure the species exists in speciesList (can also be from the 50 Famous Fishes catalog)
    let sp = next.speciesList.find((s) => s.id === giftSpeciesId);
    if (!sp) {
      const famousTpl = FAMOUS_AQUARIUM_FISHES_50.find((f) => f.id === giftSpeciesId);
      if (famousTpl) {
        sp = createSpeciesConfigFromFamousFish(famousTpl);
        next.speciesList.push(sp);
      } else {
        sp = next.speciesList[0] || DEFAULT_SPECIES_LIST[0];
      }
    }

    const customBrain = getPromotedBrainForSpecies(sp, next);

    if (targetUser === profileName) {
      const spawnedNames: string[] = [];
      for (let i = 0; i < qty; i++) {
        const newFish = spawnFoundingFish(
          sp,
          next.activeTankTier,
          next.simHoursTotal,
          next.fishes.length + i,
          customBrain
        );
        next.fishes.push(newFish);
        spawnedNames.push(`[${newFish.lineage.name}]`);
        setSelectedFishId(newFish.lineage.fishId);
        setSelectedFishOwnerUsername(profileName);
      }
      const actionDesc = `Admin gifted ${qty}x ${sp.name} (${spawnedNames.join(', ')}) to ${profileName}`;
      next.adminOverrideAtMs = now;
      next.lastAdminAction = actionDesc;

      saveEcosystemState(next);
      ecosystemRef.current = next;
      setEcosystem(next);

      const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
      const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
      await saveAdminOverrideForUserInFirestore(
        profileName,
        profileId,
        next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
        activeSessionTankIds.includes(activeTank.id),
        ownerFeederCount,
        actionDesc,
        next.removedFishIds || []
      );

      setStatusBanner(
        `Gifted ${qty}x "${sp.name}" (${spawnedNames.join(', ')}) to "${profileName}" (admin gift bypasses tank capacity limit and appears immediately in the user's aquarium)!`
      );
      return;
    }

    // Remote Cloud User (or create new cloud user record if not yet in cloudUsers)
    const existingIdx = cloudUsersRef.current.findIndex((u) => u.username === targetUser);
    const existingRecord: CloudUserBrainRecord =
      existingIdx >= 0
        ? cloudUsersRef.current[existingIdx]
        : {
            username: targetUser,
            profileId: `user-${targetUser.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
            updatedAtIso: new Date().toISOString(),
            updatedAtMs: now,
            isActivelyPlaying: false,
            lastGameHeartbeatMs: 0,
            autoFeederStock: 1,
            fishBrains: [],
          };

    const updatedBrains: UserFishBrainItem[] = existingRecord.fishBrains.map((b) => ({ ...b }));
    const spawnedNames: string[] = [];
    for (let i = 0; i < qty; i++) {
      const newFish = spawnFoundingFish(
        sp,
        0,
        next.simHoursTotal,
        updatedBrains.length + i,
        customBrain
      );
      const item = serializeFishEntityToCloudBrainItem(newFish);
      updatedBrains.push(item);
      spawnedNames.push(`[${item.name}]`);
      setSelectedFishId(item.fishId);
      setSelectedFishOwnerUsername(targetUser);
    }

    const actionDesc = `Admin gifted ${qty}x ${sp.name} (${spawnedNames.join(', ')}) to ${targetUser}`;
    const updatedUserRecord: CloudUserBrainRecord = {
      ...existingRecord,
      fishBrains: updatedBrains,
      updatedAtMs: now,
      adminOverrideAtMs: now,
      lastAdminAction: actionDesc,
    };

    const nextCloudUsers =
      existingIdx >= 0
        ? cloudUsersRef.current.map((u, idx) => (idx === existingIdx ? updatedUserRecord : u))
        : [updatedUserRecord, ...cloudUsersRef.current];
    cloudUsersRef.current = nextCloudUsers;
    setCloudUsers(nextCloudUsers);

    // Save species to local ecosystem if newly added from catalog
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    await saveAdminOverrideForUserInFirestore(
      updatedUserRecord.username,
      updatedUserRecord.profileId,
      updatedBrains,
      updatedUserRecord.isActivelyPlaying,
      updatedUserRecord.autoFeederStock,
      actionDesc,
      updatedUserRecord.removedFishIds || []
    );

    setStatusBanner(
      `Gifted ${qty}x "${sp.name}" (${spawnedNames.join(', ')}) to user "${targetUser}" (bypasses tank limit & synced to Firestore)!`
    );
  };

  // Change / Replace an existing fish with another species directly from Trainer UI
  const handleReplaceSelectedFishSpecies = async (
    targetFishId?: string,
    ownerUsername?: string,
    newSpeciesIdOverride?: string
  ) => {
    const resolvedOwner = ownerUsername || selectedFishOwnerUsername || profileName;
    const candidateId = targetFishId || selectedFishId;
    const desiredSpeciesId = newSpeciesIdOverride || replaceSpeciesId;
    if (!candidateId) {
      setStatusBanner('Select a fish first to change its species.');
      return;
    }
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[resolvedOwner] = now;

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    let newSp = next.speciesList.find((s) => s.id === desiredSpeciesId);
    if (!newSp) {
      const famousTpl = FAMOUS_AQUARIUM_FISHES_50.find((f) => f.id === desiredSpeciesId);
      if (famousTpl) {
        newSp = createSpeciesConfigFromFamousFish(famousTpl);
        next.speciesList.push(newSp);
      } else {
        newSp = next.speciesList[0] || DEFAULT_SPECIES_LIST[0];
      }
    }

    const newBrain = getPromotedBrainForSpecies(newSp, next);
    const shortPrefix = newSp.name.split(' ')[0] || 'Aqua';

    if (resolvedOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === resolvedOwner);
      if (cuIdx === -1) return;
      const cu = cloudUsersRef.current[cuIdx];
      const updatedBrains = cu.fishBrains.map((b) => ({ ...b }));
      const targetB = updatedBrains.find((b) => b.fishId === candidateId);
      if (!targetB) return;

      const oldName = targetB.name;
      targetB.speciesId = newSp.id;
      targetB.name = `${shortPrefix}-${targetB.fishId.slice(-3).toUpperCase()}`;
      targetB.modelVersion = newSp.activeBaseModelVersion || 'v1.0-base';
      targetB.brain = newBrain;
      targetB.alive = true;
      targetB.causeOfDeath = null;
      targetB.energy = 90;
      targetB.hunger = 10;

      const actionDesc = `Admin changed fish [${oldName}] -> [${targetB.name}] (${newSp.name})`;
      const nextCloudUsers = [...cloudUsersRef.current];
      nextCloudUsers[cuIdx] = {
        ...cu,
        fishBrains: updatedBrains,
        updatedAtMs: now,
        adminOverrideAtMs: now,
        lastAdminAction: actionDesc,
      };
      cloudUsersRef.current = nextCloudUsers;
      setCloudUsers(nextCloudUsers);

      saveEcosystemState(next);
      ecosystemRef.current = next;
      setEcosystem(next);

      await saveAdminOverrideForUserInFirestore(
        cu.username,
        cu.profileId,
        updatedBrains,
        cu.isActivelyPlaying,
        cu.autoFeederStock,
        actionDesc,
        cu.removedFishIds || []
      );

      setStatusBanner(
        `Changed "[${oldName}]" (Owner: ${resolvedOwner}) into "${newSp.name}" ([${targetB.name}]) and synced immediately to the user's game!`
      );
      return;
    }

    const target = next.fishes.find((f) => f.lineage.fishId === candidateId);
    if (!target) return;
    const oldName = target.lineage.name;
    target.lineage.speciesId = newSp.id;
    target.lineage.name = `${shortPrefix}-${target.lineage.fishId.slice(-3).toUpperCase()}`;
    target.lineage.modelVersion = newSp.activeBaseModelVersion || 'v1.0-base';
    target.lineage.alive = true;
    target.lineage.causeOfDeath = null;
    target.lineage.deathSimHour = null;
    target.brain = newBrain;
    target.state.energy = 90;
    target.state.hunger = 10;
    target.state.health = 100;
    target.state.stress = 5;
    next.deceasedArchive = next.deceasedArchive.filter((d) => d.fishId !== target.lineage.fishId);

    const actionDesc = `Admin changed fish [${oldName}] -> [${target.lineage.name}] (${newSp.name})`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner(
      `Changed "[${oldName}]" into "${newSp.name}" ([${target.lineage.name}])! The 3D aquarium mesh and brain updated immediately.`
    );
  };

  // Offline Fish Actions
  const handleFeedOfflineFishes = async () => {
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[profileName] = now;
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    for (const f of next.fishes) {
      if (f.lineage.alive) {
        f.state.energy = Math.min(100, f.state.energy + 35);
        f.state.hunger = Math.max(0, 100 - f.state.energy);
      }
    }
    const actionDesc = 'Admin fed all fishes (+35% Energy)';
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner('Fed all live fishes (+35% Energy) and synced to Firestore.');
  };

  const handleToggleSimulatedOwnerOnlineState = () => {
    const currentTank = TANK_TIERS[ecosystem.activeTankTier] || TANK_TIERS[0];
    const isCurrentlyOnline = activeSessionTankIds.includes(currentTank.id);
    if (isCurrentlyOnline) {
      // Force owner offline so Keeper immediately brings fishes alive in Keeper
      setForceOfflineOverride(true);
      publishActiveGameSessionLease(currentTank.id, false);
    } else {
      setForceOfflineOverride(false);
      publishActiveGameSessionLease(currentTank.id, true);
    }
    const updated = getActiveGameSessionTankIds();
    setActiveSessionTankIds(updated);
    setStatusBanner(
      !isCurrentlyOnline
        ? `Owner opened game (${currentTank.name}) → Fishes dynamically REMOVED from Fish Keeper so they live exclusively in the owner's game!`
        : `Owner closed game (${currentTank.name}) → Fishes dynamically RETURNED to the 24/7 Fish Keeper!`
    );
  };

  const handleStarvationTest = () => {
    handleStarveFish(selectedFishId || undefined);
  };

  const handleAddOfflinePair = async () => {
    const targetOwner =
      selectedKeeperUserFilter !== 'ALL'
        ? selectedKeeperUserFilter
        : selectedFishOwnerUsername || giftTargetUsername || profileName;
    const now = Date.now();
    lastAdminWriteByUserMsRef.current[targetOwner] = now;

    if (targetOwner !== profileName) {
      const cuIdx = cloudUsersRef.current.findIndex((u) => u.username === targetOwner);
      if (cuIdx >= 0) {
        const cu = cloudUsersRef.current[cuIdx];
        const sp = ecosystemRef.current.speciesList[0] || DEFAULT_SPECIES_LIST[0];
        const f1 = spawnFoundingFish(sp, 0, ecosystemRef.current.simHoursTotal, cu.fishBrains.length);
        const f2 = spawnFoundingFish(sp, 0, ecosystemRef.current.simHoursTotal, cu.fishBrains.length + 1);
        const item1 = serializeFishEntityToCloudBrainItem(f1);
        const item2 = serializeFishEntityToCloudBrainItem(f2);
        const updatedBrains = [...cu.fishBrains, item1, item2];
        const actionDesc = `Admin added 2 fishes ([${item1.name}], [${item2.name}]) to ${targetOwner}`;
        const nextCloudUsers = [...cloudUsersRef.current];
        nextCloudUsers[cuIdx] = {
          ...cu,
          fishBrains: updatedBrains,
          updatedAtMs: now,
          adminOverrideAtMs: now,
          lastAdminAction: actionDesc,
        };
        cloudUsersRef.current = nextCloudUsers;
        setCloudUsers(nextCloudUsers);
        setSelectedFishId(item1.fishId);
        setSelectedFishOwnerUsername(targetOwner);
        await saveAdminOverrideForUserInFirestore(
          cu.username,
          cu.profileId,
          updatedBrains,
          cu.isActivelyPlaying,
          cu.autoFeederStock,
          actionDesc,
          cu.removedFishIds || []
        );
        setStatusBanner(`Added 2 live fishes ([${item1.name}], [${item2.name}]) to "${targetOwner}" and synced to Firestore.`);
        return;
      }
    }

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const sp = next.speciesList[0] || DEFAULT_SPECIES_LIST[0];
    const f1 = spawnFoundingFish(sp, next.activeTankTier, next.simHoursTotal, next.fishes.length);
    const f2 = spawnFoundingFish(sp, next.activeTankTier, next.simHoursTotal, next.fishes.length + 1);
    next.fishes.push(f1, f2);
    const actionDesc = `Admin added 2 fishes ([${f1.lineage.name}], [${f2.lineage.name}])`;
    next.adminOverrideAtMs = now;
    next.lastAdminAction = actionDesc;
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setSelectedFishId(f1.lineage.fishId);
    setSelectedFishOwnerUsername(profileName);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await saveAdminOverrideForUserInFirestore(
      profileName,
      profileId,
      next.fishes.map((f) => serializeFishEntityToCloudBrainItem(f)),
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount,
      actionDesc,
      next.removedFishIds || []
    );

    setStatusBanner(`Added 2 live fishes ([${f1.lineage.name}], [${f2.lineage.name}]) to the tank and synced to Firestore.`);
  };

  // ============================================================================
  // GMAIL ADMIN LOGIN GATE (WHEN NOT SIGNED IN AS AN AUTHORIZED ADMIN)
  // ============================================================================
  if (!adminUser) {
    return (
      <div className="fixed inset-0 w-full h-full bg-[#02060d] text-slate-100 flex items-center justify-center p-6 select-none">
        <div className="w-full max-w-md rounded-xl bg-[#040c1a] border-2 border-cyan-500 overflow-hidden">
          <div className="px-6 py-4 bg-[#061328] border-b border-cyan-800 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-cyan-950 border border-cyan-500 text-[10px] font-mono font-bold uppercase tracking-widest text-cyan-300">
                  TRAINER HUD v1.8.0
                </span>
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                  ADMIN AUTH GATE
                </span>
              </div>
              <h1 className="text-lg font-extrabold tracking-wide uppercase text-white mt-1.5">
                ABYSSAL EVO // AI COMMAND DECK
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setActiveHelp(TRAINER_HELP.admins_collection)}
              className="w-7 h-7 rounded bg-cyan-950 border border-cyan-500 text-cyan-300 text-xs font-mono font-bold shrink-0"
              title="How Admin Auth Works"
            >
              ?
            </button>
          </div>

          <div className="p-6 space-y-5">
            <p className="text-xs text-slate-300 leading-relaxed">
              Sign in with an authorized Admin Gmail account listed in the Firestore{' '}
              <code className="text-cyan-300 font-mono">admins</code> collection (
              <code className="text-cyan-300 font-mono">aquarium-caa2b</code>).
            </p>

            {authError && (
              <div className="p-3 rounded bg-[#2a0812] border border-rose-500 text-xs font-mono text-rose-200">
                {authError}
              </div>
            )}

            <button
              type="button"
              disabled={authChecking}
              onClick={async () => {
                setAuthError(null);
                const res = await signInWithGmailPopup();
                if (res.success && res.email) {
                  const check = await verifyAdminInFirestoreCollection(
                    res.email,
                    res.displayName || res.email
                  );
                  if (check.adminRecord) {
                    setAdminUser(check.adminRecord);
                    setAdminsList(check.adminsList);
                    if (typeof sessionStorage !== 'undefined') {
                      sessionStorage.setItem(
                        'abyssal_evo_verified_admin',
                        JSON.stringify(check.adminRecord)
                      );
                    }
                  }
                } else if (res.errorMessage) {
                  setAuthError(res.errorMessage);
                }
              }}
              className="w-full py-3 px-4 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-mono font-extrabold uppercase tracking-wider text-xs flex items-center justify-center gap-2.5"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 bg-white rounded-full p-0.5">
                <path
                  fill="#EA4335"
                  d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"
                />
                <path
                  fill="#4285F4"
                  d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.3 14.8c-.2-.8-.4-1.6-.4-2.5s.2-1.7.4-2.5L1.6 7C.6 9 0 11.2 0 13.5s.6 4.5 1.6 6.5l3.7-2.9z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5l-3.7 2.9C3.5 21.4 7.4 24 12 24z"
                />
              </svg>
              <span>SIGN IN WITH GOOGLE (ADMIN)</span>
            </button>

            <div className="pt-4 border-t border-cyan-900 space-y-2.5">
              <div className="text-[11px] font-mono text-slate-400">
                EMBEDDED PREVIEW / POPUP FALLBACK — VERIFY GMAIL IN FIRESTORE:
              </div>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={manualVerifyEmail}
                  onChange={(e) => setManualVerifyEmail(e.target.value)}
                  placeholder="admin@gmail.com"
                  className="flex-1 bg-[#071426] border border-cyan-800 rounded-lg px-3 py-2 text-xs font-mono text-white"
                />
                <button
                  type="button"
                  onClick={async () => {
                    setAuthError(null);
                    const check = await verifyAdminInFirestoreCollection(manualVerifyEmail);
                    if (check.authorized && check.adminRecord) {
                      setAdminUser(check.adminRecord);
                      setAdminsList(check.adminsList);
                      if (typeof sessionStorage !== 'undefined') {
                        sessionStorage.setItem(
                          'abyssal_evo_verified_admin',
                          JSON.stringify(check.adminRecord)
                        );
                      }
                    } else {
                      setAuthError(
                        `"${manualVerifyEmail}" is not in the Firestore "admins" collection.`
                      );
                    }
                  }}
                  className="px-3.5 py-2 rounded-lg bg-[#071426] border border-cyan-400 text-cyan-200 hover:bg-cyan-400 hover:text-slate-950 text-xs font-mono font-bold uppercase whitespace-nowrap"
                >
                  VERIFY
                </button>
              </div>
            </div>
          </div>
        </div>

        {activeHelp && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d] p-4">
            <div className="w-full max-w-md rounded-xl bg-[#040c1a] border-2 border-cyan-400 p-6 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-cyan-900">
                <h3 className="text-sm font-mono font-extrabold uppercase tracking-wider text-white">
                  {activeHelp.title}
                </h3>
                <button
                  type="button"
                  onClick={() => setActiveHelp(null)}
                  className="px-2.5 py-1 rounded bg-[#071426] border border-cyan-700 text-xs font-mono font-bold text-cyan-200"
                >
                  CLOSE
                </button>
              </div>
              <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
                {activeHelp.explanation}
              </p>
              <div className="p-3 rounded-lg bg-[#071426] border border-cyan-700 text-xs text-cyan-200">
                <strong className="font-mono uppercase text-cyan-400">Example:</strong>{' '}
                {activeHelp.example}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const speciesModels = sortSpeciesModelVersionsNewestFirst(
    ecosystem.modelRegistry.filter((m) => m.speciesId === selectedSpecies.id)
  ).slice(0, MAX_VERSIONS_PER_SPECIES);
  const currentTank = TANK_TIERS[ecosystem.activeTankTier] || TANK_TIERS[0];
  const ownerAutoFeederCount = ecosystem.autoFeederCountByTank[currentTank.id] || 0;

  // Partition local fishes into Online (in player's open game, removed from Keeper) vs Offline (kept alive in Keeper)
  const localOnlineInGameFishes = ecosystem.fishes.filter(
    (f) => f.lineage.alive && activeSessionTankIds.includes(f.lineage.tankId)
  );
  const localOfflineKeeperFishes = ecosystem.fishes.filter(
    (f) => f.lineage.alive && !activeSessionTankIds.includes(f.lineage.tankId)
  );
  const deadFishes = ecosystem.fishes.filter((f) => !f.lineage.alive);

  const brainMetrics = validateAndEstimateBrain(
    selectedSpecies.baseBrainConfig,
    ecosystem.evolutionConfig.maxBrainComplexityParams
  );

  const filteredFamousCatalog = FAMOUS_AQUARIUM_FISHES_50.filter((item) => {
    if (catalogCategory !== 'all' && item.category !== catalogCategory) return false;
    if (!catalogSearch.trim()) return true;
    const q = catalogSearch.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.scientificName.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    );
  });

  return (
    <div className="fixed inset-0 w-full h-full bg-[#02060d] text-slate-100 flex flex-col overflow-hidden select-none">
      {/* Top Console Command Deck Header */}
      <header className="h-14 px-5 bg-[#040c1a] border-b-2 border-cyan-800 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <span className="px-2.5 py-1 rounded bg-cyan-950 border border-cyan-500 text-[11px] font-mono font-extrabold text-cyan-300 uppercase tracking-widest">
            TRAINER HUD v1.8.0
          </span>
          <span className="text-sm font-extrabold uppercase tracking-wider text-white">
            ABYSSAL EVO // AI LAB &amp; 24/7 KEEPER
          </span>
        </div>

        {/* Global CPU Usage Limit Control in Header + Admin Profile */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[#071426] border border-cyan-800 rounded-lg px-3 py-1.5">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-300 font-bold">
              CPU CAP:
            </span>
            <input
              type="range"
              aria-label="CPU Usage Limit Percentage"
              min={10}
              max={100}
              step={5}
              value={cpuUsageLimitPct}
              onChange={(e) => setCpuUsageLimitPct(Number(e.target.value))}
              className="w-20 accent-cyan-400 cursor-pointer"
            />
            <span className="text-xs font-mono font-extrabold text-cyan-300 w-10 text-right">
              {cpuUsageLimitPct === 100 ? 'MAX' : `${cpuUsageLimitPct}%`}
            </span>
            <button
              type="button"
              onClick={() => setActiveHelp(TRAINER_HELP.cpu_usage_limit)}
              className="w-5 h-5 rounded bg-cyan-950 border border-cyan-600 text-cyan-300 text-[11px] font-mono font-bold"
              title="What is CPU Usage Limit?"
            >
              ?
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="px-2.5 py-1 rounded bg-[#071426] border border-emerald-800 text-slate-300 hidden md:inline font-mono text-[11px]">
              ADMIN: <strong className="text-emerald-300">{adminUser.email}</strong>
            </span>
            <button
              type="button"
              onClick={() => {
                signOutAdminUser();
                if (typeof sessionStorage !== 'undefined') {
                  sessionStorage.removeItem('abyssal_evo_verified_admin');
                }
                setAdminUser(null);
              }}
              className="px-3 py-1.5 rounded-lg bg-[#071426] border border-slate-700 text-slate-300 hover:border-rose-500 hover:text-white text-xs font-mono font-bold uppercase"
            >
              SIGN OUT
            </button>
          </div>
        </div>
      </header>

      {/* 5-Tab Console Command Navigation Bar (Shortened Tab Names) */}
      <nav
        aria-label="Trainer Sections"
        className="px-5 py-2 bg-[#061328] border-b border-cyan-900 flex items-center justify-between gap-3 shrink-0 overflow-x-auto"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('train_models')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap border ${
              activeTab === 'train_models'
                ? 'bg-cyan-400 text-slate-950 border-white'
                : 'bg-[#040c1a] text-slate-300 border-cyan-900 hover:border-cyan-500 hover:text-white'
            }`}
          >
            01 // TRAIN AI
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('offline_service')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap border ${
              activeTab === 'offline_service'
                ? 'bg-emerald-400 text-slate-950 border-white'
                : 'bg-[#040c1a] text-slate-300 border-cyan-900 hover:border-emerald-500 hover:text-white'
            }`}
          >
            02 // 24/7 KEEPER ({localOfflineKeeperFishes.length}/{localOnlineInGameFishes.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('species_editor')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap border ${
              activeTab === 'species_editor'
                ? 'bg-amber-400 text-slate-950 border-white'
                : 'bg-[#040c1a] text-slate-300 border-cyan-900 hover:border-amber-500 hover:text-white'
            }`}
          >
            03 // SPECIES ({ecosystem.speciesList.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('brain_lab')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap border ${
              activeTab === 'brain_lab'
                ? 'bg-violet-400 text-slate-950 border-white'
                : 'bg-[#040c1a] text-slate-300 border-cyan-900 hover:border-violet-500 hover:text-white'
            }`}
          >
            04 // BRAIN LAB
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('evolution_lab')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap border ${
              activeTab === 'evolution_lab'
                ? 'bg-sky-400 text-slate-950 border-white'
                : 'bg-[#040c1a] text-slate-300 border-cyan-900 hover:border-sky-500 hover:text-white'
            }`}
          >
            05 // EVOLUTION
          </button>

          <button
            type="button"
            onClick={() => {
              setSelectedCatalogModelId(selectedSpecies.bodyStyle);
              setActiveTab('models_3d');
            }}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap border ${
              activeTab === 'models_3d'
                ? 'bg-fuchsia-400 text-slate-950 border-white'
                : 'bg-[#040c1a] text-slate-300 border-cyan-900 hover:border-fuchsia-500 hover:text-white'
            }`}
          >
            06 // 3D MODELS (10)
          </button>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleResetAllFishesKeepBaseModels}
            className="px-3 py-2 rounded-lg bg-[#2a0812] border border-rose-500 text-rose-200 hover:bg-rose-500 hover:text-white text-xs font-mono font-extrabold uppercase tracking-wider whitespace-nowrap"
            title="Reset all fishes to fresh Gen 1 starters while keeping all trained Base Models and Species properties intact"
          >
            RESET FISHES
          </button>
          <span className="px-2.5 py-1 rounded bg-[#040c1a] border border-cyan-900 text-[11px] font-mono text-cyan-300 hidden xl:inline">
            {firestoreSyncStatus}
          </span>
        </div>
      </nav>

      {statusBanner && (
        <div className="px-5 py-2 bg-[#071f38] border-b border-cyan-500 flex items-center justify-between text-xs font-mono text-cyan-100 shrink-0">
          <span>{statusBanner}</span>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="px-2 py-0.5 rounded bg-[#040c1a] border border-cyan-500 text-cyan-300 hover:text-white font-bold uppercase ml-4"
          >
            DISMISS
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto lab-scroll p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* =====================================================================
              TAB 1: TRAIN BASE MODELS (EXTENDED GENERATIONS 5 TO 1,000+)
             ===================================================================== */}
          {activeTab === 'train_models' && (
            <div className="space-y-6">
              {/* Firestore Storage Location Banner */}
              <div className="p-4 rounded-xl bg-[#0e192d] border border-cyan-500/30 flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-mono uppercase text-cyan-400 font-bold">
                    Where Base Models &amp; Properties Are Saved
                  </div>
                  <div className="text-sm font-semibold text-white mt-0.5">
                    Firestore Project:{' '}
                    <code className="text-cyan-300">aquarium-caa2b</code> → Collection:{' '}
                    <code className="text-emerald-300">
                      base_models/{selectedSpecies.id}__{selectedSpecies.activeBaseModelVersion}
                    </code>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Lifespan: {selectedSpecies.lifespan.lifespanSimHours}h · Maturity:{' '}
                    {selectedSpecies.lifespan.sexualMaturityAgeHours}h · Shop Unlock: Owner Lv.
                    {selectedSpecies.requiredOwnerLevel || 1} ({selectedSpecies.shopPriceCredits || 45}{' '}
                    Credits)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveHelp(TRAINER_HELP.where_base_model_saved)}
                  className="w-8 h-8 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-sm font-bold shrink-0"
                >
                  ?
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-bold text-white">
                      Train AI Base Model (5 to 1,000+ Generations)
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveHelp(TRAINER_HELP.training_focus)}
                      className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                    >
                      ?
                    </button>
                  </div>

                  {/* Step 1: Choose Fish Species (Single or Multi-Species Batch Loop) */}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-xs font-semibold text-slate-300 block">
                        Step 1: Select Fish Species to Train ({batchSelectedSpeciesIds.length} of{' '}
                        {ecosystem.speciesList.length} Selected for Loop Training)
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setBatchSelectedSpeciesIds(ecosystem.speciesList.map((s) => s.id))
                          }
                          className="px-2.5 py-1 rounded bg-cyan-950 border border-cyan-500/60 text-[11px] font-mono font-bold text-cyan-200 hover:bg-cyan-900"
                        >
                          Select All ({ecosystem.speciesList.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const untrained = ecosystem.speciesList
                              .filter((s) => s.activeBaseModelVersion === 'v1.0-base')
                              .map((s) => s.id);
                            setBatchSelectedSpeciesIds(
                              untrained.length > 0 ? untrained : [selectedSpecies.id]
                            );
                          }}
                          className="px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-[11px] font-mono font-bold text-slate-300 hover:border-cyan-500"
                        >
                          Select v1.0 Untrained
                        </button>
                        <button
                          type="button"
                          onClick={() => setBatchSelectedSpeciesIds([selectedSpecies.id])}
                          className="px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-[11px] font-mono font-bold text-slate-300 hover:border-slate-500"
                        >
                          Only Active (1)
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 max-h-52 overflow-y-auto lab-scroll pr-1">
                      {ecosystem.speciesList.map((sp) => {
                        const isBatchChecked = batchSelectedSpeciesIds.includes(sp.id);
                        const isFocused = selectedSpecies.id === sp.id;
                        return (
                          <button
                            key={sp.id}
                            type="button"
                            onClick={() => {
                              setSelectedSpeciesId(sp.id);
                              setBatchSelectedSpeciesIds((prev) => {
                                if (prev.includes(sp.id)) {
                                  return prev.length > 1
                                    ? prev.filter((id) => id !== sp.id)
                                    : prev;
                                }
                                return [...prev, sp.id];
                              });
                            }}
                            className={`p-3 rounded-xl border text-left transition-colors ${
                              isBatchChecked
                                ? isFocused
                                  ? 'bg-cyan-500/25 border-2 border-cyan-400 text-white'
                                  : 'bg-cyan-950/50 border border-cyan-500/60 text-white'
                                : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-3 h-3 rounded-full shrink-0"
                                  style={{ backgroundColor: sp.primaryColorHex }}
                                />
                                <span className="text-xs font-bold truncate">{sp.name}</span>
                              </div>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-extrabold shrink-0 ${
                                  isBatchChecked
                                    ? 'bg-cyan-400 text-slate-950'
                                    : 'bg-slate-800 text-slate-400'
                                }`}
                              >
                                {isBatchChecked ? '[✓]' : '[ ]'}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-cyan-300 mt-1">
                              {sp.activeBaseModelVersion} · {sp.lifespan.lifespanSimHours}h Life
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Step 2: Choose Training Focus */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300 block">
                      Step 2: Training Focus &amp; Reward Shaping
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {(
                        [
                          [
                            'balanced',
                            'Balanced All-Rounder',
                            'Finds top-surface food & conserves metabolic energy',
                          ],
                          [
                            'forager',
                            'Fast Surface Forager',
                            'Maximizes top-water pellet detection & speed',
                          ],
                          [
                            'survivor',
                            'Resilient Survivor',
                            'Prioritizes hazard evasion & long-life stamina',
                          ],
                        ] as const
                      ).map(([goalId, title, desc]) => (
                        <button
                          key={goalId}
                          type="button"
                          onClick={() => setTrainingGoal(goalId)}
                          className={`p-3 rounded-xl border text-left transition-colors ${
                            trainingGoal === goalId
                              ? 'bg-emerald-500/20 border-emerald-400 text-white'
                              : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-bold">{title}</div>
                          <div className="text-[11px] text-slate-400 mt-1">{desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Step 3: Extended Generations (5 to 1,000+) & Population */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                    <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">
                          Generations per Species
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={5000}
                          value={trainGenerations}
                          onChange={(e) =>
                            setTrainGenerations(Math.max(1, Number(e.target.value) || 15))
                          }
                          className="w-24 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 text-right"
                        />
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {[5, 15, 30, 50, 100, 250, 500, 1000].map((gCount) => (
                          <button
                            key={gCount}
                            type="button"
                            onClick={() => setTrainGenerations(gCount)}
                            className={`py-1.5 rounded text-[11px] font-mono font-bold border ${
                              trainGenerations === gCount
                                ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'
                            }`}
                          >
                            {gCount}G
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">
                          PC / Phone CPU Usage Limit
                        </span>
                        <span className="text-xs font-mono font-bold text-cyan-300">
                          {cpuUsageLimitPct === 100 ? '100% (Max Speed)' : `${cpuUsageLimitPct}%`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        step={5}
                        value={cpuUsageLimitPct}
                        onChange={(e) => setCpuUsageLimitPct(Number(e.target.value))}
                        className="w-full accent-cyan-400 cursor-pointer"
                      />
                      <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                        <span>Population / Gen:</span>
                        <input
                          type="number"
                          min={8}
                          max={128}
                          value={trainPopulationSize}
                          onChange={(e) =>
                            setTrainPopulationSize(Math.max(8, Number(e.target.value) || 24))
                          }
                          className="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono text-white text-right"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Start / Stop Training Button & Live Progress Bar */}
                  <div className="pt-2 space-y-3">
                    {!isTrainingNow ? (
                      <button
                        type="button"
                        onClick={handleStartCpuThrottledTraining}
                        className="w-full py-3.5 rounded-xl bg-cyan-400 text-slate-950 font-bold text-sm hover:bg-cyan-300 transition-colors shadow-lg"
                      >
                        {batchSelectedSpeciesIds.length > 1
                          ? `Start Batch Loop Training (${batchSelectedSpeciesIds.length} Species × ${trainGenerations} Generations at ${cpuUsageLimitPct}% CPU)`
                          : `Start Training ${selectedSpecies.name} (${trainGenerations} Generations at ${cpuUsageLimitPct}% CPU)`}
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-cyan-300">
                            Species {batchCurrentIndex}/{batchTotalCount} [{batchCurrentSpeciesName}]
                            — Gen {trainingProgressGen} of {trainGenerations} (CPU capped at{' '}
                            {cpuUsageLimitPct}%)...
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              cancelTrainingRef.current = true;
                            }}
                            className="px-3 py-1 rounded bg-rose-500/20 border border-rose-500/40 text-rose-300 font-bold"
                          >
                            Stop Early
                          </button>
                        </div>
                        <div className="w-full h-3 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                          <div
                            className="h-full bg-cyan-400 transition-all"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (((batchCurrentIndex - 1) * trainGenerations +
                                    trainingProgressGen) /
                                    Math.max(1, batchTotalCount * trainGenerations)) *
                                    100
                                )
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {lastTrainingSummary && (
                      <div className="p-3.5 rounded-xl bg-emerald-950/50 border border-emerald-500/40 text-xs text-emerald-200">
                        {lastTrainingSummary}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: Saved Versions for Selected Fish Type */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 flex flex-col justify-between space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-white">
                          Last 5 Versions ({selectedSpecies.name}) — Newest First
                        </h3>
                        <p className="text-xs text-slate-400">
                          Max 5 kept in <code className="text-cyan-300">base_models</code> (older
                          versions auto-deleted)
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveHelp(TRAINER_HELP.where_base_model_saved)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                      >
                        ?
                      </button>
                    </div>

                    <div className="space-y-2.5 max-h-[380px] overflow-y-auto lab-scroll pr-1">
                      {speciesModels.map((m, idx) => (
                        <div
                          key={m.versionId}
                          className={`p-3.5 rounded-xl border space-y-2 ${
                            m.isPromotedBase
                              ? 'bg-emerald-950/30 border-emerald-500/50'
                              : 'bg-slate-900/90 border-slate-800'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-cyan-300">
                                #{idx + 1}
                              </span>
                              <span className="text-xs font-mono font-bold text-white">
                                {m.versionId}
                              </span>
                              {(m.brainConfig?.aggressiveness ?? 0) > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-rose-950 border border-rose-500/50 text-[10px] font-mono text-rose-300">
                                  AGG {((m.brainConfig.aggressiveness ?? 0) * 100).toFixed(0)}%
                                </span>
                              )}
                            </div>
                            {m.isPromotedBase ? (
                              <span className="text-[10px] font-mono font-bold text-emerald-300 uppercase">
                                Default Active
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSetActiveBaseModel(m.versionId)}
                                className="px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 text-[11px] font-semibold"
                              >
                                Set as Default
                              </button>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-300 tabular-nums">
                            <div>Food Finding: {m.benchmark.foragingEfficiency}%</div>
                            <div>Survival: {m.benchmark.survivalRatePct}%</div>
                            <div>Harm Avoid: {m.benchmark.harmAvoidance}%</div>
                            <div className="text-cyan-300 font-bold">
                              Composite: {m.benchmark.overallComposite}%
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-[11px] text-slate-400">
                    Want to edit {selectedSpecies.name}&rsquo;s lifespan, maturity age, or pick
                    from 50 famous fishes? Switch to Tab 3!
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 2: DYNAMIC 24/7 OFFLINE FISH KEEPER (WITH OWNER AUTO-FEEDER CHECK)
             ===================================================================== */}
          {activeTab === 'offline_service' && (() => {
            // Build unified list of all users (local owner + all Firestore cloudUsers)
            interface KeeperUnifiedUser {
              username: string;
              profileId: string;
              isOnlineInGame: boolean;
              autoFeederCount: number;
              liveOfflineCount: number;
              liveOnlineCount: number;
              deadCount: number;
              totalCount: number;
            }

            interface KeeperUnifiedFishRow {
              fishId: string;
              ownerUsername: string;
              name: string;
              speciesId: string;
              generation: number;
              modelVersion: string;
              alive: boolean;
              causeOfDeath: string | null;
              isOnlineInGame: boolean;
              energy: number;
              hunger: number;
              health: number;
              stress: number;
              ageSimHours: number;
              lifeStage: string;
              offspringProduced: number;
              foodPelletsEaten: number;
              decisionsMade: number;
              hiddenLayersLabel: string;
              mutationsCount: number;
              maxSpeedGene: number;
              bodyScaleGene: number;
              aggressiveness: number;
              attacksPerformed: number;
            }

            const localRemovedSet = new Set(ecosystem.removedFishIds || []);
            const localOwnerOnline = activeSessionTankIds.includes(currentTank.id);
            const allUnifiedFishes: KeeperUnifiedFishRow[] = [];

            // 1. Add local owner's fishes (excluding removed dead fishes)
            for (const f of ecosystem.fishes) {
              if (localRemovedSet.has(f.lineage.fishId)) continue;
              const isOnline = activeSessionTankIds.includes(f.lineage.tankId);
              allUnifiedFishes.push({
                fishId: f.lineage.fishId,
                ownerUsername: profileName,
                name: f.lineage.name,
                speciesId: f.lineage.speciesId,
                generation: f.lineage.generation,
                modelVersion: f.lineage.modelVersion,
                alive: f.lineage.alive,
                causeOfDeath: f.lineage.causeOfDeath,
                isOnlineInGame: isOnline,
                energy: f.state.energy,
                hunger: f.state.hunger,
                health: f.state.health,
                stress: f.state.stress,
                ageSimHours: f.state.ageSimHours,
                lifeStage: f.state.lifeStage,
                offspringProduced: f.state.metrics.offspringProduced,
                foodPelletsEaten: f.state.metrics.foodPelletsEaten,
                decisionsMade: f.state.metrics.decisionsMade,
                hiddenLayersLabel: f.brain.architecture.hiddenLayers.join(', '),
                mutationsCount: f.lineage.inheritedMutations.length,
                maxSpeedGene: f.genetics.maxSpeedGene,
                bodyScaleGene: f.genetics.bodyScaleGene,
                aggressiveness:
                  f.brain.architecture.aggressiveness ?? f.genetics.aggressivenessGene ?? 0,
                attacksPerformed: f.state.metrics.attacksPerformed ?? 0,
              });
            }

            // 2. Add all remote cloud users' fishes from Firestore `mypc_user_brains`
            for (const cu of cloudUsers) {
              if (cu.username === profileName) continue;
              const cuRemovedSet = new Set(cu.removedFishIds || []);
              const isCuOnline =
                Boolean(cu.isActivelyPlaying) &&
                Date.now() - (cu.lastGameHeartbeatMs || 0) < 300000;
              for (const b of cu.fishBrains) {
                if (cuRemovedSet.has(b.fishId)) continue;
                const sp =
                  ecosystem.speciesList.find((s) => s.id === b.speciesId) ||
                  ecosystem.speciesList[0] ||
                  DEFAULT_SPECIES_LIST[0];
                allUnifiedFishes.push({
                  fishId: b.fishId,
                  ownerUsername: cu.username,
                  name: b.name,
                  speciesId: b.speciesId,
                  generation: b.generation || 1,
                  modelVersion: b.modelVersion || 'v1.0-base',
                  alive: b.alive,
                  causeOfDeath: b.causeOfDeath || null,
                  isOnlineInGame: isCuOnline,
                  energy: b.energy ?? 80,
                  hunger: b.hunger ?? 20,
                  health: b.alive ? 100 : 0,
                  stress: b.alive ? 10 : 100,
                  ageSimHours: b.ageSimHours ?? 1,
                  lifeStage:
                    (b.ageSimHours ?? 1) < sp.lifespan.sexualMaturityAgeHours
                      ? 'juvenile'
                      : 'adult',
                  offspringProduced: 0,
                  foodPelletsEaten: 0,
                  decisionsMade: 0,
                  hiddenLayersLabel:
                    b.brain?.architecture?.hiddenLayers?.join(', ') || '16, 12',
                  mutationsCount: 0,
                  maxSpeedGene: 1.0,
                  bodyScaleGene: 1.0,
                  aggressiveness:
                    b.brain?.architecture?.aggressiveness ??
                    sp.baseBrainConfig?.aggressiveness ??
                    0,
                  attacksPerformed: 0,
                });
              }
            }

            const allUnifiedUsers: KeeperUnifiedUser[] = [
              {
                username: profileName,
                profileId,
                isOnlineInGame: localOwnerOnline,
                autoFeederCount: ownerAutoFeederCount,
                liveOfflineCount: localOfflineKeeperFishes.length,
                liveOnlineCount: localOnlineInGameFishes.length,
                deadCount: deadFishes.length,
                totalCount: ecosystem.fishes.length,
              },
              ...cloudUsers
                .filter((cu) => cu.username !== profileName)
                .map((cu) => {
                  const isCuOnline =
                    Boolean(cu.isActivelyPlaying) &&
                    Date.now() - (cu.lastGameHeartbeatMs || 0) < 180000;
                  const liveCount = cu.fishBrains.filter((b) => b.alive).length;
                  const deadCnt = cu.fishBrains.filter((b) => !b.alive).length;
                  return {
                    username: cu.username,
                    profileId: cu.profileId,
                    isOnlineInGame: isCuOnline,
                    autoFeederCount: cu.autoFeederStock || 0,
                    liveOfflineCount: isCuOnline ? 0 : liveCount,
                    liveOnlineCount: isCuOnline ? liveCount : 0,
                    deadCount: deadCnt,
                    totalCount: cu.fishBrains.length,
                  };
                }),
            ];

            // Filter by selected user in Users List ('ALL' or specific username)
            const userFilteredFishes =
              selectedKeeperUserFilter === 'ALL'
                ? allUnifiedFishes
                : allUnifiedFishes.filter((f) => f.ownerUsername === selectedKeeperUserFilter);

            // Filter by status tab ('all' | 'offline' | 'dead')
            const displayedFishes =
              fishListFilter === 'offline'
                ? userFilteredFishes.filter((f) => f.alive && !f.isOnlineInGame)
                : fishListFilter === 'dead'
                ? userFilteredFishes.filter((f) => !f.alive)
                : userFilteredFishes;

            const activeSelectedRow: KeeperUnifiedFishRow | null =
              allUnifiedFishes.find(
                (f) =>
                  f.fishId === selectedFishId &&
                  (selectedKeeperUserFilter === 'ALL' ||
                    f.ownerUsername === selectedKeeperUserFilter)
              ) ||
              displayedFishes[0] ||
              userFilteredFishes[0] ||
              allUnifiedFishes[0] ||
              null;

            const selectedFishSpecies = activeSelectedRow
              ? ecosystem.speciesList.find((s) => s.id === activeSelectedRow.speciesId) ||
                ecosystem.speciesList[0]
              : null;

            const totalOfflineKeeperCount = allUnifiedFishes.filter(
              (f) => f.alive && !f.isOnlineInGame
            ).length;
            const totalOnlineInGameCount = allUnifiedFishes.filter(
              (f) => f.alive && f.isOnlineInGame
            ).length;
            const totalDeadCount = allUnifiedFishes.filter((f) => !f.alive).length;

            // Catalog of all species options (active species + 50 Famous Fishes) for Give / Replace
            const allSpeciesOptions: { id: string; name: string; category: string }[] = [
              ...ecosystem.speciesList.map((s) => ({
                id: s.id,
                name: `${s.name} (Active in Tank Catalog)`,
                category: 'Active Species',
              })),
              ...FAMOUS_AQUARIUM_FISHES_50.filter(
                (tpl) => !ecosystem.speciesList.some((s) => s.id === tpl.id)
              ).map((tpl) => ({
                id: tpl.id,
                name: `#${tpl.rank} ${tpl.name} (${tpl.scientificName})`,
                category: '50 Famous Fishes',
              })),
            ];

            return (
              <div className="space-y-6">
                {/* Top Explanation & Controls Card */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="max-w-2xl">
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold text-white">
                          Dynamic 24/7 Fish Keeper Service (All Users &amp; All Fishes Inspector)
                        </h2>
                        <button
                          type="button"
                          onClick={() => setActiveHelp(TRAINER_HELP.offline_24_7_service)}
                          className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                        >
                          ?
                        </button>
                      </div>
                      <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                        Click any user in the <strong className="text-cyan-300">Users List</strong>{' '}
                        to inspect all of their fishes, give them new fishes (bypassing tank capacity),
                        replace a fish with another species, or starve/reproduce any fish. When you
                        kill/starve a fish here, an{' '}
                        <strong className="text-rose-300">authoritative override</strong> is pushed
                        immediately so even if the user has the game open right now, their fish turns
                        dead and <strong className="text-slate-300">greyed out</strong> in real time.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => setServiceRunning((v) => !v)}
                        className={`px-4 py-2 rounded-xl text-xs font-bold ${
                          serviceRunning
                            ? 'bg-emerald-400 text-slate-950'
                            : 'bg-rose-500 text-white'
                        }`}
                      >
                        {serviceRunning ? '24/7 Keeper: RUNNING' : '24/7 Keeper: PAUSED'}
                      </button>

                      {/* Feeder Mode Selector (Default = Owner's Feeder) */}
                      <div className="flex items-center rounded-xl bg-slate-950 p-1 border border-slate-800 text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            setTrainerOverrideFeederEnabled(false);
                            setDisableAllFeedersInKeeper(false);
                          }}
                          className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                            !trainerOverrideFeederEnabled && !disableAllFeedersInKeeper
                              ? 'bg-amber-400 text-slate-950'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          Owner Feeder (Default: {ownerAutoFeederCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTrainerOverrideFeederEnabled(true);
                            setDisableAllFeedersInKeeper(false);
                          }}
                          className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                            trainerOverrideFeederEnabled && !disableAllFeedersInKeeper
                              ? 'bg-cyan-400 text-slate-950'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          Trainer Override Feeder
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTrainerOverrideFeederEnabled(false);
                            setDisableAllFeedersInKeeper(true);
                          }}
                          className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                            disableAllFeedersInKeeper
                              ? 'bg-rose-500 text-white'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          No Feeder (Starve)
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Live Summary Counters */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">
                        Offline Fishes Alive in Keeper
                      </div>
                      <div className="text-2xl font-mono font-bold text-emerald-400 mt-1 tabular-nums">
                        {totalOfflineKeeperCount}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Across {allUnifiedUsers.length} User(s)
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">
                        Online Fishes in User Game
                      </div>
                      <div className="text-2xl font-mono font-bold text-amber-300 mt-1 tabular-nums">
                        {totalOnlineInGameCount}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Paused here · Running in User Game
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">Active Feeder (Default: User)</div>
                      <div className="text-sm font-mono font-bold text-cyan-300 mt-2">
                        {disableAllFeedersInKeeper
                          ? 'DISABLED (Starving)'
                          : trainerOverrideFeederEnabled
                          ? 'Trainer Global Feeder'
                          : ownerAutoFeederCount > 0
                          ? `User Feeder (${ownerAutoFeederCount} Active)`
                          : 'User Has 0 Feeders (Starvation Risk)'}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Dead / Starved Fishes (Greyed): {totalDeadCount}
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">Keeper Time &amp; Speed</div>
                      <div className="text-2xl font-mono font-bold text-white mt-1 tabular-nums">
                        {serviceSpeed}x · {serviceStats.simHoursElapsedInService.toFixed(2)}h
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Default 1x · Firestore 4m Checkpoint
                      </div>
                    </div>
                  </div>

                  {/* Action Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleToggleSimulatedOwnerOnlineState}
                        className="px-3.5 py-2 rounded-lg bg-amber-400 text-slate-950 text-xs font-bold hover:bg-amber-300"
                      >
                        {activeSessionTankIds.includes(currentTank.id)
                          ? 'Bring Fishes into Keeper (Simulate User Offline)'
                          : 'Return Fishes to User Game (Simulate User Online)'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleStarveFish(
                            activeSelectedRow?.fishId,
                            activeSelectedRow?.ownerUsername
                          )
                        }
                        className="px-3.5 py-2 rounded-lg bg-rose-600 text-white text-xs font-bold hover:bg-rose-500 shadow"
                      >
                        Die from Starvation (Starve Selected Fish)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleReproduceFish(
                            activeSelectedRow?.fishId,
                            activeSelectedRow?.ownerUsername
                          )
                        }
                        className="px-3.5 py-2 rounded-lg bg-fuchsia-500 text-white text-xs font-bold hover:bg-fuchsia-400 shadow"
                      >
                        Reproduce Selected Fish (Have a Baby)
                      </button>
                      <button
                        type="button"
                        onClick={handleFeedOfflineFishes}
                        className="px-3.5 py-2 rounded-lg bg-emerald-400 text-slate-950 text-xs font-bold hover:bg-emerald-300"
                      >
                        Feed All Offline (+35% Energy)
                      </button>
                      <button
                        type="button"
                        onClick={handleAddOfflinePair}
                        className="px-3.5 py-2 rounded-lg bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 text-xs font-bold hover:bg-cyan-500/30"
                      >
                        + Add 2 Fishes
                      </button>
                      <button
                        type="button"
                        onClick={handleResetAllFishesKeepBaseModels}
                        className="px-3.5 py-2 rounded-lg bg-rose-500/20 border border-rose-400/60 text-rose-200 text-xs font-bold hover:bg-rose-500 hover:text-white"
                      >
                        Reset All Fishes (Keep Base Models)
                      </button>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-slate-400">Keeper Time Speed (Default 1x):</span>
                      {[1, 2, 6, 12, 24].map((spd) => (
                        <button
                          key={spd}
                          type="button"
                          onClick={() => setServiceSpeed(spd)}
                          className={`px-2.5 py-1 rounded font-mono font-bold ${
                            serviceSpeed === spd
                              ? 'bg-cyan-400 text-slate-950'
                              : 'bg-slate-900 text-slate-300 border border-slate-800'
                          }`}
                        >
                          {spd}x
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* =================================================================
                    ADMIN GIFT PANEL: GIVE FISH TO ANY USER (BYPASSES TANK CAPACITY)
                   ================================================================= */}
                <div className="p-5 rounded-2xl bg-[#0e192d] border border-cyan-500/40 flex flex-wrap items-end justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-xs font-mono font-bold uppercase text-cyan-300">
                      Give Fishes to User (Admin Gift — Bypasses Tank Capacity Limit)
                    </div>
                    <p className="text-xs text-slate-300">
                      Select any user (or click a user in the Users List below), choose any fish
                      species, and gift 1–5 live fishes directly into their aquarium.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="text-[11px] font-mono text-slate-300 block mb-1">
                        Target User
                      </label>
                      <select
                        aria-label="Target User to Give Fish"
                        value={giftTargetUsername}
                        onChange={(e) => setGiftTargetUsername(e.target.value)}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-bold text-white min-w-[150px]"
                      >
                        {allUnifiedUsers.map((u) => (
                          <option key={u.username} value={u.username}>
                            {u.username} ({u.totalCount} fishes)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-mono text-slate-300 block mb-1">
                        Fish Species to Give
                      </label>
                      <select
                        aria-label="Fish Species to Give"
                        value={giftSpeciesId}
                        onChange={(e) => setGiftSpeciesId(e.target.value)}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-bold text-cyan-300 min-w-[230px]"
                      >
                        {allSpeciesOptions.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-mono text-slate-300 block mb-1">
                        Quantity
                      </label>
                      <select
                        aria-label="Gift Fish Quantity"
                        value={giftQuantity}
                        onChange={(e) => setGiftQuantity(Number(e.target.value) || 1)}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono font-bold text-white"
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            +{n} Fish{n > 1 ? 'es' : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      onClick={handleGiveFishToUser}
                      className="px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold shadow-lg transition-colors"
                    >
                      + Give Fish to {giftTargetUsername}
                    </button>
                  </div>
                </div>

                {/* =================================================================
                    CLICKABLE USERS LIST + ALL FISHES LIST + SELECTED FISH INSPECTOR
                   ================================================================= */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Left 3 Columns: Clickable Users List */}
                  <div className="lg:col-span-3 p-5 rounded-2xl bg-[#101827] border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-white">
                          Users List ({allUnifiedUsers.length})
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          Click a user to view &amp; manage their fishes
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setSelectedKeeperUserFilter('ALL');
                        setFishListFilter('all');
                      }}
                      className={`w-full p-3 rounded-xl border text-left transition-all ${
                        selectedKeeperUserFilter === 'ALL'
                          ? 'bg-cyan-950/70 border-2 border-cyan-400 text-white shadow'
                          : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold">ALL USERS (Show Every Fish)</span>
                        <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-mono font-bold">
                          {allUnifiedFishes.length} Total
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        {totalOfflineKeeperCount} Keeper · {totalOnlineInGameCount} Online ·{' '}
                        {totalDeadCount} Dead
                      </div>
                    </button>

                    <div className="space-y-2 max-h-[420px] overflow-y-auto lab-scroll pr-1">
                      {allUnifiedUsers.map((u) => {
                        const isUserSelected = selectedKeeperUserFilter === u.username;
                        return (
                          <button
                            key={u.username}
                            type="button"
                            onClick={() => {
                              setSelectedKeeperUserFilter(u.username);
                              setGiftTargetUsername(u.username);
                              setFishListFilter('all');
                              const firstUserFish = allUnifiedFishes.find(
                                (f) => f.ownerUsername === u.username
                              );
                              if (firstUserFish) {
                                setSelectedFishId(firstUserFish.fishId);
                                setSelectedFishOwnerUsername(u.username);
                              }
                            }}
                            className={`w-full p-3 rounded-xl border text-left transition-all ${
                              isUserSelected
                                ? 'bg-cyan-950/70 border-2 border-cyan-400 ring-2 ring-cyan-400/20 text-white shadow'
                                : 'bg-slate-900/90 border-slate-800 text-slate-200 hover:border-slate-600'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold truncate">
                                {u.username}
                                {u.username === profileName ? ' (You)' : ''}
                              </span>
                              <span
                                className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                                  u.isOnlineInGame
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
                                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                                }`}
                              >
                                {u.isOnlineInGame ? 'ONLINE' : 'IN KEEPER'}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 mt-1.5">
                              {u.totalCount} Fishes ({u.liveOfflineCount + u.liveOnlineCount} Live ·{' '}
                              {u.deadCount} Dead)
                            </div>
                            <div className="text-[10px] font-mono text-cyan-300/90 mt-0.5">
                              Owner Feeder:{' '}
                              {u.autoFeederCount > 0
                                ? `Installed (${u.autoFeederCount})`
                                : 'None (0)'}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Middle 5 Columns: Selectable Fishes List with Clear Highlight */}
                  <div className="lg:col-span-5 p-5 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-white">
                          Fishes List ({selectedKeeperUserFilter === 'ALL' ? 'All Users' : selectedKeeperUserFilter}) — {displayedFishes.length} Shown
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          Click any fish to inspect details, starve, reproduce, or change species
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setFishListFilter('all')}
                          className={`px-2.5 py-1 rounded-lg font-bold ${
                            fishListFilter === 'all'
                              ? 'bg-cyan-400 text-slate-950'
                              : 'bg-slate-900 text-slate-300'
                          }`}
                        >
                          All ({userFilteredFishes.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setFishListFilter('offline')}
                          className={`px-2.5 py-1 rounded-lg font-bold ${
                            fishListFilter === 'offline'
                              ? 'bg-emerald-400 text-slate-950'
                              : 'bg-slate-900 text-slate-300'
                          }`}
                        >
                          Offline ({userFilteredFishes.filter((f) => f.alive && !f.isOnlineInGame).length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setFishListFilter('dead')}
                          className={`px-2.5 py-1 rounded-lg font-bold ${
                            fishListFilter === 'dead'
                              ? 'bg-slate-400 text-slate-950'
                              : 'bg-slate-900 text-slate-300'
                          }`}
                        >
                          Dead ({userFilteredFishes.filter((f) => !f.alive).length})
                        </button>
                      </div>
                    </div>

                    {displayedFishes.length === 0 ? (
                      <div className="p-6 rounded-xl bg-slate-900/80 border border-slate-800 text-center text-xs text-slate-400">
                        No fishes match the current filter. Click &ldquo;All&rdquo; or use the
                        &ldquo;Give Fishes to User&rdquo; panel above to add fishes!
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[480px] overflow-y-auto lab-scroll pr-1">
                        {displayedFishes.map((f) => {
                          const isSelected =
                            activeSelectedRow?.fishId === f.fishId &&
                            activeSelectedRow?.ownerUsername === f.ownerUsername;
                          const sp =
                            ecosystem.speciesList.find((s) => s.id === f.speciesId) ||
                            ecosystem.speciesList[0];

                          return (
                            <div
                              key={`${f.ownerUsername}__${f.fishId}`}
                              onClick={() => {
                                setSelectedFishId(f.fishId);
                                setSelectedFishOwnerUsername(f.ownerUsername);
                                setGiftTargetUsername(f.ownerUsername);
                              }}
                              className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                                isSelected
                                  ? 'bg-cyan-950/60 border-2 border-cyan-400 ring-2 ring-cyan-400/30 shadow-lg'
                                  : !f.alive
                                  ? 'bg-slate-900/75 border-slate-500/60 grayscale opacity-85 hover:border-slate-400'
                                  : 'bg-slate-900/90 border-slate-800 hover:border-slate-600'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                      className="w-3 h-3 rounded-full shrink-0 border border-white/30"
                                      style={{
                                        backgroundColor: !f.alive
                                          ? '#9ca3af'
                                          : sp?.primaryColorHex || '#38bdf8',
                                      }}
                                    />
                                    {isSelected && (
                                      <span className="px-2 py-0.5 rounded bg-cyan-400 text-slate-950 text-[10px] font-mono font-bold uppercase">
                                        SELECTED
                                      </span>
                                    )}
                                    <span
                                      className={`px-2 py-0.5 rounded font-mono text-xs font-extrabold border ${
                                        !f.alive
                                          ? 'bg-slate-800 border-slate-500 text-slate-300 line-through'
                                          : 'bg-cyan-950 border-cyan-400 text-cyan-200'
                                      }`}
                                      title="Player-assigned fish name"
                                    >
                                      [{f.name}]
                                    </span>
                                    <span className="text-xs font-mono text-cyan-300">
                                      Gen {f.generation}
                                    </span>
                                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 text-[10px] font-mono">
                                      Owner: {f.ownerUsername}
                                    </span>
                                    {!f.alive ? (
                                      <span className="px-2 py-0.5 rounded bg-slate-700 border border-slate-400 text-slate-100 text-[10px] font-mono font-bold uppercase">
                                        DEAD · GREYED ({f.causeOfDeath || 'starvation'})
                                      </span>
                                    ) : f.isOnlineInGame ? (
                                      <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-amber-300 text-[10px] font-mono font-bold uppercase">
                                        IN OWNER GAME
                                      </span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-[10px] font-mono font-bold uppercase">
                                        ALIVE IN KEEPER
                                      </span>
                                    )}
                                  </div>

                                  <div className="text-[11px] font-mono text-slate-400">
                                    {sp?.name || f.speciesId} ({f.lifeStage}) · Age:{' '}
                                    {f.ageSimHours.toFixed(1)}h /{' '}
                                    {sp?.lifespan.lifespanSimHours || 24}h · Energy:{' '}
                                    {f.alive ? `${f.energy.toFixed(0)}%` : '0% (Starved)'}
                                  </div>
                                </div>

                                {/* Quick Row Actions */}
                                <div
                                  className="flex items-center gap-1.5"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {f.alive ? (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedFishId(f.fishId);
                                          setSelectedFishOwnerUsername(f.ownerUsername);
                                          handleStarveFish(f.fishId, f.ownerUsername);
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold"
                                        title="Kill this fish by starvation (even if owner has game open)"
                                      >
                                        Starve
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedFishId(f.fishId);
                                          setSelectedFishOwnerUsername(f.ownerUsername);
                                          handleReproduceFish(f.fishId, f.ownerUsername);
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-400 text-white text-[11px] font-bold"
                                        title="Make this fish have a baby immediately"
                                      >
                                        Reproduce
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedFishId(f.fishId);
                                          setSelectedFishOwnerUsername(f.ownerUsername);
                                          handleReviveFish(f.fishId, f.ownerUsername);
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-bold"
                                      >
                                        Revive
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          handleDeleteDeadFishInTrainer(f.fishId, f.ownerUsername);
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-rose-950 border border-rose-500/60 hover:bg-rose-800 text-rose-200 text-[11px] font-bold"
                                        title="Permanently delete this dead body from database"
                                      >
                                        Remove Body
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Right 4 Columns: Selected Fish Details, Actions & Change Species Inspector */}
                  <div className="lg:col-span-4 space-y-5">
                    <div className="p-5 rounded-2xl bg-[#101827] border-2 border-cyan-500/50 space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <div>
                          <span className="text-[10px] font-mono font-bold uppercase text-cyan-300">
                            Selected Fish Inspector &amp; Actions
                          </span>
                          <h3 className="text-base font-bold text-white mt-0.5 flex items-center gap-2 flex-wrap">
                            {activeSelectedRow ? (
                              <>
                                <span className="px-2 py-0.5 rounded bg-cyan-950 border border-cyan-400 text-cyan-200 font-mono text-sm">
                                  [{activeSelectedRow.name}]
                                </span>
                                <span className="text-xs font-mono text-slate-300">
                                  (Gen {activeSelectedRow.generation})
                                </span>
                              </>
                            ) : (
                              'No Fish Selected'
                            )}
                          </h3>
                          {activeSelectedRow && (
                            <div className="text-xs font-mono text-slate-400 mt-1">
                              Owner: <strong className="text-cyan-300">{activeSelectedRow.ownerUsername}</strong>
                            </div>
                          )}
                        </div>
                        {activeSelectedRow && (
                          <span
                            className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold ${
                              !activeSelectedRow.alive
                                ? 'bg-slate-700 text-slate-200 border border-slate-400'
                                : activeSelectedRow.isOnlineInGame
                                ? 'bg-amber-400 text-slate-950'
                                : 'bg-emerald-400 text-slate-950'
                            }`}
                          >
                            {!activeSelectedRow.alive
                              ? `DEAD · GREYED`
                              : activeSelectedRow.isOnlineInGame
                              ? 'IN OWNER GAME'
                              : 'IN KEEPER'}
                          </span>
                        )}
                      </div>

                      {activeSelectedRow ? (
                        <>
                          {/* Actions Panel for Selected Fish */}
                          <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2.5">
                            <div className="text-xs font-mono font-bold text-cyan-300 uppercase">
                              Fish Actions ([{activeSelectedRow.name}])
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                disabled={!activeSelectedRow.alive}
                                onClick={() =>
                                  handleStarveFish(
                                    activeSelectedRow.fishId,
                                    activeSelectedRow.ownerUsername
                                  )
                                }
                                className="py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-bold transition-colors shadow"
                              >
                                Starve (Kill by Starvation)
                              </button>
                              <button
                                type="button"
                                disabled={!activeSelectedRow.alive}
                                onClick={() =>
                                  handleReproduceFish(
                                    activeSelectedRow.fishId,
                                    activeSelectedRow.ownerUsername
                                  )
                                }
                                className="py-2.5 px-3 rounded-xl bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-40 text-white text-xs font-bold transition-colors shadow"
                              >
                                Reproduce (Have a Baby)
                              </button>
                              <button
                                type="button"
                                disabled={!activeSelectedRow.alive}
                                onClick={() =>
                                  handleFeedSingleFish(
                                    activeSelectedRow.fishId,
                                    activeSelectedRow.ownerUsername
                                  )
                                }
                                className="py-2 px-3 rounded-xl bg-emerald-500/20 border border-emerald-400/50 hover:bg-emerald-500/30 disabled:opacity-40 text-emerald-200 text-xs font-bold transition-colors"
                              >
                                Feed Fish (+50% Energy)
                              </button>
                              <button
                                type="button"
                                disabled={activeSelectedRow.alive}
                                onClick={() =>
                                  handleReviveFish(
                                    activeSelectedRow.fishId,
                                    activeSelectedRow.ownerUsername
                                  )
                                }
                                className="py-2 px-3 rounded-xl bg-cyan-500/20 border border-cyan-400/50 hover:bg-cyan-500/30 disabled:opacity-40 text-cyan-200 text-xs font-bold transition-colors"
                              >
                                Revive Dead Fish
                              </button>
                              {!activeSelectedRow.alive && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleDeleteDeadFishInTrainer(
                                      activeSelectedRow.fishId,
                                      activeSelectedRow.ownerUsername
                                    )
                                  }
                                  className="col-span-2 py-2 px-3 rounded-xl bg-rose-950 border border-rose-500/60 hover:bg-rose-800 text-rose-200 text-xs font-bold transition-colors"
                                >
                                  Remove Dead Body Permanently from Database
                                </button>
                              )}
                            </div>

                            {/* Change / Replace This Fish By Another Species */}
                            <div className="pt-2.5 border-t border-slate-800 space-y-2">
                              <label className="text-[11px] font-mono font-bold text-amber-300 block">
                                Change / Replace This Fish with Another Species:
                              </label>
                              <div className="flex gap-2">
                                <select
                                  aria-label="Replace Fish Species"
                                  value={replaceSpeciesId}
                                  onChange={(e) => setReplaceSpeciesId(e.target.value)}
                                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
                                >
                                  {allSpeciesOptions.map((opt) => (
                                    <option key={opt.id} value={opt.id}>
                                      {opt.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleReplaceSelectedFishSpecies(
                                      activeSelectedRow.fishId,
                                      activeSelectedRow.ownerUsername,
                                      replaceSpeciesId
                                    )
                                  }
                                  className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-bold whitespace-nowrap"
                                >
                                  Replace Fish
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Detailed Vitals & Genetics Breakdown */}
                          <div className="grid grid-cols-2 gap-2.5 text-xs font-mono">
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Species &amp; Stage</div>
                              <div className="text-white font-bold mt-0.5">
                                {selectedFishSpecies?.name || activeSelectedRow.speciesId} (
                                {activeSelectedRow.lifeStage})
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Age / Lifespan</div>
                              <div className="text-white font-bold mt-0.5">
                                {activeSelectedRow.ageSimHours.toFixed(2)}h /{' '}
                                {selectedFishSpecies?.lifespan.lifespanSimHours || 24}h
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Energy / Hunger</div>
                              <div
                                className={`font-bold mt-0.5 ${
                                  !activeSelectedRow.alive || activeSelectedRow.energy < 25
                                    ? 'text-rose-400'
                                    : 'text-emerald-300'
                                }`}
                              >
                                {activeSelectedRow.energy.toFixed(1)}% /{' '}
                                {activeSelectedRow.hunger.toFixed(1)}%
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Health / Stress</div>
                              <div className="text-cyan-300 font-bold mt-0.5">
                                {activeSelectedRow.health.toFixed(1)}% /{' '}
                                {activeSelectedRow.stress.toFixed(1)}%
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">
                                Babies / Food Eaten
                              </div>
                              <div className="text-fuchsia-300 font-bold mt-0.5">
                                {activeSelectedRow.offspringProduced} Babies ·{' '}
                                {activeSelectedRow.foodPelletsEaten} Pellets
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">
                                Brain Model &amp; Topology
                              </div>
                              <div className="text-amber-300 font-bold mt-0.5">
                                {activeSelectedRow.modelVersion} [
                                {activeSelectedRow.hiddenLayersLabel}]
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 col-span-2">
                              <div className="text-[10px] text-slate-400">
                                Genetics, Aggressiveness &amp; Lineage ID
                              </div>
                              <div className="text-slate-200 mt-0.5 text-[11px]">
                                ID: <code>{activeSelectedRow.fishId}</code> · Mutations:{' '}
                                {activeSelectedRow.mutationsCount} · Speed:{' '}
                                {activeSelectedRow.maxSpeedGene.toFixed(2)}x · Size:{' '}
                                {activeSelectedRow.bodyScaleGene.toFixed(2)}x · Aggressiveness:{' '}
                                <span
                                  className={
                                    activeSelectedRow.aggressiveness > 0
                                      ? 'text-rose-300 font-bold'
                                      : 'text-emerald-300'
                                  }
                                >
                                  {activeSelectedRow.aggressiveness > 0
                                    ? `${(activeSelectedRow.aggressiveness * 100).toFixed(0)}% (${activeSelectedRow.attacksPerformed} Attacks)`
                                    : '0% (Peaceful)'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-slate-400">
                          Click any fish in the list to inspect its details and run actions.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* =====================================================================
              TAB 3: BASE MODEL PROPERTY & LIFESPAN EDITOR + 50 FAMOUS FISHES CATALOG
             ===================================================================== */}
          {activeTab === 'species_editor' && (
            <div className="space-y-6">
              {/* Part A: Edit Selected Species / Base Model Biological Properties */}
              <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold text-white">
                        Edit Base Model &amp; Species Properties ({selectedSpecies.name})
                      </h2>
                      <button
                        type="button"
                        onClick={() => setActiveHelp(TRAINER_HELP.species_property_editor)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                      >
                        ?
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Modify lifespan hours, maturity age, reproduction interval, metabolism,
                      owner-level requirement, or 3D colors and save directly to Firestore{' '}
                      <code className="text-cyan-300">base_models</code>.
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <select
                      aria-label="Select Species to Edit"
                      value={selectedSpecies.id}
                      onChange={(e) => setSelectedSpeciesId(e.target.value)}
                      className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-bold text-white"
                    >
                      {ecosystem.speciesList.map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.name} ({sp.lifespan.lifespanSimHours}h · Lv.
                          {sp.requiredOwnerLevel || 1})
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={handleSaveSpeciesPropertiesToFirestore}
                      className="px-4 py-2 rounded-xl bg-amber-400 text-slate-950 text-xs font-bold hover:bg-amber-300 shadow"
                    >
                      Save Properties to Firestore
                    </button>
                  </div>
                </div>

                {/* Split Layout: Left 7 Cols = Biological & 3D Model Controls, Right 5 Cols = Live Interactive 3D Preview */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <div className="lg:col-span-7 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Species Name</label>
                        <input
                          type="text"
                          value={selectedSpecies.name}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.name = e.target.value;
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Scientific Name</label>
                        <input
                          type="text"
                          value={selectedSpecies.scientificName}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.scientificName = e.target.value;
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white italic"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Lifespan (Sim Hours)
                        </label>
                        <input
                          type="number"
                          min={4}
                          max={500}
                          step={1}
                          value={selectedSpecies.lifespan.lifespanSimHours}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              const hrs = Math.max(4, Number(e.target.value) || 24);
                              s.lifespan.lifespanSimHours = hrs;
                              s.lifespan.maxReproductiveAgeHours = Number((hrs * 0.85).toFixed(1));
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-cyan-300"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Sexual Maturity Age (Hours)
                        </label>
                        <input
                          type="number"
                          min={0.5}
                          max={100}
                          step={0.5}
                          value={selectedSpecies.lifespan.sexualMaturityAgeHours}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.lifespan.sexualMaturityAgeHours = Math.max(
                                0.5,
                                Number(e.target.value) || 4
                              );
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Reproduction Interval (Hours)
                        </label>
                        <input
                          type="number"
                          min={0.5}
                          max={100}
                          step={0.5}
                          value={selectedSpecies.lifespan.reproductionIntervalHours}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.lifespan.reproductionIntervalHours = Math.max(
                                0.5,
                                Number(e.target.value) || 3
                              );
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Metabolism Burn (Energy / Hour)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          step={0.5}
                          value={selectedSpecies.lifespan.metabolismEnergyPerHour}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.lifespan.metabolismEnergyPerHour = Math.max(
                                1,
                                Number(e.target.value) || 6.5
                              );
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Required Owner Level (Unlock)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          step={1}
                          value={selectedSpecies.requiredOwnerLevel || 1}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.requiredOwnerLevel = Math.max(1, Number(e.target.value) || 1);
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-amber-300"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Shop Price (Bio-Credits)
                        </label>
                        <input
                          type="number"
                          min={10}
                          max={2000}
                          step={5}
                          value={selectedSpecies.shopPriceCredits || 45}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.shopPriceCredits = Math.max(10, Number(e.target.value) || 45);
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-amber-300"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Aggressiveness (0 = Peaceful)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={Number(
                            (selectedSpecies.baseBrainConfig.aggressiveness ?? 0).toFixed(2)
                          )}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              const val = Math.max(0, Math.min(1, Number(e.target.value) || 0));
                              s.baseBrainConfig.aggressiveness = val < 0.02 ? 0 : val;
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-rose-300"
                        />
                      </div>

                      <div className="sm:col-span-2 lg:col-span-3">
                        <label className="text-xs text-cyan-300 font-bold block mb-1">
                          3D Body Silhouette (10 Models — Changes Preview Instantly on the Right →)
                        </label>
                        <select
                          aria-label="3D Body Silhouette (10 Models)"
                          value={selectedSpecies.bodyStyle}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.bodyStyle = e.target.value as SpeciesConfig['bodyStyle'];
                            })
                          }
                          className="w-full bg-slate-900 border-2 border-cyan-500/60 rounded-lg px-3 py-2 text-xs font-bold text-white"
                        >
                          <option value="fusiform_reef">1. Streamlined Reef / Tetra (fusiform_reef)</option>
                          <option value="angel_disc">2. Tall Angelfish / Discus (angel_disc)</option>
                          <option value="biolum_Latern">3. Deep-Sea Lantern / Eel (biolum_Latern)</option>
                          <option value="mandarin_dragonet">4. Ornate Fan-Fin Dragonet (mandarin_dragonet)</option>
                          <option value="betta_veil">5. Flowing Veil-Tail Betta (betta_veil)</option>
                          <option value="shark_torpedo">6. Sleek Torpedo Shark / Bala (shark_torpedo)</option>
                          <option value="puffer_round">7. Round Pea / Box Puffer (puffer_round)</option>
                          <option value="tang_surgeon">8. Oval Reef Surgeonfish / Tang (tang_surgeon)</option>
                          <option value="koi_dragon">9. Heavy Barbels Dragon Koi (koi_dragon)</option>
                          <option value="lionfish_fan">10. Spiny Fan-Crest Lionfish (lionfish_fan)</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Primary Body Color
                        </label>
                        <input
                          type="color"
                          value={selectedSpecies.primaryColorHex}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.primaryColorHex = e.target.value;
                            })
                          }
                          className="w-full h-9 bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1 cursor-pointer"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Secondary Color
                        </label>
                        <input
                          type="color"
                          value={selectedSpecies.secondaryColorHex}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.secondaryColorHex = e.target.value;
                            })
                          }
                          className="w-full h-9 bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1 cursor-pointer"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          Fin Accent Color
                        </label>
                        <input
                          type="color"
                          value={selectedSpecies.accentColorHex}
                          onChange={(e) =>
                            handleUpdateSelectedSpeciesField((s) => {
                              s.accentColorHex = e.target.value;
                            })
                          }
                          className="w-full h-9 bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1 cursor-pointer"
                        />
                      </div>
                    </div>

                    {/* Quick 10-Button 3D Silhouette Switcher Bar */}
                    <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono font-bold uppercase text-cyan-300">
                          Quick-Switch 3D Model (Click Any to Preview on {selectedSpecies.name})
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCatalogModelId(selectedSpecies.bodyStyle);
                            setActiveTab('models_3d');
                          }}
                          className="text-[11px] font-mono font-bold text-fuchsia-300 hover:text-fuchsia-200 underline"
                        >
                          Open Full 3D Models Catalog →
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                        {FISH_3D_MODELS_CATALOG.map((m) => {
                          const isCurrent = selectedSpecies.bodyStyle === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() =>
                                handleUpdateSelectedSpeciesField((s) => {
                                  s.bodyStyle = m.id;
                                })
                              }
                              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-bold text-left truncate border transition-colors ${
                                isCurrent
                                  ? 'bg-cyan-400 text-slate-950 border-white shadow'
                                  : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-cyan-500/60 hover:text-white'
                              }`}
                              title={m.name}
                            >
                              #{m.index} {m.shortName}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Right 5 Columns: Live Interactive 3D Fish Model Preview */}
                  <div className="lg:col-span-5 space-y-2">
                    <FishModelPreview3D
                      bodyStyle={selectedSpecies.bodyStyle}
                      primaryColorHex={selectedSpecies.primaryColorHex}
                      secondaryColorHex={selectedSpecies.secondaryColorHex}
                      accentColorHex={selectedSpecies.accentColorHex}
                      speciesName={selectedSpecies.name}
                      aggressiveness={selectedSpecies.baseBrainConfig.aggressiveness ?? 0}
                      heightClass="h-64"
                    />
                    <div className="px-3 py-2 rounded-xl bg-slate-900/80 border border-slate-800 text-[11px] text-slate-300 flex items-center justify-between gap-2">
                      <span>
                        Drag in 3D view to rotate · Scroll to zoom · Test Attack Lunge &amp; Reactions
                        above
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Part B: 50 Top Famous Aquarium Fishes Collection */}
              <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-base font-bold text-white">
                      50 Top Famous Aquarium Fishes Collection
                    </h3>
                    <p className="text-xs text-slate-400">
                      Choose any of the 50 famous real-world aquarium fish species below to add or
                      load its biological properties and Base Brain Model into Firestore.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      placeholder="Search 50 famous fishes..."
                      className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                    />
                    {(['all', 'freshwater', 'marine', 'cichlid', 'specialty'] as const).map(
                      (cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setCatalogCategory(cat)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize ${
                            catalogCategory === cat
                              ? 'bg-cyan-400 text-slate-950'
                              : 'bg-slate-900 text-slate-300 border border-slate-800'
                          }`}
                        >
                          {cat === 'all' ? 'All 50' : cat}
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 max-h-[520px] overflow-y-auto lab-scroll pr-1">
                  {filteredFamousCatalog.map((tpl) => {
                    const alreadyInList = ecosystem.speciesList.some((s) => s.id === tpl.id);
                    return (
                      <div
                        key={tpl.id}
                        className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between gap-3"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span
                                className="w-4 h-4 rounded-full shrink-0 border border-white/30"
                                style={{
                                  background: `linear-gradient(135deg, ${tpl.primaryColorHex}, ${tpl.secondaryColorHex})`,
                                }}
                              />
                              <span className="text-xs font-bold text-white">
                                #{tpl.rank}. {tpl.name}
                              </span>
                            </div>
                            <span className="text-[11px] font-mono text-amber-300">
                              Lv.{tpl.requiredOwnerLevel} · {tpl.shopPriceCredits} Cr
                            </span>
                          </div>
                          <div className="text-[11px] font-mono text-cyan-300 mt-1">
                            {tpl.scientificName} · Lifespan {tpl.lifespanSimHours}h · Maturity{' '}
                            {tpl.sexualMaturityAgeHours}h
                          </div>
                          <p className="text-xs text-slate-400 mt-1.5 line-clamp-2">
                            {tpl.description}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleAddOrLoadFamousFish(tpl)}
                          className={`w-full py-2 rounded-lg text-xs font-bold transition-colors ${
                            alreadyInList
                              ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30'
                              : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                          }`}
                        >
                          {alreadyInList
                            ? 'Loaded in Catalog — Edit Properties Above'
                            : '+ Add to Active Base Models & Edit'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 4: NEURAL BRAIN ARCHITECTURE LAB
             ===================================================================== */}
          {activeTab === 'brain_lab' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-white">
                      Neural Brain Architecture Lab ({selectedSpecies.name})
                    </h2>
                    <p className="text-xs text-slate-400">
                      Configure hidden layers, activation nonlinearities, recurrent spatial memory,
                      and lifetime Hebbian learning rates.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveHelp(TRAINER_HELP.brain_architecture_lab)}
                    className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                  >
                    ?
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Hidden Layers (Comma-Separated Neurons)
                    </label>
                    <input
                      type="text"
                      value={hiddenLayersText}
                      onChange={(e) => {
                        setHiddenLayersText(e.target.value);
                        const parsed = e.target.value
                          .split(',')
                          .map((s) => parseInt(s.trim(), 10))
                          .filter((n) => !isNaN(n) && n >= 4 && n <= 128);
                        if (parsed.length >= 1 && parsed.length <= 5) {
                          handleUpdateSelectedSpeciesField((s) => {
                            s.baseBrainConfig.hiddenLayers = parsed;
                          });
                        }
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-cyan-300"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Activation Function
                    </label>
                    <select
                      value={selectedSpecies.baseBrainConfig.activation}
                      onChange={(e) =>
                        handleUpdateSelectedSpeciesField((s) => {
                          s.baseBrainConfig.activation = e.target.value as ActivationType;
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    >
                      <option value="tanh">tanh (Smooth Continuous Steering)</option>
                      <option value="relu">relu (Fast Sparse Reflex)</option>
                      <option value="leaky_relu">leaky_relu (Non-Saturating)</option>
                      <option value="sigmoid">sigmoid (Gated 0..1)</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Lifetime Learning Rate
                    </label>
                    <input
                      type="number"
                      min={0.001}
                      max={0.1}
                      step={0.005}
                      value={selectedSpecies.baseBrainConfig.learningRate}
                      onChange={(e) =>
                        handleUpdateSelectedSpeciesField((s) => {
                          s.baseBrainConfig.learningRate = Math.max(
                            0.001,
                            Number(e.target.value) || 0.015
                          );
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Mutation Rate (Per Synapse)
                    </label>
                    <input
                      type="number"
                      min={0.01}
                      max={0.5}
                      step={0.01}
                      value={selectedSpecies.baseBrainConfig.mutationRate}
                      onChange={(e) =>
                        handleUpdateSelectedSpeciesField((s) => {
                          s.baseBrainConfig.mutationRate = Math.max(
                            0.01,
                            Number(e.target.value) || 0.08
                          );
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Mutation Magnitude (σ)
                    </label>
                    <input
                      type="number"
                      min={0.02}
                      max={0.6}
                      step={0.02}
                      value={selectedSpecies.baseBrainConfig.mutationMagnitude}
                      onChange={(e) =>
                        handleUpdateSelectedSpeciesField((s) => {
                          s.baseBrainConfig.mutationMagnitude = Math.max(
                            0.02,
                            Number(e.target.value) || 0.14
                          );
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Maternal Learned Inheritance (0..1)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedSpecies.baseBrainConfig.learnedInheritanceRate}
                      onChange={(e) =>
                        handleUpdateSelectedSpeciesField((s) => {
                          s.baseBrainConfig.learnedInheritanceRate = Math.max(
                            0,
                            Math.min(1, Number(e.target.value) || 0.25)
                          );
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div className="sm:col-span-3 p-3.5 rounded-xl bg-rose-950/30 border border-rose-500/40 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-xs font-bold text-rose-200">
                        Aggressiveness Behavior (Periodic Attack Lunge — Only Active When &gt; 0)
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        When set to <code>0</code>, this brain is 100% peaceful and never attacks.
                        When set <code>&gt; 0</code>, the fish periodically lunges at nearby fishes
                        and evolves attack frequency during training.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedSpeciesField((s) => {
                            s.baseBrainConfig.aggressiveness =
                              (s.baseBrainConfig.aggressiveness ?? 0) > 0 ? 0 : 0.35;
                          })
                        }
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                          (selectedSpecies.baseBrainConfig.aggressiveness ?? 0) > 0
                            ? 'bg-rose-500 text-white'
                            : 'bg-slate-800 text-slate-300 border border-slate-700'
                        }`}
                      >
                        {(selectedSpecies.baseBrainConfig.aggressiveness ?? 0) > 0
                          ? `ENABLED (${((selectedSpecies.baseBrainConfig.aggressiveness ?? 0) * 100).toFixed(0)}%)`
                          : 'DISABLED (0% Peaceful)'}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={selectedSpecies.baseBrainConfig.aggressiveness ?? 0}
                        onChange={(e) =>
                          handleUpdateSelectedSpeciesField((s) => {
                            const val = Math.max(0, Math.min(1, Number(e.target.value) || 0));
                            s.baseBrainConfig.aggressiveness = val < 0.02 ? 0 : val;
                          })
                        }
                        className="w-32 accent-rose-400 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 pt-2">
                  {(
                    [
                      ['recurrentMemoryEnabled', 'Recurrent Spatial Memory'],
                      ['attentionModuleEnabled', 'Sensory Attention Gates'],
                      ['evasionModuleEnabled', 'Predator Evasion Reflex'],
                      ['schoolingModuleEnabled', 'Social Shoaling Alignment'],
                    ] as const
                  ).map(([field, label]) => (
                    <label
                      key={field}
                      className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(selectedSpecies.baseBrainConfig[field])}
                        onChange={(e) =>
                          handleUpdateSelectedSpeciesField((s) => {
                            s.baseBrainConfig[field] = e.target.checked;
                          })
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleSaveSpeciesPropertiesToFirestore}
                  className="px-5 py-2.5 rounded-xl bg-violet-400 text-slate-950 text-xs font-bold hover:bg-violet-300"
                >
                  Save Brain Architecture to Firestore Base Model
                </button>
              </div>

              {/* Right Column: Complexity Validation & Topology Summary */}
              <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-white">
                  Architecture Validation &amp; Compute Budget
                </h3>
                <div className="space-y-2.5 text-xs font-mono tabular-nums">
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">Layer Topology</span>
                    <span className="text-cyan-300">
                      {[
                        selectedSpecies.baseBrainConfig.inputCount,
                        ...selectedSpecies.baseBrainConfig.hiddenLayers,
                        selectedSpecies.baseBrainConfig.outputCount,
                      ].join(' → ')}
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">Total Synaptic Params</span>
                    <span className="text-white font-bold">
                      {brainMetrics.parameterCount.toLocaleString()}
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">Inference Ops / Decision</span>
                    <span className="text-emerald-300">
                      {brainMetrics.inferenceOpsPerDecision.toLocaleString()} ops
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex justify-between">
                    <span className="text-slate-400">RAM Footprint / Fish</span>
                    <span className="text-slate-200">{brainMetrics.estimatedMemoryBytes} B</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 5: EVOLUTION RULES, LINEAGE, A/B EXPERIMENTS, JSON & ADMINS
             ===================================================================== */}
          {activeTab === 'evolution_lab' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Controlled A/B Experiment Runner */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold text-white">
                        Controlled A/B Brain Benchmark Trial
                      </h3>
                      <p className="text-xs text-slate-400">
                        Compare your active Control base model against a mutated &amp; reward-trained
                        Variant under identical habitat conditions.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveHelp(TRAINER_HELP.evolution_and_ab_lab)}
                      className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                    >
                      ?
                    </button>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={experimentNameInput}
                      onChange={(e) => setExperimentNameInput(e.target.value)}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const next = JSON.parse(
                          JSON.stringify(ecosystemRef.current)
                        ) as SavedEcosystemState;
                        const exp = runControlledExperiment(
                          next,
                          selectedSpecies.id,
                          experimentNameInput,
                          24
                        );
                        saveEcosystemState(next);
                        ecosystemRef.current = next;
                        setEcosystem(next);
                        await saveExperimentToFirestore(adminUser?.email || profileName, exp);
                        setStatusBanner(`A/B Trial Complete: ${exp.summary}`);
                      }}
                      className="px-4 py-2 rounded-lg bg-sky-400 text-slate-950 text-xs font-bold hover:bg-sky-300 whitespace-nowrap"
                    >
                      Run A/B Trial
                    </button>
                  </div>

                  <div className="space-y-2.5 max-h-64 overflow-y-auto lab-scroll pr-1">
                    {ecosystem.experiments.map((exp) => (
                      <div
                        key={exp.id}
                        className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-white">{exp.name}</span>
                          <span className="font-mono text-cyan-300 uppercase">
                            Winner: {exp.winner}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-slate-300">
                          Control: {exp.controlScores.overallComposite}% vs Variant:{' '}
                          {exp.variantScores.overallComposite}%
                        </div>
                        <p className="text-[11px] text-slate-400">{exp.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* JSON Export / Import & Firestore Admins Collection */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-white">
                      JSON Model Export &amp; Firestore Admins ({adminsList.length})
                    </h3>
                    <button
                      type="button"
                      onClick={() => {
                        const activeM =
                          speciesModels.find((m) => m.isPromotedBase) || speciesModels[0];
                        setJsonExportText(
                          JSON.stringify(
                            { species: selectedSpecies, baseModel: activeM },
                            null,
                            2
                          )
                        );
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 text-cyan-300 text-xs font-bold hover:bg-slate-700"
                    >
                      Export Selected Species JSON
                    </button>
                  </div>

                  {jsonExportText && (
                    <textarea
                      readOnly
                      value={jsonExportText}
                      rows={5}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-[11px] font-mono text-emerald-300"
                    />
                  )}

                  {/* Add Admin to Firestore `admins` Collection */}
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!newAdminEmailInput.trim()) return;
                      const updated = await addAdminToFirestore(
                        newAdminEmailInput,
                        newAdminNameInput,
                        adminUser.email
                      );
                      setAdminsList(updated);
                      setStatusBanner(
                        `Added "${newAdminEmailInput}" to the Firestore "admins" collection.`
                      );
                      setNewAdminEmailInput('');
                      setNewAdminNameInput('');
                    }}
                    className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-800"
                  >
                    <input
                      type="email"
                      value={newAdminEmailInput}
                      onChange={(e) => setNewAdminEmailInput(e.target.value)}
                      placeholder="newadmin@gmail.com"
                      className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    />
                    <input
                      type="text"
                      value={newAdminNameInput}
                      onChange={(e) => setNewAdminNameInput(e.target.value)}
                      placeholder="Display Name"
                      className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    />
                    <button
                      type="submit"
                      className="px-3 py-2 rounded-lg bg-emerald-400 text-slate-950 font-bold text-xs hover:bg-emerald-300"
                    >
                      + Authorize Gmail Admin
                    </button>
                  </form>

                  <div className="space-y-2 max-h-40 overflow-y-auto lab-scroll pr-1">
                    {adminsList.map((adm) => (
                      <div
                        key={adm.email}
                        className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 flex items-center justify-between text-xs"
                      >
                        <div>
                          <span className="font-mono font-bold text-white">{adm.email}</span>
                          <span className="text-slate-400 ml-2">({adm.role})</span>
                        </div>
                        {adm.role !== 'owner' && (
                          <button
                            type="button"
                            onClick={async () => {
                              const updated = await removeAdminFromFirestore(adm.email);
                              setAdminsList(updated);
                            }}
                            className="text-rose-400 hover:text-rose-300 text-[11px]"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 6: 3D FISH MODELS CATALOG & INTERACTIVE TURNTABLE STUDIO
             ===================================================================== */}
          {activeTab === 'models_3d' && (() => {
            const activeCatalogModel =
              FISH_3D_MODELS_CATALOG.find((m) => m.id === selectedCatalogModelId) ||
              FISH_3D_MODELS_CATALOG[0];

            const previewPrimary =
              catalogColorMode === 'species'
                ? selectedSpecies.primaryColorHex
                : activeCatalogModel.defaultColors.primary;
            const previewSecondary =
              catalogColorMode === 'species'
                ? selectedSpecies.secondaryColorHex
                : activeCatalogModel.defaultColors.secondary;
            const previewAccent =
              catalogColorMode === 'species'
                ? selectedSpecies.accentColorHex
                : activeCatalogModel.defaultColors.accent;

            const matchingActiveSpecies = ecosystem.speciesList.filter(
              (s) => s.bodyStyle === activeCatalogModel.id
            );

            return (
              <div className="space-y-6">
                {/* Top Studio Card: Large Interactive 3D Viewport + Anatomy & Apply Panel */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <span className="text-[11px] font-mono font-extrabold uppercase tracking-widest text-fuchsia-300">
                        PROCEDURAL 3D SILHOUETTE STUDIO · 10 ANATOMICAL RIGS
                      </span>
                      <h2 className="text-lg font-extrabold text-white mt-0.5">
                        #{activeCatalogModel.index}. {activeCatalogModel.name} (
                        <code className="text-cyan-300 text-sm">{activeCatalogModel.id}</code>)
                      </h2>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <div className="flex items-center rounded-xl bg-slate-950 p-1 border border-slate-800 text-xs">
                        <button
                          type="button"
                          onClick={() => setCatalogColorMode('default')}
                          className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                            catalogColorMode === 'default'
                              ? 'bg-fuchsia-400 text-slate-950'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          Model Signature Colors
                        </button>
                        <button
                          type="button"
                          onClick={() => setCatalogColorMode('species')}
                          className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                            catalogColorMode === 'species'
                              ? 'bg-cyan-400 text-slate-950'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          Use {selectedSpecies.name} Colors
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={async () => {
                          handleUpdateSelectedSpeciesField((s) => {
                            s.bodyStyle = activeCatalogModel.id;
                            if (catalogColorMode === 'default') {
                              s.primaryColorHex = activeCatalogModel.defaultColors.primary;
                              s.secondaryColorHex = activeCatalogModel.defaultColors.secondary;
                              s.accentColorHex = activeCatalogModel.defaultColors.accent;
                            }
                          });
                          await handleSaveSpeciesPropertiesToFirestore();
                          setStatusBanner(
                            `Applied 3D Model #${activeCatalogModel.index} (${activeCatalogModel.name}) to ${selectedSpecies.name} and saved to Firestore!`
                          );
                        }}
                        className="px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-extrabold shadow-lg transition-colors"
                      >
                        Apply Model to {selectedSpecies.name} &amp; Save
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    {/* Left 7 Columns: Large Interactive 3D Fish Viewport */}
                    <div className="lg:col-span-7">
                      <FishModelPreview3D
                        bodyStyle={activeCatalogModel.id}
                        primaryColorHex={previewPrimary}
                        secondaryColorHex={previewSecondary}
                        accentColorHex={previewAccent}
                        aggressiveness={selectedSpecies.baseBrainConfig.aggressiveness ?? 0}
                        heightClass="h-80"
                      />
                    </div>

                    {/* Right 5 Columns: Anatomical Breakdown & Assign to Any Species */}
                    <div className="lg:col-span-5 space-y-4">
                      <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3 text-xs">
                        <div>
                          <div className="text-[10px] font-mono uppercase text-cyan-300 font-bold">
                            3D Hull &amp; Body Lofting
                          </div>
                          <p className="text-slate-200 mt-0.5 leading-relaxed">
                            {activeCatalogModel.anatomySummary}
                          </p>
                        </div>

                        <div className="pt-2 border-t border-slate-800">
                          <div className="text-[10px] font-mono uppercase text-emerald-300 font-bold">
                            Articulated Fin Geometry
                          </div>
                          <p className="text-slate-200 mt-0.5 leading-relaxed">
                            {activeCatalogModel.finProfile}
                          </p>
                        </div>

                        <div className="pt-2 border-t border-slate-800">
                          <div className="text-[10px] font-mono uppercase text-amber-300 font-bold">
                            Signature Anatomical Feature
                          </div>
                          <p className="text-slate-200 mt-0.5 leading-relaxed">
                            {activeCatalogModel.specialFeature}
                          </p>
                        </div>

                        <div className="pt-2 border-t border-slate-800">
                          <div className="text-[10px] font-mono uppercase text-fuchsia-300 font-bold">
                            Real-World Aquarium Examples
                          </div>
                          <p className="text-slate-300 mt-0.5">{activeCatalogModel.exampleSpecies}</p>
                        </div>

                        <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                          <span className="text-slate-400">Signature Palette:</span>
                          <div className="flex items-center gap-2 font-mono text-[11px]">
                            <span className="flex items-center gap-1">
                              <span
                                className="w-3.5 h-3.5 rounded-full border border-white/30"
                                style={{ backgroundColor: activeCatalogModel.defaultColors.primary }}
                              />
                              {activeCatalogModel.defaultColors.primary}
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-3.5 h-3.5 rounded-full border border-white/30"
                                style={{
                                  backgroundColor: activeCatalogModel.defaultColors.secondary,
                                }}
                              />
                              {activeCatalogModel.defaultColors.secondary}
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-3.5 h-3.5 rounded-full border border-white/30"
                                style={{ backgroundColor: activeCatalogModel.defaultColors.accent }}
                              />
                              {activeCatalogModel.defaultColors.accent}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5">
                        <label className="text-xs font-bold text-white block">
                          Target Species to Receive This 3D Model:
                        </label>
                        <select
                          aria-label="Target Species for 3D Model"
                          value={selectedSpecies.id}
                          onChange={(e) => setSelectedSpeciesId(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs font-bold text-cyan-300"
                        >
                          {ecosystem.speciesList.map((sp) => (
                            <option key={sp.id} value={sp.id}>
                              {sp.name} (Currently: {sp.bodyStyle})
                            </option>
                          ))}
                        </select>
                        <div className="text-[11px] text-slate-400">
                          Active species currently using <code className="text-cyan-300">{activeCatalogModel.id}</code>:{' '}
                          <strong className="text-white">
                            {matchingActiveSpecies.length > 0
                              ? matchingActiveSpecies.map((s) => s.name).join(', ')
                              : 'None yet'}
                          </strong>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bottom Grid: All 10 Procedural 3D Fish Models Catalog */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold text-white">
                        All 10 Procedural 3D Fish Models Catalog
                      </h3>
                      <p className="text-xs text-slate-400">
                        Click any 3D model card below to load it into the interactive 3D Turntable
                        Studio above.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
                    {FISH_3D_MODELS_CATALOG.map((m) => {
                      const isSelectedModel = selectedCatalogModelId === m.id;
                      const isUsedBySelectedSpecies = selectedSpecies.bodyStyle === m.id;
                      return (
                        <div
                          key={m.id}
                          onClick={() => setSelectedCatalogModelId(m.id)}
                          className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                            isSelectedModel
                              ? 'bg-fuchsia-950/50 border-2 border-fuchsia-400 ring-2 ring-fuchsia-400/25 shadow-lg'
                              : 'bg-slate-900/90 border-slate-800 hover:border-cyan-500/60'
                          }`}
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="px-2 py-0.5 rounded bg-slate-800 text-[10px] font-mono font-extrabold text-cyan-300">
                                MODEL #{m.index}
                              </span>
                              <div className="flex items-center gap-1">
                                <span
                                  className="w-3 h-3 rounded-full border border-white/30"
                                  style={{ backgroundColor: m.defaultColors.primary }}
                                />
                                <span
                                  className="w-3 h-3 rounded-full border border-white/30"
                                  style={{ backgroundColor: m.defaultColors.accent }}
                                />
                              </div>
                            </div>

                            <div className="text-xs font-extrabold text-white">{m.name}</div>
                            <div className="text-[10px] font-mono text-cyan-300">{m.id}</div>
                            <p className="text-[11px] text-slate-400 line-clamp-2">
                              {m.anatomySummary}
                            </p>
                          </div>

                          <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                            {isUsedBySelectedSpecies && (
                              <div className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 text-[10px] font-mono font-bold text-center">
                                Active on {selectedSpecies.name}
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedCatalogModelId(m.id);
                                handleUpdateSelectedSpeciesField((s) => {
                                  s.bodyStyle = m.id;
                                });
                                setStatusBanner(
                                  `Previewing & assigned Model #${m.index} (${m.shortName}) to ${selectedSpecies.name}. Click "Save Properties" to persist to Firestore.`
                                );
                              }}
                              className={`w-full py-1.5 rounded-lg text-[11px] font-mono font-bold transition-colors ${
                                isSelectedModel
                                  ? 'bg-fuchsia-400 text-slate-950 hover:bg-fuchsia-300'
                                  : 'bg-slate-800 text-cyan-300 hover:bg-cyan-400 hover:text-slate-950'
                              }`}
                            >
                              {isSelectedModel ? 'Previewing in 3D Studio' : 'Preview & Use Model'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </main>

      {/* "?" PLAIN-ENGLISH HELP MODAL */}
      {activeHelp && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={activeHelp.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d] p-4"
        >
          <div className="w-full max-w-md rounded-xl bg-[#040c1a] border-2 border-cyan-400 p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-cyan-900">
              <h3 className="text-sm font-mono font-extrabold uppercase tracking-wider text-white">
                {activeHelp.title}
              </h3>
              <button
                type="button"
                onClick={() => setActiveHelp(null)}
                className="px-3 py-1 rounded bg-[#071426] border border-cyan-700 text-xs font-mono font-bold text-cyan-200 hover:text-white uppercase"
              >
                CLOSE
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
              {activeHelp.explanation}
            </p>
            <div className="p-3.5 rounded-lg bg-[#071426] border border-cyan-700 text-xs text-cyan-200 leading-relaxed">
              <strong className="font-mono uppercase text-cyan-400">Example:</strong>{' '}
              {activeHelp.example}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
