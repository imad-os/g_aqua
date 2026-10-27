import React, { useEffect, useRef, useState } from 'react';
import { createBaseBrainInstance } from '../engine/brain';
import {
  DEFAULT_BRAIN_CONFIG,
  DEFAULT_SPECIES_LIST,
  TANK_TIERS,
} from '../engine/defaults';
import {
  addAdminToFirestore,
  AdminUserRecord,
  CloudUserBrainRecord,
  fetchAdminsFromFirestore,
  fetchAllUserBrainRecordsFromFirestore,
  fetchBaseModelsFromFirestore,
  removeAdminFromFirestore,
  saveModelVersionToFirestore,
  signInWithGmailPopup,
  signOutAdminUser,
  stepAndSyncCloudUserOfflineFishes,
  subscribeToFirebaseAuth,
  syncUserBrainsToFirestore,
  verifyAdminInFirestoreCollection,
} from '../engine/firebaseBrainer';
import { getMyPC } from '../engine/mypc';
import {
  evaluateBrainOnBenchmarks,
  nextEntityId,
  runAcceleratedHeadlessTraining,
  spawnFoundingFish,
  stepEcosystemSimulation,
} from '../engine/simulation';
import {
  getActiveGameSessionTankIds,
  loadEcosystemState,
  saveEcosystemState,
} from '../engine/storage';
import {
  FoodPellet,
  ModelVersionRecord,
  OfflineServiceTelemetry,
  SavedEcosystemState,
  SpeciesConfig,
} from '../engine/types';
import { AquariumCanvas3D } from './AquariumCanvas3D';

export type TrainerTabId = 'train_models' | 'offline_service' | 'species_and_admins';

interface TrainerHelpItem {
  title: string;
  explanation: string;
  example: string;
}

const TRAINER_HELP: Record<string, TrainerHelpItem> = {
  where_base_model_saved: {
    title: 'Where Are Base Models Saved?',
    explanation:
      'Every trained Base Brain Model is saved in your Firebase Firestore database (project: "aquarium-caa2b") inside the "base_models" collection. Each fish type and version gets its own document (for example: base_models/neon-tetra__v1.1-G15), plus an active pointer document (base_models/active__neon-tetra) so the main 3D Aquarium game always loads the promoted version automatically.',
    example:
      'When you train a better model for Azure Neon Tetra and click "Use This Version in Game", all new Azure Neon Tetras in the aquarium will start life with that smarter brain.',
  },
  cpu_usage_limit: {
    title: 'CPU Usage Limit (10% to Max)',
    explanation:
      'Controls how much of your PC or phone processor is used while training AI models or running the 24/7 Offline Fish Service. At 10% or 25%, the trainer works in tiny micro-steps and rests in between so your computer stays cool and fast for your daily work.',
    example:
      'Set CPU Usage to 15%–25% when you are using your PC for work or browsing, or slide it to 100% Max when you want training to finish as fast as possible.',
  },
  training_focus: {
    title: 'Training Goal / Focus',
    explanation:
      'Tells the trainer what kind of behavior to reward most while breeding and teaching simulated generations of fish.',
    example:
      '"Fast Food Finder" trains fish to swim quickly toward food on the water surface. "Energy Saver & Survivor" trains fish to cruise smoothly without wasting energy.',
  },
  offline_24_7_service: {
    title: '24/7 Offline Fish Keeper Service',
    explanation:
      'In Abyssal Evo, fishes live 24 hours a day. When a player has the aquarium game open on their TV or browser, their fishes live with them. As soon as the player closes the game, their fishes become "Offline Fishes" and this service keeps their brains, hunger, feeding, and aging running right here in Firestore!',
    example:
      'If a player closes the game and leaves their fishes unfed, they will get hungry and eventually die of starvation here. When the service is running with Auto-Feeder enabled, their fishes stay fed, grow up, and keep learning 24/7.',
  },
  visuals_vs_stats: {
    title: 'Show 3D Visuals vs. Stats-Only Mode',
    explanation:
      'By default, the 24/7 Offline Service runs in "Stats-Only Mode" with 3D graphics turned off so it uses almost zero graphics card power. You can turn on "Show Live 3D Visuals" anytime to peek inside the tank and watch the offline fishes swimming.',
    example:
      'Keep Visuals OFF when leaving the Trainer app running all day in the background on your PC or phone.',
  },
  admins_collection: {
    title: 'Gmail Authentication & Firestore "admins" Collection',
    explanation:
      'This Trainer App is a standalone back-office tool for administrators only. When you sign in with Google (Gmail), the app checks the "admins" collection in your Firestore database (aquarium-caa2b). Only Gmail addresses listed in the "admins" collection are allowed in.',
    example:
      'You can add trusted team members’ Gmail addresses in the "Fish Types & Admins" tab so they can also train models or monitor offline fishes.',
  },
  model_versions: {
    title: 'Model Versions & 1-Click Rollback',
    explanation:
      'Every time you train a fish type, a new numbered version (like v1.1, v1.2) is saved instead of overwriting your old model. If a new version ever acts worse than an older one, you can switch back with one click.',
    example:
      'Look at the "Overall Score %" column and click "Active in Game" on whichever version performs best.',
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

  // Main Navigation Tab (Simplified 3 Tabs)
  const [activeTab, setActiveTab] = useState<TrainerTabId>('train_models');

  const [ecosystem, setEcosystem] = useState<SavedEcosystemState>(() =>
    loadEcosystemState()
  );
  const ecosystemRef = useRef<SavedEcosystemState>(ecosystem);
  ecosystemRef.current = ecosystem;

  // CPU Usage Throttling State (10% -> 100% Max)
  const [cpuUsageLimitPct, setCpuUsageLimitPct] = useState<number>(25);

  // Tab 1: Train Base Models State
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<string>(
    ecosystem.speciesList[0]?.id || DEFAULT_SPECIES_LIST[0].id
  );
  const [trainingGoal, setTrainingGoal] = useState<'forager' | 'survivor' | 'balanced'>('balanced');
  const [trainGenerations, setTrainGenerations] = useState<number>(15);
  const [isTrainingNow, setIsTrainingNow] = useState<boolean>(false);
  const [trainingProgressGen, setTrainingProgressGen] = useState<number>(0);
  const [lastTrainingSummary, setLastTrainingSummary] = useState<string | null>(null);
  const cancelTrainingRef = useRef<boolean>(false);

  // Tab 2: 24/7 Offline Fish Keeper Service State
  const [serviceRunning, setServiceRunning] = useState<boolean>(true);
  const [visualModeEnabled, setVisualModeEnabled] = useState<boolean>(false);
  const [serviceSpeed, setServiceSpeed] = useState<number>(12);
  const [offlineFeederEnabled, setOfflineFeederEnabled] = useState<boolean>(true);
  const [cloudUsers, setCloudUsers] = useState<CloudUserBrainRecord[]>([]);
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
    speedMultiplier: 12,
    cpuUsageLimitPct: 25,
    activeInGameTankIds: [],
    offlineLiveFishCount: 0,
    offlineDeceasedFishCount: 0,
    skippedActivePlayFishCount: 0,
    totalBrainUpdatesExecuted: 0,
    ticksPerSecond: 12,
    simHoursElapsedInService: 0,
    autoFeederEnabledInService: true,
    lastDeathEvent: null,
  });

  // Tab 3: New Fish Type Form State
  const [newSpeciesName, setNewSpeciesName] = useState('');
  const [newSpeciesLifespan, setNewSpeciesLifespan] = useState(24);
  const [newSpeciesColor, setNewSpeciesColor] = useState('#38bdf8');
  const [newSpeciesBodyStyle, setNewSpeciesBodyStyle] =
    useState<SpeciesConfig['bodyStyle']>('fusiform_reef');

  const selectedSpecies =
    ecosystem.speciesList.find((s) => s.id === selectedSpeciesId) ||
    ecosystem.speciesList[0];

  // Check Firebase Auth & Load `admins` and `base_models` from Firestore on mount
  useEffect(() => {
    let mounted = true;

    // Check if admin session was already verified in this browser session
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

    const unsub = subscribeToFirebaseAuth(async (fbUser) => {
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
      unsub();
    };
  }, []);

  // ============================================================================
  // 2. CPU-THROTTLED 24/7 OFFLINE FISH KEEPER LOOP
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
      const eco = ecosystemRef.current;
      const prevMultiplier = eco.timeMultiplier;
      const prevPaused = eco.paused;
      eco.paused = false;
      eco.timeMultiplier = serviceSpeed;

      // Check which tanks are currently open in an active game session
      const activeTankIds = getActiveGameSessionTankIds();

      // Step local offline fishes
      const stepRes = stepEcosystemSimulation(eco, pelletsRef.current, [], 0.4, {
        allowAutoFeeders: offlineFeederEnabled,
        onlyOfflineFish: true,
        activeSessionTankIds: activeTankIds,
        onDeath: (fish, reason) => {
          lastDeathMsg = `${fish.lineage.name} (Gen ${fish.lineage.generation}) died of ${reason} at ${fish.state.ageSimHours.toFixed(1)}h`;
        },
      });

      eco.timeMultiplier = prevMultiplier;
      eco.paused = prevPaused;

      ticksCounter++;
      totalUpdates += stepRes.liveFishUpdated;
      simHoursAccum += stepRes.simHoursDelta;

      let offlineLive = 0;
      let offlineDead = 0;
      let skippedActive = 0;

      for (const f of eco.fishes) {
        const isOnlineInGame = activeTankIds.includes(f.lineage.tankId);
        if (isOnlineInGame) {
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

      for (const cu of cloudUsers) {
        if (cu.username === profileName) continue;
        const isUserOnlineNow =
          cu.isActivelyPlaying && nowMs - (cu.lastGameHeartbeatMs || 0) < 18000;
        if (isUserOnlineNow) {
          cloudOnlineSkippedCount += cu.fishBrains.filter((b) => b.alive).length;
        } else {
          const cloudStep = await stepAndSyncCloudUserOfflineFishes(
            cu,
            stepRes.simHoursDelta,
            offlineFeederEnabled
          );
          cloudOfflineLiveCount += cloudStep.updatedLiveCount;
          totalUpdates += cloudStep.updatedLiveCount;
          if (cloudStep.newlyStarvedNames.length > 0) {
            lastDeathMsg = `${cloudStep.newlyStarvedNames[0]} starved (no food)`;
          }
        }
      }

      setServiceStats({
        running: true,
        visualModeEnabled,
        speedMultiplier: serviceSpeed,
        cpuUsageLimitPct,
        activeInGameTankIds: activeTankIds,
        offlineLiveFishCount: offlineLive + cloudOfflineLiveCount,
        offlineDeceasedFishCount: offlineDead + eco.deceasedArchive.length,
        skippedActivePlayFishCount: skippedActive + cloudOnlineSkippedCount,
        totalBrainUpdatesExecuted: totalUpdates,
        ticksPerSecond: Number(((1000 / intervalMs) * (offlineLive || 1)).toFixed(1)),
        simHoursElapsedInService: Number(simHoursAccum.toFixed(3)),
        autoFeederEnabledInService: offlineFeederEnabled,
        lastDeathEvent: lastDeathMsg,
      });

      saveEcosystemState(eco);
      setEcosystem({ ...eco });

      if (ticksCounter % 8 === 0) {
        syncUserBrainsToFirestore(
          profileName,
          profileId,
          eco.fishes,
          false,
          offlineFeederEnabled ? 1 : 0
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
    offlineFeederEnabled,
    visualModeEnabled,
    cloudUsers,
    profileName,
    profileId,
  ]);

  // ============================================================================
  // 3. CPU-THROTTLED BASE MODEL TRAINING (RESPECTS 10% -> 100% MAX CPU SLIDER)
  // ============================================================================
  const handleStartCpuThrottledTraining = async () => {
    if (isTrainingNow) return;
    setIsTrainingNow(true);
    setTrainingProgressGen(0);
    cancelTrainingRef.current = false;

    const totalGens = Math.max(1, trainGenerations);
    let workingState = JSON.parse(
      JSON.stringify(ecosystemRef.current)
    ) as SavedEcosystemState;

    // Apply simplified Training Goal preset to species brain & selection weights
    const sp =
      workingState.speciesList.find((s) => s.id === selectedSpecies.id) ||
      workingState.speciesList[0];
    if (trainingGoal === 'forager') {
      workingState.evolutionConfig.selectionStrengthForaging = 0.95;
      workingState.evolutionConfig.selectionStrengthSurvival = 0.6;
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

    // Run 1 generation per step and pause between steps based on cpuUsageLimitPct (10% -> 100%)
    for (let g = 1; g <= totalGens; g++) {
      if (cancelTrainingRef.current) break;

      const stepRes = runAcceleratedHeadlessTraining(
        workingState,
        selectedSpecies.id,
        1,
        24,
        0.1
      );
      lastCandidate = stepRes.candidateModel;
      totalSimulated += stepRes.fishSimulatedCount;
      setTrainingProgressGen(g);

      // Duty-cycle sleep so we only use the requested fraction of the user's PC CPU
      // At 100% CPU -> 8ms yield; at 25% CPU -> 95ms sleep; at 10% CPU -> 260ms sleep
      const sleepMs =
        cpuUsageLimitPct >= 95
          ? 8
          : Math.round(((100 - cpuUsageLimitPct) / Math.max(10, cpuUsageLimitPct)) * 32);
      await new Promise((r) => window.setTimeout(r, sleepMs));
    }

    if (lastCandidate) {
      // Save trained model to `base_models` collection in Firestore (`aquarium-caa2b`)
      await saveModelVersionToFirestore(adminUser?.email || profileName, lastCandidate);

      saveEcosystemState(workingState);
      ecosystemRef.current = workingState;
      setEcosystem(workingState);

      const summary = `Finished training ${lastCandidate.versionId} for ${selectedSpecies.name} (${totalSimulated} fishes simulated at ${cpuUsageLimitPct}% CPU limit). Food Finding Score: ${lastCandidate.benchmark.foragingEfficiency}% · Overall Score: ${lastCandidate.benchmark.overallComposite}% — Saved to Firestore "base_models/${selectedSpecies.id}__${lastCandidate.versionId}".`;
      setLastTrainingSummary(summary);
      setStatusBanner(summary);
    }

    setIsTrainingNow(false);
  };

  const handleSetActiveBaseModel = async (versionId: string) => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    let promotedModel: ModelVersionRecord | null = null;

    next.modelRegistry.forEach((m) => {
      if (m.speciesId === selectedSpecies.id) {
        m.isPromotedBase = m.versionId === versionId;
        if (m.isPromotedBase) promotedModel = m;
      }
    });
    const sp = next.speciesList.find((s) => s.id === selectedSpecies.id);
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

  // Offline Fish Actions
  const handleFeedOfflineFishes = () => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    for (const f of next.fishes) {
      if (f.lineage.alive) {
        f.state.energy = Math.min(100, f.state.energy + 35);
        f.state.hunger = Math.max(0, 100 - f.state.energy);
      }
    }
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setStatusBanner('Fed all live offline fishes (+35% Energy).');
  };

  const handleStarvationTest = () => {
    setOfflineFeederEnabled(false);
    pelletsRef.current.length = 0;
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const target = next.fishes.find((f) => f.lineage.alive);
    if (target) {
      target.state.energy = 0.01;
      target.state.health = 0.05;
      target.state.hunger = 99.9;
    }
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setStatusBanner(
      'Withheld food: starving offline fish energy dropped to 0% — fish died and brain updates stopped.'
    );
  };

  const handleAddOfflinePair = () => {
    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    const sp = next.speciesList[0] || DEFAULT_SPECIES_LIST[0];
    next.fishes.push(
      spawnFoundingFish(sp, next.activeTankTier, next.simHoursTotal, next.fishes.length),
      spawnFoundingFish(sp, next.activeTankTier, next.simHoursTotal, next.fishes.length + 1)
    );
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);
    setStatusBanner('Added 2 live fishes to the offline simulation tank.');
  };

  const handleCreateFishType = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSpeciesName.trim()) return;
    const id = `${newSpeciesName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()
      .toString(36)
      .slice(-3)}`;

    const newSp: SpeciesConfig = {
      id,
      name: newSpeciesName.trim(),
      scientificName: 'Pisces evolutio',
      description: 'Custom fish species created in Back-Office Trainer.',
      bodyStyle: newSpeciesBodyStyle,
      primaryColorHex: newSpeciesColor,
      secondaryColorHex: '#0284c7',
      accentColorHex: '#f59e0b',
      activeBaseModelVersion: 'v1.0-base',
      lifespan: {
        ...DEFAULT_SPECIES_LIST[0].lifespan,
        lifespanSimHours: Math.max(4, newSpeciesLifespan),
      },
      baseBrainConfig: { ...DEFAULT_BRAIN_CONFIG },
    };

    const next = JSON.parse(JSON.stringify(ecosystemRef.current)) as SavedEcosystemState;
    next.speciesList.push(newSp);
    const baseBrain = createBaseBrainInstance(newSp.baseBrainConfig, 888);
    const bench = evaluateBrainOnBenchmarks(baseBrain, newSp, next.evolutionConfig, 888);
    const initialModel: ModelVersionRecord = {
      versionId: 'v1.0-base',
      speciesId: newSp.id,
      parentVersionId: null,
      createdAtIso: new Date().toISOString(),
      generationTrained: 1,
      isPromotedBase: true,
      notes: `Initial Base Brain Model for ${newSp.name}`,
      brainConfig: { ...newSp.baseBrainConfig },
      weights: baseBrain.inheritedWeights,
      biases: baseBrain.inheritedBiases,
      benchmark: bench,
    };
    next.modelRegistry.unshift(initialModel);
    saveEcosystemState(next);
    ecosystemRef.current = next;
    setEcosystem(next);

    saveModelVersionToFirestore(adminUser?.email || profileName, initialModel);
    setSelectedSpeciesId(newSp.id);
    setNewSpeciesName('');
    setStatusBanner(
      `Created fish type "${newSp.name}" and saved v1.0-base to Firestore "base_models/${newSp.id}__v1.0-base".`
    );
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
              <span className="px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-300 text-[11px] font-mono font-bold uppercase">
                Standalone Back-Office App
              </span>
              <h1 className="text-xl font-bold text-white mt-2">
                Abyssal Evo · AI Trainer &amp; 24/7 Offline Service
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

          {/* Primary Google Sign-In Popup Button */}
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

          {/* Direct Firestore `admins` Collection Verification (Works even if iframe blocks popups) */}
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

        {/* Help Modal if clicked on Login Screen */}
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
  const liveFishes = ecosystem.fishes.filter((f) => f.lineage.alive);
  const deadFishes = ecosystem.fishes.filter((f) => !f.lineage.alive);

  return (
    <div className="fixed inset-0 w-full h-full bg-[#070b12] text-slate-100 flex flex-col overflow-hidden select-none">
      {/* Top Back-Office Admin Header */}
      <header className="h-14 px-6 bg-[#0b111e] border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-4">
          <span className="px-2.5 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-xs font-mono font-bold">
            BACK-OFFICE TRAINER
          </span>
          <span className="text-sm font-bold text-white">
            Abyssal Evo · AI Base Model Trainer &amp; 24/7 Offline Fish Keeper
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

      {/* Simple 3-Pillar Navigation Bar */}
      <nav
        aria-label="Trainer Sections"
        className="px-6 py-2.5 bg-[#0d1526] border-b border-slate-800 flex items-center justify-between gap-3 shrink-0"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('train_models')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
              activeTab === 'train_models'
                ? 'bg-cyan-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            1. Train Base Models (By Fish Type &amp; Version)
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('offline_service')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
              activeTab === 'offline_service'
                ? 'bg-emerald-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            2. 24/7 Offline Fish Keeper ({serviceStats.offlineLiveFishCount} Live Offline)
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('species_and_admins')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
              activeTab === 'species_and_admins'
                ? 'bg-amber-400 text-slate-950'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            3. Fish Types &amp; Admins ({adminsList.length})
          </button>
        </div>

        <span className="text-xs font-mono text-slate-400 hidden lg:inline">
          {firestoreSyncStatus}
        </span>
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
              TAB 1: TRAIN BASE MODELS (FOR EACH FISH TYPE & VERSION)
             ===================================================================== */}
          {activeTab === 'train_models' && (
            <div className="space-y-6">
              {/* Firestore Storage Location Banner */}
              <div className="p-4 rounded-xl bg-[#0e192d] border border-cyan-500/30 flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-mono uppercase text-cyan-400 font-bold">
                    Where Base Models Are Saved
                  </div>
                  <div className="text-sm font-semibold text-white mt-0.5">
                    Firestore Project:{' '}
                    <code className="text-cyan-300">aquarium-caa2b</code> → Collection:{' '}
                    <code className="text-emerald-300">
                      base_models/{selectedSpecies.id}__{selectedSpecies.activeBaseModelVersion}
                    </code>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Each fish type has its own versioned Base Brain Model. When you promote a
                    version here, the main 3D Aquarium game automatically uses it for that fish
                    type.
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

              {/* Simple 3-Step Training Card */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-bold text-white">
                      Train AI Base Model for a Fish Type
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
                      Step 1: Choose Fish Type to Train
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
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
                          <div className="text-xs font-bold">{sp.name}</div>
                          <div className="text-[11px] font-mono text-cyan-300 mt-1">
                            Active: {sp.activeBaseModelVersion}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Step 2: Choose Training Focus */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300 block">
                      Step 2: What Should This Fish Learn?
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {(
                        [
                          [
                            'balanced',
                            'Balanced All-Rounder',
                            'Good at finding surface food & saving energy',
                          ],
                          [
                            'forager',
                            'Fast Food Finder',
                            'Swims quickly to food on top of the water',
                          ],
                          [
                            'survivor',
                            'Calm Energy Saver',
                            'Cruises smoothly & survives longer when food is low',
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

                  {/* Step 3: Duration & CPU Usage Limit */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                    <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
                      <div className="text-xs font-semibold text-slate-300">
                        Training Length (Generations)
                      </div>
                      <div className="flex gap-2">
                        {[5, 15, 30, 50].map((gCount) => (
                          <button
                            key={gCount}
                            type="button"
                            onClick={() => setTrainGenerations(gCount)}
                            className={`flex-1 py-1.5 rounded text-xs font-mono font-bold border ${
                              trainGenerations === gCount
                                ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                : 'bg-slate-950 text-slate-300 border-slate-800'
                            }`}
                          >
                            {gCount} Gen
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">
                          PC / Phone CPU Limit:{' '}
                          <strong className="text-cyan-300">
                            {cpuUsageLimitPct === 100 ? '100% (Max)' : `${cpuUsageLimitPct}%`}
                          </strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => setActiveHelp(TRAINER_HELP.cpu_usage_limit)}
                          className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-300 text-[11px] font-bold"
                        >
                          ?
                        </button>
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
                      <div className="flex justify-between text-[10px] font-mono text-slate-400">
                        <span>10% (Silent Background)</span>
                        <span>50% (Balanced)</span>
                        <span>MAX Speed</span>
                      </div>
                    </div>
                  </div>

                  {/* Start / Stop Training Button & Progress Bar */}
                  <div className="pt-2 space-y-3">
                    {isTrainingNow ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-cyan-300">
                            Training {selectedSpecies.name}... Generation {trainingProgressGen} /{' '}
                            {trainGenerations} (CPU Limit: {cpuUsageLimitPct}%)
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              cancelTrainingRef.current = true;
                            }}
                            className="px-3 py-1 rounded bg-rose-600 text-white font-bold"
                          >
                            Stop Early
                          </button>
                        </div>
                        <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-cyan-400 transition-all duration-150"
                            style={{
                              width: `${Math.round(
                                (trainingProgressGen / Math.max(1, trainGenerations)) * 100
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleStartCpuThrottledTraining}
                        className="w-full py-3.5 rounded-xl bg-cyan-400 text-slate-950 font-bold text-sm hover:bg-cyan-300 transition-colors shadow-lg"
                      >
                        Start Training New Version for {selectedSpecies.name} ({cpuUsageLimitPct}%
                        CPU)
                      </button>
                    )}

                    {lastTrainingSummary && (
                      <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/40 text-xs text-emerald-200">
                        {lastTrainingSummary}
                      </div>
                    )}
                  </div>
                </div>

                {/* Saved Versions & Rollback Card */}
                <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 flex flex-col justify-between space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-white">
                        Saved Versions ({selectedSpecies.name})
                      </h3>
                      <button
                        type="button"
                        onClick={() => setActiveHelp(TRAINER_HELP.model_versions)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                      >
                        ?
                      </button>
                    </div>
                    <p className="text-xs text-slate-400">
                      Click any version below to make it the active Base Model in the game.
                    </p>

                    <div className="space-y-2.5 max-h-80 overflow-y-auto lab-scroll pr-1">
                      {speciesModels.map((m) => (
                        <div
                          key={m.versionId}
                          className={`p-3.5 rounded-xl border space-y-2 ${
                            m.isPromotedBase
                              ? 'bg-cyan-950/40 border-cyan-400'
                              : 'bg-slate-900/90 border-slate-800'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-mono font-bold text-white">
                              {m.versionId}
                            </span>
                            {m.isPromotedBase ? (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-bold">
                                ACTIVE IN GAME
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSetActiveBaseModel(m.versionId)}
                                className="px-2.5 py-1 rounded bg-cyan-500 text-slate-950 text-[11px] font-bold hover:bg-cyan-400"
                              >
                                Use This Version
                              </button>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-300">
                            <div>Food Finding: {m.benchmark.foragingEfficiency}%</div>
                            <div>Survival: {m.benchmark.survivalRatePct}%</div>
                            <div className="col-span-2 text-cyan-300 font-bold">
                              Overall Score: {m.benchmark.overallComposite}%
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 2: 24/7 OFFLINE FISH KEEPER SERVICE
             ===================================================================== */}
          {activeTab === 'offline_service' && (
            <div className="space-y-6">
              <div className="p-5 rounded-2xl bg-[#101827] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
                <div className="max-w-2xl">
                  <div className="flex items-center gap-2">
                    <h1 className="text-lg font-bold text-white">
                      24/7 Offline Fish Keeper Service
                    </h1>
                    <button
                      type="button"
                      onClick={() => setActiveHelp(TRAINER_HELP.offline_24_7_service)}
                      className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                    >
                      ?
                    </button>
                  </div>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                    Keeps players&rsquo; offline fishes alive 24/24 when they close the game.
                    Fishes currently open in a live game session are skipped so their owner is
                    never interrupted. Only live fishes update; unfed fishes that run out of energy
                    die of starvation and stop updating.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setServiceRunning((v) => !v)}
                    className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-colors ${
                      serviceRunning
                        ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                        : 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                    }`}
                  >
                    {serviceRunning ? 'Pause 24/7 Service' : 'Start 24/7 Service'}
                  </button>

                  <button
                    type="button"
                    onClick={() => setVisualModeEnabled((v) => !v)}
                    className="px-4 py-2.5 rounded-xl bg-slate-800 border border-cyan-500/40 text-xs font-bold text-cyan-300 hover:bg-slate-700"
                  >
                    {visualModeEnabled
                      ? 'Hide 3D Visuals (Stats-Only)'
                      : 'Show Live 3D Visuals'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveHelp(TRAINER_HELP.visuals_vs_stats)}
                    className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                  >
                    ?
                  </button>
                </div>
              </div>

              {/* 4 Simple Telemetry Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-xl bg-[#101827] border border-slate-800">
                  <div className="text-xs text-slate-400">Offline Live Fishes Living Here</div>
                  <div
                    data-testid="offline-live-fish-count"
                    className="text-3xl font-mono font-bold text-emerald-400 mt-1"
                  >
                    {serviceStats.offlineLiveFishCount}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">
                    Online With Owner (Skipped): {serviceStats.skippedActivePlayFishCount}
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#101827] border border-slate-800">
                  <div className="text-xs text-slate-400">Starved / Dead (Brain Stopped)</div>
                  <div
                    data-testid="offline-dead-fish-count"
                    className="text-3xl font-mono font-bold text-rose-400 mt-1"
                  >
                    {serviceStats.offlineDeceasedFishCount}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1 truncate">
                    {serviceStats.lastDeathEvent || 'All offline fishes fed'}
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#101827] border border-slate-800">
                  <div className="text-xs text-slate-400">Brain Updates Completed</div>
                  <div className="text-3xl font-mono font-bold text-cyan-400 mt-1">
                    {serviceStats.totalBrainUpdatesExecuted}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">
                    CPU Limit: {cpuUsageLimitPct}% ({serviceStats.ticksPerSecond} updates/s)
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#101827] border border-slate-800">
                  <div className="text-xs text-slate-400">Offline Feeder &amp; View Mode</div>
                  <div className="text-lg font-mono font-bold text-white mt-1">
                    {visualModeEnabled ? '3D VISUALS ON' : 'STATS ONLY (0% GPU)'}
                  </div>
                  <div className="text-[11px] font-mono text-amber-300 mt-1">
                    Offline Auto-Feeder: {offlineFeederEnabled ? 'ON (Keeping Fed)' : 'OFF'}
                  </div>
                </div>
              </div>

              {/* Simple Offline Care Controls */}
              <div className="p-4 rounded-xl bg-[#101827] border border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleFeedOfflineFishes}
                    className="px-3.5 py-2 rounded-lg bg-emerald-500 text-slate-950 text-xs font-bold hover:bg-emerald-400"
                  >
                    Feed Offline Fishes Now (+35% Energy)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOfflineFeederEnabled((v) => !v)}
                    className="px-3.5 py-2 rounded-lg bg-slate-800 text-slate-200 border border-slate-700 text-xs font-semibold"
                  >
                    {offlineFeederEnabled ? 'Turn Off Auto-Feeder' : 'Turn On Auto-Feeder'}
                  </button>
                  <button
                    type="button"
                    onClick={handleStarvationTest}
                    className="px-3.5 py-2 rounded-lg bg-rose-950/80 text-rose-300 border border-rose-700/50 text-xs font-semibold hover:bg-rose-900"
                  >
                    Test Starvation (No Food)
                  </button>
                  <button
                    type="button"
                    onClick={handleAddOfflinePair}
                    className="px-3.5 py-2 rounded-lg bg-slate-800 text-cyan-300 border border-cyan-500/30 text-xs font-semibold"
                  >
                    +2 Offline Fishes
                  </button>
                </div>

                <label className="text-xs text-slate-300 flex items-center gap-2">
                  <span>Offline Speed:</span>
                  <select
                    value={serviceSpeed}
                    onChange={(e) => setServiceSpeed(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white"
                  >
                    <option value={1}>1x Real-Time</option>
                    <option value={12}>12x Fast</option>
                    <option value={24}>24x Daily Cycle</option>
                  </select>
                </label>
              </div>

              {/* Optional 3D Tank Preview */}
              {visualModeEnabled && (
                <div className="relative h-80 w-full rounded-2xl border border-cyan-500/40 overflow-hidden bg-[#040b14]">
                  <AquariumCanvas3D
                    ecosystemRef={ecosystemRef}
                    pelletsRef={pelletsRef}
                    threatsRef={threatsRef}
                    cursorPosRef={cursorPosRef}
                    cameraOrbitRef={cameraOrbitRef}
                    selectedFishId={null}
                    screensaverMode={true}
                    qualityTier="mid"
                    fishPolygonQuality="high"
                    activeTankTier={ecosystem.activeTankTier}
                    isPaused={!serviceRunning}
                    onTickSimulation={() => {}}
                  />
                  <div className="absolute top-3 left-3 px-3 py-1.5 bg-[#091220]/90 border border-slate-700 rounded text-xs font-mono text-cyan-300">
                    LIVE 3D PREVIEW OF OFFLINE FISHES ({liveFishes.length} ALIVE)
                  </div>
                </div>
              )}

              {/* Live Offline Fishes Table vs Starved/Dead List */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 p-5 rounded-2xl bg-[#101827] border border-slate-800">
                  <h2 className="text-sm font-bold text-white mb-3">
                    Live Offline Fishes Updating Brains Right Now ({liveFishes.length})
                  </h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400 font-mono">
                          <th className="py-2 pr-3">Fish Name &amp; Gen</th>
                          <th className="py-2 px-3">Age</th>
                          <th className="py-2 px-3">Energy (Fullness)</th>
                          <th className="py-2 px-3">Brain Updates</th>
                          <th className="py-2 pl-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 font-mono">
                        {liveFishes.map((f) => (
                          <tr key={f.lineage.fishId}>
                            <td className="py-2.5 pr-3 text-white font-sans font-semibold">
                              {f.lineage.name} · Gen {f.lineage.generation}
                            </td>
                            <td className="py-2.5 px-3 text-slate-300">
                              {f.state.ageSimHours.toFixed(1)}h ({f.state.lifeStage})
                            </td>
                            <td className="py-2.5 px-3">
                              <span
                                className={
                                  f.state.energy < 30 ? 'text-rose-400' : 'text-emerald-400'
                                }
                              >
                                {f.state.energy.toFixed(0)}% Energy
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-cyan-300">
                              {f.state.metrics.decisionsMade}
                            </td>
                            <td className="py-2.5 pl-3 text-emerald-400">● Living 24/7</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-[#101827] border border-slate-800 space-y-3">
                  <h2 className="text-sm font-bold text-white">
                    Starved / Deceased Fishes (Brain Stopped)
                  </h2>
                  <p className="text-xs text-slate-400">
                    When a fish dies from lack of food, its brain stops updating immediately.
                  </p>
                  <div className="space-y-2 max-h-60 overflow-y-auto lab-scroll">
                    {[...deadFishes.map((d) => d.lineage), ...ecosystem.deceasedArchive]
                      .slice(0, 10)
                      .map((d, i) => (
                        <div
                          key={`${d.fishId}-${i}`}
                          className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg text-xs flex justify-between"
                        >
                          <div>
                            <div className="font-bold text-slate-300">
                              {d.name} (Gen {d.generation})
                            </div>
                            <div className="font-mono text-rose-400">
                              Died of {d.causeOfDeath || 'starvation'}
                            </div>
                          </div>
                          <span className="font-mono text-slate-500">Halted</span>
                        </div>
                      ))}
                    {deadFishes.length === 0 && ecosystem.deceasedArchive.length === 0 && (
                      <div className="text-xs text-slate-500 py-4">No fish deaths yet.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 3: FISH TYPES & FIRESTORE "admins" COLLECTION MANAGER
             ===================================================================== */}
          {activeTab === 'species_and_admins' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Firestore `admins` Collection Manager */}
              <div className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-white">
                      Authorized Gmail Admins (Firestore <code className="text-cyan-300">admins</code>)
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Only Gmail accounts in this Firestore collection can access this Trainer
                      Back-Office app.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveHelp(TRAINER_HELP.admins_collection)}
                    className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                  >
                    ?
                  </button>
                </div>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newAdminEmailInput.trim()) return;
                    const updated = await addAdminToFirestore(
                      newAdminEmailInput,
                      newAdminNameInput || newAdminEmailInput,
                      adminUser.email
                    );
                    setAdminsList(updated);
                    setNewAdminEmailInput('');
                    setNewAdminNameInput('');
                    setStatusBanner(
                      `Added "${newAdminEmailInput}" to Firestore "admins" collection.`
                    );
                  }}
                  className="flex flex-wrap gap-2 pt-1"
                >
                  <input
                    type="email"
                    required
                    placeholder="new.admin@gmail.com"
                    value={newAdminEmailInput}
                    onChange={(e) => setNewAdminEmailInput(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  />
                  <input
                    type="text"
                    placeholder="Display Name (optional)"
                    value={newAdminNameInput}
                    onChange={(e) => setNewAdminNameInput(e.target.value)}
                    className="w-40 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg bg-cyan-400 text-slate-950 text-xs font-bold hover:bg-cyan-300"
                  >
                    + Add Admin
                  </button>
                </form>

                <div className="space-y-2 pt-2">
                  {adminsList.map((adm) => (
                    <div
                      key={adm.email}
                      className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-bold text-white">{adm.email}</div>
                        <div className="text-slate-400 font-mono text-[11px]">
                          Role: {adm.role.toUpperCase()} · Added by {adm.addedBy}
                        </div>
                      </div>
                      {adm.role !== 'owner' && (
                        <button
                          type="button"
                          onClick={async () => {
                            const updated = await removeAdminFromFirestore(adm.email);
                            setAdminsList(updated);
                          }}
                          className="px-2.5 py-1 rounded bg-rose-950 text-rose-300 border border-rose-700/40 text-[11px]"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Simple Add New Fish Type Card */}
              <form
                onSubmit={handleCreateFishType}
                className="p-6 rounded-2xl bg-[#101827] border border-slate-800 space-y-4"
              >
                <h2 className="text-base font-bold text-white">Add a New Fish Type</h2>
                <p className="text-xs text-slate-400">
                  Creates a new fish type with its own 3D body style, lifespan hours, and initial{' '}
                  <code className="text-cyan-300">v1.0-base</code> brain model in Firestore.
                </p>

                <label className="block space-y-1">
                  <span className="text-xs text-slate-300">Fish Common Name</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Golden Sunburst Discus"
                    value={newSpeciesName}
                    onChange={(e) => setNewSpeciesName(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  />
                </label>

                <div className="grid grid-cols-3 gap-3">
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-300">Lifespan (Hours)</span>
                    <input
                      type="number"
                      min={6}
                      max={120}
                      value={newSpeciesLifespan}
                      onChange={(e) => setNewSpeciesLifespan(Number(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs text-slate-300">3D Body Shape</span>
                    <select
                      value={newSpeciesBodyStyle}
                      onChange={(e) =>
                        setNewSpeciesBodyStyle(e.target.value as SpeciesConfig['bodyStyle'])
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white"
                    >
                      <option value="fusiform_reef">Sleek Reef Torpedo</option>
                      <option value="angel_disc">Tall Angelfish Disc</option>
                      <option value="biolum_Latern">Deep Chromis</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs text-slate-300">Primary Color</span>
                    <input
                      type="color"
                      value={newSpeciesColor}
                      onChange={(e) => setNewSpeciesColor(e.target.value)}
                      className="w-full h-9 bg-slate-900 border border-slate-700 rounded-lg p-1 cursor-pointer"
                    />
                  </label>
                </div>

                <button
                  type="submit"
                  className="w-full py-3 rounded-xl bg-amber-400 text-slate-950 font-bold text-xs hover:bg-amber-300 transition-colors"
                >
                  Create Fish Type &amp; Save Base Model to Firestore
                </button>
              </form>
            </div>
          )}
        </div>
      </main>

      {/* PLAIN-ENGLISH "?" EXPLANATION MODAL */}
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
                className="px-2.5 py-1 rounded bg-slate-800 text-xs text-slate-300 hover:text-white"
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
};
