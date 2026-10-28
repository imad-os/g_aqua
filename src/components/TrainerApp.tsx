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
  removeAdminFromFirestore,
  resetAllUserFishesInFirestore,
  saveExperimentToFirestore,
  saveModelVersionToFirestore,
  signInWithGmailPopup,
  signOutAdminUser,
  stepAndSyncCloudUserOfflineFishes,
  subscribeToAllUserBrainRecords,
  subscribeToFirebaseAuth,
  syncUserBrainsToFirestore,
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
  FishEntity,
  FoodPellet,
  ModelVersionRecord,
  OfflineServiceTelemetry,
  SavedEcosystemState,
  SpeciesConfig,
} from '../engine/types';
import { AquariumCanvas3D } from './AquariumCanvas3D';

export type TrainerTabId =
  | 'train_models'
  | 'offline_service'
  | 'species_editor'
  | 'brain_lab'
  | 'evolution_lab';

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

  // Tab 1: Train Base Models State (Extended Generations up to 1,000+)
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<string>(
    ecosystem.speciesList[0]?.id || DEFAULT_SPECIES_LIST[0].id
  );
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
  const [fishListFilter, setFishListFilter] = useState<'all' | 'offline' | 'dead'>('all');
  const [cloudUsers, setCloudUsers] = useState<CloudUserBrainRecord[]>([]);
  const [activeSessionTankIds, setActiveSessionTankIds] = useState<string[]>(() =>
    getActiveGameSessionTankIds()
  );
  const [firestoreSyncStatus, setFirestoreSyncStatus] = useState<string>(
    'Connected to Firestore (aquarium-caa2b)'
  );
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

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
      saveEcosystemState(next);
      ecosystemRef.current = next;
      setEcosystem(next);
    });

    fetchAllUserBrainRecordsFromFirestore().then((records) => {
      if (mounted && records.length > 0) {
        setCloudUsers(records);
      }
    });

    // Real-time Firestore listener so when a user opens or closes the game, Keeper updates immediately
    const unsubCloudUsers = subscribeToAllUserBrainRecords((records) => {
      if (mounted) {
        setCloudUsers(records);
      }
    });

    // Real-time storage listener for instant cross-tab hand-off when user opens/closes index.html
    const handleStorageChange = () => {
      if (!mounted) return;
      setActiveSessionTankIds(getActiveGameSessionTankIds());
      const freshEco = loadEcosystemState();
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
      const isOwnerOnlineInGame = localActiveTankIds.includes(activeTank.id);

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
        const latestFromGame = loadEcosystemState();
        ecosystemRef.current = latestFromGame;
        setEcosystem(latestFromGame);
      } else {
        const eco = ecosystemRef.current;
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
            lastDeathMsg = `${fish.lineage.name} (Gen ${fish.lineage.generation}) died of ${reason} at ${fish.state.ageSimHours.toFixed(1)}h`;
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
        const isOnline = localActiveTankIds.includes(f.lineage.tankId);
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
      const nowMs = Date.now();
      const cloudSimHoursDelta =
        stepRes.simHoursDelta > 0 ? stepRes.simHoursDelta : (0.4 * serviceSpeed) / 60;

      for (const cu of cloudUsers) {
        if (cu.username === profileName) continue;
        const isUserOnlineNow =
          cu.isActivelyPlaying && nowMs - (cu.lastGameHeartbeatMs || 0) < 15000;
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
            lastDeathMsg = `${cloudStep.newlyStarvedNames[0]} starved (no owner feeder)`;
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
        offlineDeceasedFishCount: offlineDead + eco.deceasedArchive.length,
        skippedActivePlayFishCount: skippedActive + cloudOnlineSkippedCount,
        totalBrainUpdatesExecuted: totalUpdates,
        ticksPerSecond: Number(((1000 / intervalMs) * Math.max(1, offlineLive)).toFixed(1)),
        simHoursElapsedInService: Number(simHoursAccum.toFixed(3)),
        autoFeederEnabledInService:
          !disableAllFeedersInKeeper && (trainerOverrideFeederEnabled || ownerFeederCount > 0),
        lastDeathEvent: lastDeathMsg,
      });

      if (!isOwnerOnlineInGame && ticksCounter % 8 === 0) {
        syncUserBrainsToFirestore(
          profileName,
          profileId,
          eco.fishes,
          false,
          ownerFeederCount
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

    const sp =
      workingState.speciesList.find((s) => s.id === selectedSpecies.id) ||
      workingState.speciesList[0];
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

    let lastCandidate: ModelVersionRecord | null = null;
    let totalSimulated = 0;

    // For large generation counts (100 - 1000+), batch 1 to 5 generations per UI frame according to CPU limit
    const batchGens = totalGens >= 250 && cpuUsageLimitPct >= 50 ? 5 : totalGens >= 100 ? 2 : 1;

    for (let g = 1; g <= totalGens; g += batchGens) {
      if (cancelTrainingRef.current) break;
      const gensThisChunk = Math.min(batchGens, totalGens - g + 1);

      const stepRes = runAcceleratedHeadlessTraining(
        workingState,
        selectedSpecies.id,
        gensThisChunk,
        popSize,
        0.1
      );
      lastCandidate = stepRes.candidateModel;
      totalSimulated += stepRes.fishSimulatedCount;
      setTrainingProgressGen(g + gensThisChunk - 1);

      const sleepMs =
        cpuUsageLimitPct >= 95
          ? 6
          : Math.round(((100 - cpuUsageLimitPct) / Math.max(10, cpuUsageLimitPct)) * 28);
      await new Promise((r) => window.setTimeout(r, sleepMs));
    }

    if (lastCandidate) {
      lastCandidate.speciesConfig = { ...sp };
      await saveModelVersionToFirestore(adminUser?.email || profileName, lastCandidate);

      saveEcosystemState(workingState);
      ecosystemRef.current = workingState;
      setEcosystem(workingState);

      const summary = `Trained ${lastCandidate.versionId} for ${selectedSpecies.name} across ${totalGens} generations (${totalSimulated.toLocaleString()} fishes simulated at ${cpuUsageLimitPct}% CPU). Foraging: ${lastCandidate.benchmark.foragingEfficiency}% · Composite: ${lastCandidate.benchmark.overallComposite}% — Saved to Firestore "base_models/${selectedSpecies.id}__${lastCandidate.versionId}".`;
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

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const ok = await saveModelVersionToFirestore(adminUser?.email || profileName, activeModel);
    setStatusBanner(
      ok
        ? `Saved "${sp.name}" properties (Lifespan: ${sp.lifespan.lifespanSimHours}h, Owner Lv.${
            sp.requiredOwnerLevel || 1
          }, Price: ${sp.shopPriceCredits || 45} Cr) to Firestore "base_models/active__${sp.id}".`
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

  // Starve a specific fish (or currently selected fish) so when the user opens the game it appears DEAD from starvation
  const handleStarveFish = async (targetFishId?: string) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const candidateId = targetFishId || selectedFishId;
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

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setSelectedFishId(target.lineage.fishId);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await syncUserBrainsToFirestore(
      profileName,
      profileId,
      next.fishes,
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount
    );

    setStatusBanner(
      `Fish "${target.lineage.name}" (Gen ${target.lineage.generation}) died from STARVATION! When the owner opens the game, "${target.lineage.name}" will appear floating dead in the aquarium.`
    );
  };

  // Reproduce a specific fish (make it have a baby immediately)
  const handleReproduceFish = async (targetFishId?: string) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const candidateId = targetFishId || selectedFishId;
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

    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await syncUserBrainsToFirestore(
      profileName,
      profileId,
      next.fishes,
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount
    );

    setStatusBanner(
      `"${parentFish.lineage.name}" reproduced! New baby "${babyFish.lineage.name}" (Gen ${babyFish.lineage.generation}, Juvenile) was born into the tank.`
    );
  };

  // Feed a single selected fish
  const handleFeedSingleFish = async (targetFishId?: string) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const candidateId = targetFishId || selectedFishId;
    const target = next.fishes.find((f) => f.lineage.fishId === candidateId && f.lineage.alive);
    if (!target) {
      setStatusBanner('Select a live fish to feed.');
      return;
    }
    target.state.energy = Math.min(100, target.state.energy + 50);
    target.state.hunger = Math.max(0, 100 - target.state.energy);
    target.state.health = Math.min(100, target.state.health + 20);
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setStatusBanner(`Fed "${target.lineage.name}" (+50% Energy, Health ${target.state.health.toFixed(0)}%).`);
  };

  // Revive a dead fish
  const handleReviveFish = async (targetFishId?: string) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const candidateId = targetFishId || selectedFishId;
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
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    const activeTank = TANK_TIERS[next.activeTankTier] || TANK_TIERS[0];
    const ownerFeederCount = next.autoFeederCountByTank[activeTank.id] || 0;
    await syncUserBrainsToFirestore(
      profileName,
      profileId,
      next.fishes,
      activeSessionTankIds.includes(activeTank.id),
      ownerFeederCount
    );

    setStatusBanner(`Revived "${target.lineage.name}" with 85% Energy and 100% Health!`);
  };

  // Offline Fish Actions
  const handleFeedOfflineFishes = () => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    for (const f of next.fishes) {
      if (f.lineage.alive && !activeSessionTankIds.includes(f.lineage.tankId)) {
        f.state.energy = Math.min(100, f.state.energy + 35);
        f.state.hunger = Math.max(0, 100 - f.state.energy);
      }
    }
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setStatusBanner('Fed all live offline fishes in the Keeper (+35% Energy).');
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

  const handleAddOfflinePair = () => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const sp = next.speciesList[0] || DEFAULT_SPECIES_LIST[0];
    const f1 = spawnFoundingFish(sp, next.activeTankTier, next.simHoursTotal, next.fishes.length);
    const f2 = spawnFoundingFish(sp, next.activeTankTier, next.simHoursTotal, next.fishes.length + 1);
    next.fishes.push(f1, f2);
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setSelectedFishId(f1.lineage.fishId);
    setStatusBanner('Added 2 live fishes to the tank.');
  };

  // ============================================================================
  // GMAIL ADMIN LOGIN GATE (WHEN NOT SIGNED IN AS AN AUTHORIZED ADMIN)
  // ============================================================================
  if (!adminUser) {
    return (
      <div className="fixed inset-0 w-full h-full bg-[#060a12] text-slate-100 flex items-center justify-center p-6 select-none">
        <div className="w-full max-w-md rounded-2xl bg-[#0b1322] border border-cyan-500/40 p-7 shadow-2xl space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-xs font-mono text-cyan-300 font-bold uppercase">
                Standalone Back-Office Studio
              </span>
              <h1 className="text-xl font-bold text-white mt-1">
                Abyssal Evo · AI Trainer &amp; 24/7 Fish Keeper
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                Sign in with an authorized Admin Gmail account listed in the Firestore{' '}
                <code className="text-cyan-300">admins</code> collection (
                <code className="text-cyan-300">aquarium-caa2b</code>).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveHelp(TRAINER_HELP.admins_collection)}
              className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold shrink-0"
              title="How Admin Auth Works"
            >
              ?
            </button>
          </div>

          {authError && (
            <div className="p-3 rounded-lg bg-rose-950/70 border border-rose-500/50 text-xs text-rose-200">
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
            className="w-full py-3 px-4 rounded-xl bg-white text-slate-950 font-bold text-xs flex items-center justify-center gap-2.5 hover:bg-slate-100 transition-colors shadow"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4">
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
            <span>Sign In with Google (Gmail Admin)</span>
          </button>

          <div className="pt-3 border-t border-slate-800 space-y-2.5">
            <div className="text-[11px] text-slate-400">
              Testing inside an embedded preview where browser popups are blocked? Verify your
              Gmail directly against the Firestore <code className="text-cyan-300">admins</code>{' '}
              collection:
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                value={manualVerifyEmail}
                onChange={(e) => setManualVerifyEmail(e.target.value)}
                placeholder="admin@gmail.com"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
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
                className="px-3.5 py-2 rounded-lg bg-cyan-500 text-slate-950 text-xs font-bold hover:bg-cyan-400 whitespace-nowrap"
              >
                Verify in Firestore
              </button>
            </div>
          </div>
        </div>

        {activeHelp && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-md rounded-2xl bg-[#0b1528] border border-cyan-400/50 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-white">{activeHelp.title}</h3>
                <button
                  type="button"
                  onClick={() => setActiveHelp(null)}
                  className="px-2.5 py-1 rounded bg-slate-800 text-xs text-slate-300"
                >
                  Close
                </button>
              </div>
              <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
                {activeHelp.explanation}
              </p>
              <div className="p-3 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-xs text-cyan-200">
                <strong>Example:</strong> {activeHelp.example}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const speciesModels = ecosystem.modelRegistry.filter(
    (m) => m.speciesId === selectedSpecies.id
  );
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
    <div className="fixed inset-0 w-full h-full bg-[#070b12] text-slate-100 flex flex-col overflow-hidden select-none">
      {/* Top Back-Office Admin Header */}
      <header className="h-14 px-6 bg-[#0b111e] border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-xs font-mono font-bold text-cyan-300 uppercase">
            BACK-OFFICE AI STUDIO
          </span>
          <span className="text-slate-600">·</span>
          <span className="text-sm font-bold text-white">
            Abyssal Evo · Advanced AI Trainer, 50-Species Lab &amp; Dynamic 24/7 Fish Keeper
          </span>
        </div>

        {/* Global CPU Usage Limit Control in Header + Admin Profile */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-700 rounded-lg px-3 py-1.5">
            <span className="text-xs text-slate-300 font-medium">PC / Phone CPU Limit:</span>
            <input
              type="range"
              aria-label="CPU Usage Limit Percentage"
              min={10}
              max={100}
              step={5}
              value={cpuUsageLimitPct}
              onChange={(e) => setCpuUsageLimitPct(Number(e.target.value))}
              className="w-24 accent-cyan-400 cursor-pointer"
            />
            <span className="text-xs font-mono font-bold text-cyan-300 w-14 text-right">
              {cpuUsageLimitPct === 100 ? 'MAX' : `${cpuUsageLimitPct}%`}
            </span>
            <button
              type="button"
              onClick={() => setActiveHelp(TRAINER_HELP.cpu_usage_limit)}
              className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-bold"
              title="What is CPU Usage Limit?"
            >
              ?
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400 hidden md:inline font-mono">
              Admin: <strong className="text-emerald-300">{adminUser.email}</strong>
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
              className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:text-white text-xs"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* 5-Tab Studio Navigation Bar */}
      <nav
        aria-label="Trainer Sections"
        className="px-6 py-2.5 bg-[#0d1526] border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 overflow-x-auto"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('train_models')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
              activeTab === 'train_models'
                ? 'bg-cyan-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            1. Train Base Models (Up to 1,000+ Gens)
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('offline_service')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
              activeTab === 'offline_service'
                ? 'bg-emerald-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            2. Dynamic 24/7 Fish Keeper ({localOfflineKeeperFishes.length} in Keeper ·{' '}
            {localOnlineInGameFishes.length} Online in Game)
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('species_editor')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
              activeTab === 'species_editor'
                ? 'bg-amber-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            3. Base Model Properties &amp; 50 Famous Fishes ({ecosystem.speciesList.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('brain_lab')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
              activeTab === 'brain_lab'
                ? 'bg-violet-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            4. Neural Brain Architecture Lab
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('evolution_lab')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
              activeTab === 'evolution_lab'
                ? 'bg-sky-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            5. Evolution Rules, Lineage, A/B Trials &amp; Admins
          </button>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleResetAllFishesKeepBaseModels}
            className="px-3.5 py-2 rounded-lg bg-rose-500/20 border border-rose-400/60 text-rose-200 hover:bg-rose-500 hover:text-white text-xs font-bold transition-colors whitespace-nowrap shadow-sm"
            title="Reset all fishes to fresh Gen 1 starters while keeping all trained Base Models and Species properties intact"
          >
            Reset All Fishes (Keep Base Models)
          </button>
          <span className="text-xs font-mono text-slate-400 hidden xl:inline">
            {firestoreSyncStatus}
          </span>
        </div>
      </nav>

      {statusBanner && (
        <div className="px-6 py-2.5 bg-cyan-950/70 border-b border-cyan-700/50 flex items-center justify-between text-xs text-cyan-100 shrink-0">
          <span>{statusBanner}</span>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-cyan-300 hover:text-white font-bold ml-4"
          >
            Dismiss
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

                  {/* Step 1: Choose Fish Type */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300 block">
                      Step 1: Choose Fish Species to Train ({ecosystem.speciesList.length} in
                      Active Catalog)
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 max-h-48 overflow-y-auto lab-scroll pr-1">
                      {ecosystem.speciesList.map((sp) => (
                        <button
                          key={sp.id}
                          type="button"
                          onClick={() => setSelectedSpeciesId(sp.id)}
                          className={`p-3 rounded-xl border text-left transition-colors ${
                            selectedSpecies.id === sp.id
                              ? 'bg-cyan-500/20 border-cyan-400 text-white'
                              : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: sp.primaryColorHex }}
                            />
                            <span className="text-xs font-bold truncate">{sp.name}</span>
                          </div>
                          <div className="text-[11px] font-mono text-cyan-300 mt-1">
                            {sp.activeBaseModelVersion} · {sp.lifespan.lifespanSimHours}h Life
                          </div>
                        </button>
                      ))}
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
                          Generations to Train
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
                        Start Training {selectedSpecies.name} ({trainGenerations} Generations at{' '}
                        {cpuUsageLimitPct}% CPU)
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-cyan-300">
                            Training Generation {trainingProgressGen} of {trainGenerations} (CPU
                            capped at {cpuUsageLimitPct}%)...
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
                                Math.round((trainingProgressGen / Math.max(1, trainGenerations)) * 100)
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
                          Saved Versions ({selectedSpecies.name})
                        </h3>
                        <p className="text-xs text-slate-400">
                          Stored in Firestore <code className="text-cyan-300">base_models</code>
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
                      {speciesModels.map((m) => (
                        <div
                          key={m.versionId}
                          className={`p-3.5 rounded-xl border space-y-2 ${
                            m.isPromotedBase
                              ? 'bg-emerald-950/30 border-emerald-500/50'
                              : 'bg-slate-900/90 border-slate-800'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-mono font-bold text-white">
                              {m.versionId}
                            </span>
                            {m.isPromotedBase ? (
                              <span className="text-[10px] font-mono font-bold text-emerald-300 uppercase">
                                Active in Game
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSetActiveBaseModel(m.versionId)}
                                className="px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 text-[11px] font-semibold"
                              >
                                Use This Version
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
            const displayedFishes: FishEntity[] =
              fishListFilter === 'offline'
                ? localOfflineKeeperFishes
                : fishListFilter === 'dead'
                ? deadFishes
                : ecosystem.fishes;

            const activeSelectedFish: FishEntity | null =
              ecosystem.fishes.find((f) => f.lineage.fishId === selectedFishId) ||
              displayedFishes[0] ||
              ecosystem.fishes[0] ||
              null;

            const selectedFishSpecies = activeSelectedFish
              ? ecosystem.speciesList.find((s) => s.id === activeSelectedFish.lineage.speciesId) ||
                ecosystem.speciesList[0]
              : null;

            const isSelectedFishOnlineInGame = activeSelectedFish
              ? activeSessionTankIds.includes(activeSelectedFish.lineage.tankId)
              : false;

            return (
              <div className="space-y-6">
                {/* Top Explanation & Controls Card */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="max-w-2xl">
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold text-white">
                          Dynamic 24/7 Fish Keeper Service (Single-Location Exclusive Execution)
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
                        Each fish runs in{' '}
                        <strong className="text-cyan-300">only one place at a time</strong>: when an
                        owner opens the game, their fishes are{' '}
                        <strong className="text-amber-300">
                          removed from this Keeper
                        </strong>{' '}
                        and run exclusively inside the owner&rsquo;s game. When the owner closes the
                        game, their offline fishes{' '}
                        <strong className="text-emerald-300">
                          automatically come alive here in the Keeper
                        </strong>
                        . Default time speed is <strong className="text-white">1x</strong> and
                        default feeder is{' '}
                        <strong className="text-white">Their Owner&rsquo;s Feeder</strong>.
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

                      <button
                        type="button"
                        onClick={() => setVisualModeEnabled((v) => !v)}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold border ${
                          visualModeEnabled
                            ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                            : 'bg-slate-900 text-slate-300 border-slate-700'
                        }`}
                      >
                        {visualModeEnabled ? '3D Visuals: ON' : '3D Visuals: OFF (Low CPU)'}
                      </button>
                    </div>
                  </div>

                  {/* Live Summary Counters */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">
                        Offline Fishes Alive in Keeper
                      </div>
                      <div className="text-2xl font-mono font-bold text-emerald-400 mt-1 tabular-nums">
                        {localOfflineKeeperFishes.length}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Running exclusively in Keeper
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">
                        Online Fishes in Owner Game
                      </div>
                      <div className="text-2xl font-mono font-bold text-amber-300 mt-1 tabular-nums">
                        {localOnlineInGameFishes.length}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Paused here · Running in Owner Game
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">Active Feeder (Default: Owner)</div>
                      <div className="text-sm font-mono font-bold text-cyan-300 mt-2">
                        {disableAllFeedersInKeeper
                          ? 'DISABLED (Starving)'
                          : trainerOverrideFeederEnabled
                          ? 'Trainer Global Feeder'
                          : ownerAutoFeederCount > 0
                          ? `Owner Feeder (${ownerAutoFeederCount} Active)`
                          : 'Owner Has 0 Feeders (Starvation Risk)'}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Dead / Starved Fishes: {deadFishes.length}
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
                      <div className="text-xs text-slate-400">Keeper Time &amp; Speed</div>
                      <div className="text-2xl font-mono font-bold text-white mt-1 tabular-nums">
                        {serviceSpeed}x · {serviceStats.simHoursElapsedInService.toFixed(2)}h
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1">
                        Default 1x · CPU Limit:{' '}
                        {cpuUsageLimitPct === 100 ? 'MAX' : `${cpuUsageLimitPct}%`}
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
                          ? 'Bring Fishes into Keeper (Simulate Owner Offline)'
                          : 'Return Fishes to Owner Game (Simulate Owner Online)'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStarveFish(activeSelectedFish?.lineage.fishId)}
                        className="px-3.5 py-2 rounded-lg bg-rose-600 text-white text-xs font-bold hover:bg-rose-500 shadow"
                      >
                        Die from Starvation (Starve Selected Fish)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReproduceFish(activeSelectedFish?.lineage.fishId)}
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

                {/* Optional 3D Visual Peek Window */}
                {visualModeEnabled && (
                  <div className="h-80 rounded-2xl overflow-hidden border border-cyan-500/40 relative">
                    <AquariumCanvas3D
                      ecosystemRef={ecosystemRef}
                      pelletsRef={pelletsRef}
                      threatsRef={threatsRef}
                      cursorPosRef={cursorPosRef}
                      cameraOrbitRef={cameraOrbitRef}
                      selectedFishId={activeSelectedFish?.lineage.fishId || null}
                      screensaverMode={true}
                      qualityTier="mid"
                      fishPolygonQuality="high"
                      activeTankTier={ecosystem.activeTankTier}
                      isPaused={!serviceRunning}
                      onTickSimulation={() => {}}
                    />
                    <div className="absolute top-3 left-3 px-3 py-1.5 rounded bg-black/70 text-xs font-mono text-cyan-300">
                      Live 3D Peek · Offline Fish Keeper Tank (Dead fishes float belly-up at surface)
                    </div>
                  </div>
                )}

                {/* =================================================================
                    INTERACTIVE FISHES LIST (WITH SELECT HIGHLIGHT) +
                    SELECTED FISH DETAILS & ACTIONS INSPECTOR
                   ================================================================= */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Left 7 Columns: Selectable Fishes List with Clear Highlight */}
                  <div className="lg:col-span-7 p-5 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-white">
                          Fishes List — Click a Fish to Select &amp; Run Actions (
                          {displayedFishes.length})
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          {localOfflineKeeperFishes.length} Offline in Keeper ·{' '}
                          {localOnlineInGameFishes.length} Online in Owner Game ·{' '}
                          {deadFishes.length} Dead
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
                          All ({ecosystem.fishes.length})
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
                          Offline in Keeper ({localOfflineKeeperFishes.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setFishListFilter('dead')}
                          className={`px-2.5 py-1 rounded-lg font-bold ${
                            fishListFilter === 'dead'
                              ? 'bg-rose-500 text-white'
                              : 'bg-slate-900 text-slate-300'
                          }`}
                        >
                          Dead ({deadFishes.length})
                        </button>
                      </div>
                    </div>

                    {localOnlineInGameFishes.length > 0 && (
                      <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-amber-200">
                          Owner currently has the game open ({localOnlineInGameFishes.length} live
                          fishes are running in the Owner Game).
                        </span>
                        <button
                          type="button"
                          onClick={handleToggleSimulatedOwnerOnlineState}
                          className="px-3 py-1 rounded-lg bg-amber-400 text-slate-950 font-bold hover:bg-amber-300"
                        >
                          Bring Offline into Keeper Now
                        </button>
                      </div>
                    )}

                    {displayedFishes.length === 0 ? (
                      <div className="p-6 rounded-xl bg-slate-900/80 border border-slate-800 text-center text-xs text-slate-400">
                        No fishes match the current filter. Click &ldquo;All&rdquo; or &ldquo;+ Add
                        2 Fishes&rdquo; above.
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[460px] overflow-y-auto lab-scroll pr-1">
                        {displayedFishes.map((f) => {
                          const isSelected =
                            activeSelectedFish?.lineage.fishId === f.lineage.fishId;
                          const isOnline = activeSessionTankIds.includes(f.lineage.tankId);
                          const sp =
                            ecosystem.speciesList.find((s) => s.id === f.lineage.speciesId) ||
                            ecosystem.speciesList[0];

                          return (
                            <div
                              key={f.lineage.fishId}
                              onClick={() => setSelectedFishId(f.lineage.fishId)}
                              className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                                isSelected
                                  ? 'bg-cyan-950/60 border-2 border-cyan-400 ring-2 ring-cyan-400/30 shadow-lg'
                                  : !f.lineage.alive
                                  ? 'bg-rose-950/25 border-rose-500/40 hover:border-rose-400/70'
                                  : 'bg-slate-900/90 border-slate-800 hover:border-slate-600'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {isSelected && (
                                      <span className="px-2 py-0.5 rounded bg-cyan-400 text-slate-950 text-[10px] font-mono font-bold uppercase">
                                        SELECTED
                                      </span>
                                    )}
                                    <span className="text-sm font-bold text-white">
                                      {f.lineage.name}
                                    </span>
                                    <span className="text-xs font-mono text-cyan-300">
                                      Gen {f.lineage.generation}
                                    </span>
                                    <span className="text-[11px] font-mono text-slate-400">
                                      ({sp?.name || f.lineage.speciesId} · {f.state.lifeStage})
                                    </span>
                                    {!f.lineage.alive ? (
                                      <span className="px-2 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono font-bold uppercase">
                                        DEAD ({f.lineage.causeOfDeath || 'starvation'})
                                      </span>
                                    ) : isOnline ? (
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
                                    Age: {f.state.ageSimHours.toFixed(1)}h /{' '}
                                    {sp?.lifespan.lifespanSimHours || 24}h · Babies:{' '}
                                    {f.state.metrics.offspringProduced} · Brain Decisions:{' '}
                                    {f.state.metrics.decisionsMade}
                                  </div>
                                </div>

                                <div className="flex items-center gap-3">
                                  <div className="w-28">
                                    <div className="flex justify-between text-[11px] font-mono mb-1">
                                      <span className="text-slate-400">Energy</span>
                                      <span
                                        className={
                                          !f.lineage.alive || f.state.energy < 25
                                            ? 'text-rose-400 font-bold'
                                            : 'text-emerald-300'
                                        }
                                      >
                                        {f.lineage.alive ? `${f.state.energy.toFixed(0)}%` : '0%'}
                                      </span>
                                    </div>
                                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                      <div
                                        className={`h-full ${
                                          !f.lineage.alive || f.state.energy < 25
                                            ? 'bg-rose-500'
                                            : 'bg-emerald-400'
                                        }`}
                                        style={{
                                          width: `${
                                            f.lineage.alive ? Math.min(100, f.state.energy) : 0
                                          }%`,
                                        }}
                                      />
                                    </div>
                                  </div>

                                  {/* Quick Row Actions */}
                                  <div
                                    className="flex items-center gap-1.5"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {f.lineage.alive ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setSelectedFishId(f.lineage.fishId);
                                            handleStarveFish(f.lineage.fishId);
                                          }}
                                          className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold"
                                          title="Kill this fish by starvation so it appears dead in the owner's game"
                                        >
                                          Starve
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setSelectedFishId(f.lineage.fishId);
                                            handleReproduceFish(f.lineage.fishId);
                                          }}
                                          className="px-2.5 py-1.5 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-400 text-white text-[11px] font-bold"
                                          title="Make this fish have a baby immediately"
                                        >
                                          Reproduce
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedFishId(f.lineage.fishId);
                                          handleReviveFish(f.lineage.fishId);
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-bold"
                                      >
                                        Revive
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Right 5 Columns: Selected Fish Details & Actions Inspector */}
                  <div className="lg:col-span-5 space-y-5">
                    <div className="p-5 rounded-2xl bg-[#101827] border-2 border-cyan-500/50 space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <div>
                          <span className="text-[10px] font-mono font-bold uppercase text-cyan-300">
                            Selected Fish Inspector &amp; Actions
                          </span>
                          <h3 className="text-base font-bold text-white mt-0.5">
                            {activeSelectedFish
                              ? `${activeSelectedFish.lineage.name} (Gen ${activeSelectedFish.lineage.generation})`
                              : 'No Fish Selected'}
                          </h3>
                        </div>
                        {activeSelectedFish && (
                          <span
                            className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold ${
                              !activeSelectedFish.lineage.alive
                                ? 'bg-rose-600 text-white'
                                : isSelectedFishOnlineInGame
                                ? 'bg-amber-400 text-slate-950'
                                : 'bg-emerald-400 text-slate-950'
                            }`}
                          >
                            {!activeSelectedFish.lineage.alive
                              ? `DEAD (${activeSelectedFish.lineage.causeOfDeath || 'starvation'})`
                              : isSelectedFishOnlineInGame
                              ? 'IN OWNER GAME'
                              : 'IN KEEPER'}
                          </span>
                        )}
                      </div>

                      {activeSelectedFish ? (
                        <>
                          {/* Actions Panel for Selected Fish */}
                          <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2.5">
                            <div className="text-xs font-mono font-bold text-cyan-300 uppercase">
                              Fish Actions ({activeSelectedFish.lineage.name})
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                disabled={!activeSelectedFish.lineage.alive}
                                onClick={() => handleStarveFish(activeSelectedFish.lineage.fishId)}
                                className="py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-bold transition-colors shadow"
                              >
                                Starve (Kill by Starvation)
                              </button>
                              <button
                                type="button"
                                disabled={!activeSelectedFish.lineage.alive}
                                onClick={() =>
                                  handleReproduceFish(activeSelectedFish.lineage.fishId)
                                }
                                className="py-2.5 px-3 rounded-xl bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-40 text-white text-xs font-bold transition-colors shadow"
                              >
                                Reproduce (Have a Baby)
                              </button>
                              <button
                                type="button"
                                disabled={!activeSelectedFish.lineage.alive}
                                onClick={() =>
                                  handleFeedSingleFish(activeSelectedFish.lineage.fishId)
                                }
                                className="py-2 px-3 rounded-xl bg-emerald-500/20 border border-emerald-400/50 hover:bg-emerald-500/30 disabled:opacity-40 text-emerald-200 text-xs font-bold transition-colors"
                              >
                                Feed Fish (+50% Energy)
                              </button>
                              <button
                                type="button"
                                disabled={activeSelectedFish.lineage.alive}
                                onClick={() => handleReviveFish(activeSelectedFish.lineage.fishId)}
                                className="py-2 px-3 rounded-xl bg-cyan-500/20 border border-cyan-400/50 hover:bg-cyan-500/30 disabled:opacity-40 text-cyan-200 text-xs font-bold transition-colors"
                              >
                                Revive Dead Fish
                              </button>
                            </div>
                          </div>

                          {/* Detailed Vitals & Genetics Breakdown */}
                          <div className="grid grid-cols-2 gap-2.5 text-xs font-mono">
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Species &amp; Stage</div>
                              <div className="text-white font-bold mt-0.5">
                                {selectedFishSpecies?.name || activeSelectedFish.lineage.speciesId}{' '}
                                ({activeSelectedFish.state.lifeStage})
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Age / Lifespan</div>
                              <div className="text-white font-bold mt-0.5">
                                {activeSelectedFish.state.ageSimHours.toFixed(2)}h /{' '}
                                {selectedFishSpecies?.lifespan.lifespanSimHours || 24}h
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Energy / Hunger</div>
                              <div
                                className={`font-bold mt-0.5 ${
                                  !activeSelectedFish.lineage.alive ||
                                  activeSelectedFish.state.energy < 25
                                    ? 'text-rose-400'
                                    : 'text-emerald-300'
                                }`}
                              >
                                {activeSelectedFish.state.energy.toFixed(1)}% /{' '}
                                {activeSelectedFish.state.hunger.toFixed(1)}%
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">Health / Stress</div>
                              <div className="text-cyan-300 font-bold mt-0.5">
                                {activeSelectedFish.state.health.toFixed(1)}% /{' '}
                                {activeSelectedFish.state.stress.toFixed(1)}%
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">
                                Babies / Food Eaten
                              </div>
                              <div className="text-fuchsia-300 font-bold mt-0.5">
                                {activeSelectedFish.state.metrics.offspringProduced} Babies ·{' '}
                                {activeSelectedFish.state.metrics.foodPelletsEaten} Pellets
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                              <div className="text-[10px] text-slate-400">
                                Brain Model &amp; Topology
                              </div>
                              <div className="text-amber-300 font-bold mt-0.5">
                                {activeSelectedFish.lineage.modelVersion} [
                                {activeSelectedFish.brain.architecture.hiddenLayers.join(', ')}]
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 col-span-2">
                              <div className="text-[10px] text-slate-400">
                                Genetics &amp; Lineage ID
                              </div>
                              <div className="text-slate-200 mt-0.5 text-[11px]">
                                ID: <code>{activeSelectedFish.lineage.fishId}</code> · Mutations:{' '}
                                {activeSelectedFish.lineage.inheritedMutations.length} · Speed:{' '}
                                {activeSelectedFish.genetics.maxSpeedGene.toFixed(2)}x · Size:{' '}
                                {activeSelectedFish.genetics.bodyScaleGene.toFixed(2)}x
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-slate-400">
                          Click any fish in the list on the left to inspect its details and run
                          actions.
                        </div>
                      )}
                    </div>

                    {/* Cloud Owners Status Card */}
                    <div className="p-5 rounded-2xl bg-[#101827] border border-slate-800 space-y-3">
                      <h3 className="text-sm font-bold text-white">
                        Cloud Owners Synced ({cloudUsers.length})
                      </h3>
                      <div className="space-y-2 max-h-40 overflow-y-auto lab-scroll pr-1">
                        {cloudUsers.map((cu) => {
                          const isOnline =
                            cu.isActivelyPlaying &&
                            Date.now() - (cu.lastGameHeartbeatMs || 0) < 15000;
                          const liveCount = cu.fishBrains.filter((b) => b.alive).length;
                          return (
                            <div
                              key={cu.username}
                              className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-between text-xs"
                            >
                              <div>
                                <div className="font-bold text-white">{cu.username}</div>
                                <div className="text-[11px] font-mono text-slate-400">
                                  {liveCount} Live · Owner Feeder:{' '}
                                  {cu.autoFeederStock > 0
                                    ? `Installed (${cu.autoFeederStock})`
                                    : 'None'}
                                </div>
                              </div>
                              <span
                                className={`text-[11px] font-mono font-bold ${
                                  isOnline ? 'text-amber-300' : 'text-emerald-300'
                                }`}
                              >
                                {isOnline ? 'IN OWNER GAME' : 'OFFLINE IN KEEPER'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
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

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                      Required Owner Level (Shop Unlock)
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
                    <label className="text-xs text-slate-400 block mb-1">3D Body Silhouette</label>
                    <select
                      value={selectedSpecies.bodyStyle}
                      onChange={(e) =>
                        handleUpdateSelectedSpeciesField((s) => {
                          s.bodyStyle = e.target.value as SpeciesConfig['bodyStyle'];
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    >
                      <option value="fusiform_reef">Streamlined Reef / Tetra</option>
                      <option value="angel_disc">Tall Angelfish / Discus</option>
                      <option value="biolum_Latern">Deep-Sea Lantern / Elongated</option>
                      <option value="mandarin_dragonet">Ornate Fan-Fin Dragonet / Betta</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Primary Body Color</label>
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
                    <label className="text-xs text-slate-400 block mb-1">Secondary Color</label>
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
                    <label className="text-xs text-slate-400 block mb-1">Fin Accent Color</label>
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
        </div>
      </main>

      {/* "?" PLAIN-ENGLISH HELP MODAL */}
      {activeHelp && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={activeHelp.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-[#0b1528] border border-cyan-400/60 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">{activeHelp.title}</h3>
              <button
                type="button"
                onClick={() => setActiveHelp(null)}
                className="px-3 py-1 rounded-lg bg-slate-800 text-xs font-semibold text-slate-300 hover:text-white"
              >
                Close
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
              {activeHelp.explanation}
            </p>
            <div className="p-3.5 rounded-xl bg-cyan-950/60 border border-cyan-500/30 text-xs text-cyan-200 leading-relaxed">
              <strong>Example:</strong> {activeHelp.example}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
