import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AquariumCanvas3D,
  getPolygonSpecForQuality,
} from './components/AquariumCanvas3D';
import { audioEngine } from './engine/audio';
import { createBaseBrainInstance } from './engine/brain';
import { DEFAULT_SPECIES_LIST, TANK_TIERS } from './engine/defaults';
import {
  CloudUserBrainRecord,
  fetchBaseModelsFromFirestore,
  FIRESTORE_CHECKPOINT_INTERVAL_MS,
  loadUserBrainsFromFirestore,
  setUserOnlineStatusInFirestore,
  subscribeToSingleUserBrainRecord,
  syncUserBrainsToFirestore,
} from './engine/firebaseBrainer';
import { getMyPC, I18N, MyPCInfo } from './engine/mypc';
import {
  awardOwnerXp,
  getTankBoundsAtZ,
  nextEntityId,
  spawnFoundingFish,
  stepEcosystemSimulation,
} from './engine/simulation';
import {
  createInitialEcosystemState,
  isForceOfflineOverrideActive,
  loadEcosystemState,
  publishActiveGameSessionLease,
  saveEcosystemState,
  saveEcosystemStateAsync,
  setForceOfflineOverride,
} from './engine/storage';
import {
  EnvironmentQualityTier,
  FishBrainInstance,
  FishPolygonQuality,
  FoodPellet,
  SavedEcosystemState,
  SpeciesConfig,
  ThreatEntity,
} from './engine/types';

type GameScreenState = 'title' | 'playing' | 'paused';
type SettingsModalTab = 'fish_stats' | 'aquarium_shop' | 'graphics_polygons';

const MODAL_TABS_ORDER: SettingsModalTab[] = [
  'fish_stats',
  'aquarium_shop',
  'graphics_polygons',
];

interface HelpTopic {
  title: string;
  body: string;
  tip: string;
}

const HELP_TOPICS: Record<string, HelpTopic> = {
  fish_polygons: {
    title: '3D Fish Polygon Quality (Mesh Detail)',
    body: 'Controls how many 3D triangles are used to sculpt each fish body, gill cover, eye, and volumetric fin fan. Higher polygon counts create ultra-smooth organic curves when fishes turn and bend their spines.',
    tip: 'Pick "High" or "Ultra" on PC and modern TVs for the cleanest 3D fish silhouettes, or "Low / Medium" on older low-power devices.',
  },
  lighting_quality: {
    title: 'Environment Lighting & Shadows',
    body: 'Controls real-time underwater soft shadows, glass reflections, and high-DPI retina sharpness inside the aquarium.',
    tip: 'Set to "High" for realistic seabed shadows beneath swimming fishes.',
  },
  owner_level_shop: {
    title: 'Owner Level, Fish Shop & Tank Space (3 to 6 Max)',
    body: 'Feeding fishes, keeping water clean, and raising babies earns Owner XP and raises your Owner Level. Higher Owner Levels unlock new famous fish species in the shop! Upgrading your aquarium tank is strictly for more space: Tank 1 holds 3 fishes, Tank 2 holds 4, Tank 3 holds 5, and Tank 4 holds the maximum of 6 fishes.',
    tip: 'Babies hatched by AI breeding are allowed to exist OVER your tank’s max capacity! When those babies mature into adults over the limit, they stay safely in your tank and new breeding pauses until space frees up.',
  },
  ai_breeding: {
    title: '100% AI-Driven Natural Breeding & Baby Overflow',
    body: 'Just like a real aquarium, you cannot force fishes to hatch babies manually. When adult fishes are well-fed (Energy above 60%) and comfortable in clean water, their AI naturally courts and produces offspring that inherit the mother’s brain. Babies can even hatch over the tank capacity limit (3/4/5/6)!',
    tip: 'Sprinkle food on top of the water regularly and keep water quality clean so your fishes stay satisfied and reproduce on their own.',
  },
  controller_remote: {
    title: 'TV Remote & Game Controller Support',
    body: 'You can play and navigate the entire aquarium and menus using either a TV Remote Controller or a Gamepad Controller. Press "Play/Pause" on your TV Remote or "+ / Select / Start" on your Game Controller anytime to open or close the Owner Menu.',
    tip: 'Use D-Pad / Arrow keys to move between buttons, LB / RB to switch tabs, OK / A to confirm, and Back / B to close.',
  },
  water_care: {
    title: 'Water Quality, Auto-Feeder & 24/7 Offline Keeper',
    body: 'Clean water keeps fish stress low. Installing a Top Auto-Feeder not only feeds your fishes while you watch, but also feeds them automatically in the 24/7 Offline Fish Keeper when you close the game!',
    tip: 'Buy a Top Auto-Feeder in the Shop so your fishes are fed using your own feeder even when the Trainer’s override feeder is off.',
  },
  frameless_tv: {
    title: 'Full-Screen TV Aquarium Mode (No Tank Frames)',
    body: 'Turns your entire TV or monitor into a frameless, edge-to-edge living aquarium window with no metal tank borders or hood. This is the default mode.',
    tip: 'In Full-Screen TV Mode, use the Left / Right / Up / Down arrows on your TV remote or controller to move focus across the buttons on top, and press OK / A to activate the focused button.',
  },
  daylight_mode: {
    title: 'Daylight (ON / OFF) & Automatic Night Bulb Lights',
    body: 'When Daylight is ON, your aquarium is illuminated by natural solar Daylight during daytime (06:00 AM – 06:30 PM) and automatically switches to warm overhead Aquarium Bulb Lights at night (06:30 PM – 06:00 AM). When Daylight is OFF, solar daylight is disabled and the aquarium always uses overhead Bulb Lights.',
    tip: 'You can also switch the Fish Time Clock between Real-Time Auto Clock, Preview Day, or Preview Night to test Daylight vs. Bulb Lights anytime.',
  },
};

export default function App() {
  const mypc = getMyPC();

  const initialScreen = ((): GameScreenState => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') return 'playing';
    }
    return 'title';
  })();

  const [screenState, setScreenState] = useState<GameScreenState>(initialScreen);
  const screenStateRef = useRef<GameScreenState>(initialScreen);
  screenStateRef.current = screenState;

  const [mypcInfo, setMypcInfo] = useState<MyPCInfo>(() => {
    const info = mypc.info();
    return (
      info || {
        standalone: true,
        lang: 'en',
        rtl: false,
        volume: { music: 0.7, sfx: 0.8 },
        profile: { id: 'local-caretaker', name: 'Keeper' },
        quality: { tier: 'high' },
        app: { id: 'abyssal-evo' },
      }
    );
  });

  const [ecosystem, setEcosystem] = useState<SavedEcosystemState>(() => {
    const loaded = loadEcosystemState();
    loaded.timeMultiplier = 1;
    return loaded;
  });
  const ecosystemRef = useRef<SavedEcosystemState>(ecosystem);
  ecosystemRef.current = ecosystem;

  // Settings & Fish Stats Modal State
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const settingsOpenRef = useRef<boolean>(false);
  settingsOpenRef.current = settingsOpen;

  const [settingsTab, setSettingsTab] = useState<SettingsModalTab>('fish_stats');
  const settingsTabRef = useRef<SettingsModalTab>('fish_stats');
  settingsTabRef.current = settingsTab;

  const [helpModalTopic, setHelpModalTopic] = useState<HelpTopic | null>(null);
  const helpModalRef = useRef<HelpTopic | null>(null);
  helpModalRef.current = helpModalTopic;

  // Spatial TV Remote / Gamepad Focus Index inside open dialogs
  const [focusedBtnIndex, setFocusedBtnIndex] = useState<number>(0);
  const focusedBtnIndexRef = useRef<number>(0);
  focusedBtnIndexRef.current = focusedBtnIndex;

  const [polyStats, setPolyStats] = useState<{
    trianglesPerFish: number;
    totalFishTriangles: number;
  }>({ trianglesPerFish: 2950, totalFishTriangles: 5900 });
  const [fps, setFps] = useState<number>(60);

  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [nowClock, setNowClock] = useState<Date>(() => new Date());
  const [lastControllerInputLabel, setLastControllerInputLabel] = useState<string>(
    'TV Remote [Play/Pause] or Gamepad [+ / Select / Start] opens Menu'
  );

  // Real-time simulation refs
  const pelletsRef = useRef<FoodPellet[]>([]);
  const threatsRef = useRef<ThreatEntity[]>([]);
  const cursorPosRef = useRef<{ x: number; y: number; z: number }>({
    x: 0,
    y: 0,
    z: 0,
  });
  const cameraOrbitRef = useRef<{ yaw: number; pitch: number; zoom: number }>({
    yaw: 0,
    pitch: 0.08,
    zoom: 1.0,
  });
  const lastHudSyncMsRef = useRef<number>(0);
  const lastLocalSaveMsRef = useRef<number>(0);
  const lastFirestoreSyncMsRef = useRef<number>(0);
  const lastAppliedAdminOverrideMsRef = useRef<number>(ecosystem.adminOverrideAtMs || 0);
  const prevGamepadButtonsRef = useRef<boolean[]>([]);
  const lastDpadAxisMoveMsRef = useRef<number>(0);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const t = window.setTimeout(() => setToastMessage(null), 4200);
    return () => window.clearTimeout(t);
  }, [toastMessage]);

  // Update the top-bar Fish Date & Time clock every 15 seconds (lightweight, zero simulation lag)
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowClock(new Date());
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.body.dataset.state = screenState;
    }
  }, [screenState]);

  /**
   * Applies an authoritative cloud record (or admin override from Trainer) into the live game state
   * so killing/starving, reviving, reproducing, giving a fish, or replacing a fish in the Trainer
   * immediately takes effect in the owner's game even if the owner has the game open!
   */
  const applyCloudRecordToEcosystem = useCallback(
    (cloudRecord: CloudUserBrainRecord, isAuthoritativeOverride: boolean) => {
      if (!cloudRecord || !Array.isArray(cloudRecord.fishBrains)) return;
      const eco = ecosystemRef.current;

      const overrideTs = cloudRecord.adminOverrideAtMs || 0;
      if (isAuthoritativeOverride && overrideTs <= lastAppliedAdminOverrideMsRef.current) {
        return;
      }
      if (!isAuthoritativeOverride && (cloudRecord.updatedAtMs || 0) <= (eco.lastSavedAtMs || 0)) {
        return;
      }

      if (overrideTs > 0) {
        lastAppliedAdminOverrideMsRef.current = overrideTs;
        eco.adminOverrideAtMs = overrideTs;
      }

      const cloudFishIds = new Set(cloudRecord.fishBrains.map((cb) => cb.fishId));
      // If authoritative admin override removed or replaced a fish, filter out missing fishes
      if (isAuthoritativeOverride) {
        eco.fishes = eco.fishes.filter((f) => cloudFishIds.has(f.lineage.fishId));
      }

      let newlyKilledNames: string[] = [];

      for (const cb of cloudRecord.fishBrains) {
        const localFish = eco.fishes.find((f) => f.lineage.fishId === cb.fishId);
        const sp =
          eco.speciesList.find((s) => s.id === cb.speciesId) ||
          eco.speciesList[0] ||
          DEFAULT_SPECIES_LIST[0];

        if (localFish) {
          const wasAlive = localFish.lineage.alive;
          // Also support admin changing/replacing a fish's species!
          localFish.lineage.speciesId = cb.speciesId;
          localFish.lineage.name = cb.name;
          localFish.lineage.generation = cb.generation;
          localFish.lineage.modelVersion = cb.modelVersion;
          localFish.brain = cb.brain;
          localFish.lineage.alive = cb.alive;
          localFish.lineage.causeOfDeath = (cb.causeOfDeath as any) || null;
          localFish.state.energy = cb.energy;
          localFish.state.hunger = cb.hunger;
          localFish.state.ageSimHours = cb.ageSimHours;
          if (!cb.alive) {
            localFish.state.health = 0;
            localFish.state.energy = 0;
            localFish.state.hunger = 100;
            if (wasAlive) newlyKilledNames.push(localFish.lineage.name);
            if (!eco.deceasedArchive.some((d) => d.fishId === localFish.lineage.fishId)) {
              eco.deceasedArchive.unshift({ ...localFish.lineage });
            }
          } else {
            localFish.state.health = Math.max(80, localFish.state.health);
          }
        } else {
          // Reconstruct newly gifted or hatched fish from Trainer / Keeper cloud sync
          const spawned = spawnFoundingFish(
            sp,
            eco.activeTankTier,
            eco.simHoursTotal,
            eco.fishes.length,
            cb.brain
          );
          spawned.lineage.fishId = cb.fishId;
          spawned.lineage.name = cb.name;
          spawned.lineage.generation = cb.generation;
          spawned.lineage.modelVersion = cb.modelVersion;
          spawned.lineage.motherId = cb.motherId;
          spawned.lineage.fatherId = cb.fatherId;
          spawned.lineage.alive = cb.alive;
          spawned.lineage.causeOfDeath = (cb.causeOfDeath as any) || null;
          spawned.state.energy = cb.energy;
          spawned.state.hunger = cb.hunger;
          spawned.state.ageSimHours = cb.ageSimHours;
          spawned.state.lifeStage =
            cb.ageSimHours < sp.lifespan.sexualMaturityAgeHours ? 'juvenile' : 'adult';
          if (!cb.alive) {
            spawned.state.health = 0;
            spawned.state.energy = 0;
          }
          eco.fishes.push(spawned);
        }
      }

      saveEcosystemState(eco);
      ecosystemRef.current = eco;
      setEcosystem({ ...eco });

      if (newlyKilledNames.length > 0) {
        showToast(
          `Alert: ${newlyKilledNames.join(', ')} died from starvation!`
        );
      } else if (isAuthoritativeOverride && cloudRecord.lastAdminAction) {
        showToast(`Trainer Admin Update: ${cloudRecord.lastAdminAction}`);
      }
    },
    [showToast]
  );

  // Helper to get all currently visible focusable buttons in the active modal or overlay
  const getVisibleFocusableButtons = useCallback((): HTMLButtonElement[] => {
    if (typeof document === 'undefined') return [];
    const scopeSelector = helpModalRef.current
      ? '[data-modal-scope="help"]'
      : settingsOpenRef.current
      ? '[data-modal-scope="settings"]'
      : screenStateRef.current === 'paused'
      ? '[data-modal-scope="paused"]'
      : screenStateRef.current === 'title'
      ? '[data-modal-scope="title"]'
      : '[data-modal-scope="hud"]';

    const container = document.querySelector(scopeSelector) || document;
    const nodes = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-tv-focusable="true"]:not([disabled])'
      )
    );
    return nodes.filter((el) => el.offsetParent !== null);
  }, []);

  // Keep TV Remote / Gamepad visual focus synced when modals or tabs change
  useEffect(() => {
    setFocusedBtnIndex(0);
    focusedBtnIndexRef.current = 0;
    const timer = window.setTimeout(() => {
      const buttons = getVisibleFocusableButtons();
      if (buttons[0]) {
        buttons[0].focus({ preventScroll: false });
      }
    }, 40);
    return () => window.clearTimeout(timer);
  }, [settingsOpen, settingsTab, helpModalTopic, screenState, getVisibleFocusableButtons]);

  // Unified TV Remote / Gamepad / Keyboard deduplication gate:
  // Prevents a single physical press on TV Remote or Gamepad from firing 2-3 times
  // when keydown, MyPC SDK onInput, MyPC gamepad.on('button'), and navigator.getGamepads() all fire for the same press.
  const lastControllerActionMsRef = useRef<Record<string, number>>({});
  const canTriggerControllerAction = useCallback(
    (category: 'nav' | 'confirm' | 'cancel' | 'menu' | 'tab', cooldownMs: number): boolean => {
      const now = performance.now();
      const prev = lastControllerActionMsRef.current[category] || 0;
      if (now - prev < cooldownMs) {
        return false;
      }
      lastControllerActionMsRef.current[category] = now;
      return true;
    },
    []
  );

  const moveControllerFocus = useCallback(
    (delta: number) => {
      if (!canTriggerControllerAction('nav', 210)) return;
      const buttons = getVisibleFocusableButtons();
      if (buttons.length === 0) return;
      const nextIdx =
        (((focusedBtnIndexRef.current + delta) % buttons.length) + buttons.length) %
        buttons.length;
      focusedBtnIndexRef.current = nextIdx;
      setFocusedBtnIndex(nextIdx);
      const target = buttons[nextIdx];
      if (target) {
        target.focus({ preventScroll: false });
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },
    [canTriggerControllerAction, getVisibleFocusableButtons]
  );

  const activateFocusedControllerButton = useCallback((): boolean => {
    if (!canTriggerControllerAction('confirm', 320)) return true;
    const buttons = getVisibleFocusableButtons();
    if (buttons.length === 0) return false;
    const idx = Math.min(buttons.length - 1, Math.max(0, focusedBtnIndexRef.current));
    const target = buttons[idx];
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, [canTriggerControllerAction, getVisibleFocusableButtons]);

  const cycleSettingsTab = useCallback(
    (dir: 1 | -1) => {
      if (!canTriggerControllerAction('tab', 260)) return;
      const curIdx = MODAL_TABS_ORDER.indexOf(settingsTabRef.current);
      const nextIdx =
        (curIdx + dir + MODAL_TABS_ORDER.length) % MODAL_TABS_ORDER.length;
      setSettingsTab(MODAL_TABS_ORDER[nextIdx]);
    },
    [canTriggerControllerAction]
  );

  // ============================================================================
  // DYNAMIC 24/7 FISH KEEPER HAND-OFF & REAL-TIME ADMIN OVERRIDE SYNC
  // ============================================================================
  useEffect(() => {
    const syncLatestFromStorage = () => {
      const latest = loadEcosystemState();
      latest.timeMultiplier = 1;
      if ((latest.adminOverrideAtMs || 0) > lastAppliedAdminOverrideMsRef.current) {
        lastAppliedAdminOverrideMsRef.current = latest.adminOverrideAtMs || Date.now();
      }
      ecosystemRef.current = latest;
      setEcosystem({ ...latest });
    };

    const eco = ecosystemRef.current;
    const currentTank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const username = mypc.info()?.profile?.name || 'Keeper';
    const profileId = mypc.info()?.profile?.id || 'local-caretaker';
    const feederCount = eco.autoFeederCountByTank[currentTank.id] || 0;
    const isVisibleAndPlaying =
      screenState === 'playing' &&
      (typeof document === 'undefined' || document.visibilityState === 'visible') &&
      !isForceOfflineOverrideActive();

    if (isVisibleAndPlaying) {
      const latest = loadEcosystemState();
      latest.timeMultiplier = 1;
      ecosystemRef.current = latest;
      setEcosystem({ ...latest });

      publishActiveGameSessionLease(currentTank.id, true);
      // Single event write when game opens (not every second!)
      syncUserBrainsToFirestore(username, profileId, latest.fishes, true, feederCount);
      lastFirestoreSyncMsRef.current = performance.now();
    } else {
      publishActiveGameSessionLease(currentTank.id, false);
      setUserOnlineStatusInFirestore(username, profileId, false, feederCount);
    }

    // Subscribe to real-time authoritative admin overrides from Firestore (`mypc_user_brains/{username}`)
    const unsubAdminOverride = subscribeToSingleUserBrainRecord(username, (record) => {
      if (!record) return;
      if ((record.adminOverrideAtMs || 0) > lastAppliedAdminOverrideMsRef.current) {
        applyCloudRecordToEcosystem(record, true);
      }
    });

    const handleVisibilityOrFocus = () => {
      const tankNow = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
      const uName = mypc.info()?.profile?.name || 'Keeper';
      const pId = mypc.info()?.profile?.id || 'local-caretaker';
      const visible =
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        screenStateRef.current === 'playing' &&
        !isForceOfflineOverrideActive();

      if (visible) {
        const latest = loadEcosystemState();
        latest.timeMultiplier = 1;
        ecosystemRef.current = latest;
        setEcosystem({ ...latest });
        const fCount = latest.autoFeederCountByTank[tankNow.id] || 0;
        publishActiveGameSessionLease(tankNow.id, true);
        syncUserBrainsToFirestore(uName, pId, latest.fishes, true, fCount);
        lastFirestoreSyncMsRef.current = performance.now();
      } else {
        saveEcosystemState(ecosystemRef.current);
        const fCount = ecosystemRef.current.autoFeederCountByTank[tankNow.id] || 0;
        publishActiveGameSessionLease(tankNow.id, false);
        syncUserBrainsToFirestore(uName, pId, ecosystemRef.current.fishes, false, fCount);
      }
    };

    const handlePageHide = () => {
      const tankNow = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
      const uName = mypc.info()?.profile?.name || 'Keeper';
      const pId = mypc.info()?.profile?.id || 'local-caretaker';
      const fCount = ecosystemRef.current.autoFeederCountByTank[tankNow.id] || 0;
      saveEcosystemState(ecosystemRef.current);
      publishActiveGameSessionLease(tankNow.id, false);
      syncUserBrainsToFirestore(uName, pId, ecosystemRef.current.fishes, false, fCount);
    };

    const handleStorageEvent = (ev: StorageEvent) => {
      if (!ev.key || ev.key.includes('ecosystem_v2') || ev.key.includes('abyssal_evo')) {
        syncLatestFromStorage();
      }
    };

    window.addEventListener('beforeunload', handlePageHide);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('storage', handleStorageEvent);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    // Local-only session lease refresh (zero Firestore writes inside this 2.5s timer!)
    const timer = window.setInterval(() => {
      const tankNow = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
      const activelyPlayingNow =
        screenStateRef.current === 'playing' &&
        (typeof document === 'undefined' || document.visibilityState === 'visible') &&
        !isForceOfflineOverrideActive();

      publishActiveGameSessionLease(tankNow.id, activelyPlayingNow);
    }, 2500);

    return () => {
      unsubAdminOverride();
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', handlePageHide);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('storage', handleStorageEvent);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      publishActiveGameSessionLease(currentTank.id, false);
    };
  }, [screenState, ecosystem.activeTankTier, mypc, applyCloudRecordToEcosystem]);

  // Sprinkle food across the TOP water surface (just like a real aquarium owner)
  // 100% non-blocking: no synchronous localStorage JSON.stringify or Firestore writes on food drop!
  const handleSprinkleFoodOnTop = useCallback(() => {
    const eco = ecosystemRef.current;
    const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const isFrameless = eco.graphicsSettings?.framelessTvMode !== false;
    const halfD = tank.depth * 0.34;

    for (let i = 0; i < 6; i++) {
      if (pelletsRef.current.length >= 60) break;
      const pelletZ = (Math.random() - 0.5) * halfD * 1.6;
      const sliceBounds = getTankBoundsAtZ(tank, pelletZ, isFrameless);
      pelletsRef.current.push({
        id: nextEntityId('pellet'),
        x: (Math.random() - 0.5) * sliceBounds.halfW * 1.4,
        y: sliceBounds.surfaceY + (Math.random() - 0.5) * 0.06,
        z: pelletZ,
        vy: -0.26 - Math.random() * 0.12,
        nutrition: 28,
        ageSeconds: 0,
        source: 'manual',
      });
    }
    const xpRes = awardOwnerXp(eco, 6);
    // Schedule background async localStorage save so dropping food never blocks the render frame
    saveEcosystemStateAsync(eco, 800);
    audioEngine.playPelletDrop();

    if (xpRes.leveledUp) {
      setEcosystem({ ...eco });
      showToast(
        `Sprinkled food on top! Owner Level Up → Level ${xpRes.newLevel} (New shop fishes unlocked!)`
      );
    } else if (settingsOpenRef.current) {
      setEcosystem({ ...eco });
    }
  }, [showToast]);

  // Refresh aquarium water quality & comfort
  const handleCleanAquariumWater = () => {
    const eco = ecosystemRef.current;
    eco.evolutionConfig.environment.waterQuality = 1.0;
    eco.evolutionConfig.environment.temperatureC = 25.0;
    for (const f of eco.fishes) {
      if (f.lineage.alive) {
        f.state.stress = Math.max(0, f.state.stress - 25);
        f.state.health = Math.min(100, f.state.health + 15);
      }
    }
    const xpRes = awardOwnerXp(eco, 12);
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    showToast(
      xpRes.leveledUp
        ? `Water filtered to 100%! Owner Level Up → Level ${xpRes.newLevel}!`
        : 'Water filtered & conditioned to 100% quality (25.0°C). Fish comfort restored (+12 Owner XP)!'
    );
  };

  // Buy a Fish from the Shop (Unlocked by Owner Level, up to Tank Capacity 3 / 4 / 5 / 6)
  const handleBuyFishFromShop = (species: SpeciesConfig) => {
    const eco = ecosystemRef.current;
    const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const aliveFishes = eco.fishes.filter((f) => f.lineage.alive);
    const ownerLevel = eco.ownerLevel || 1;
    const reqLevel = species.requiredOwnerLevel || 1;
    const price = species.shopPriceCredits || 45;

    if (ownerLevel < reqLevel) {
      showToast(
        `${species.name} requires Owner Level ${reqLevel} (you are Level ${ownerLevel}). Feed & care for your fishes to level up!`
      );
      return;
    }

    if (aliveFishes.length >= tank.maxFishCapacity) {
      showToast(
        `${tank.name} is at full capacity (${aliveFishes.length}/${tank.maxFishCapacity} fishes). Upgrade your aquarium tank for more space!`
      );
      return;
    }

    if (eco.bioCredits < price) {
      showToast(
        `Need ${price} Credits to buy ${species.name} (you have ${Math.round(
          eco.bioCredits
        )} Credits).`
      );
      return;
    }

    // Use promoted Base Model brain from Firestore / Registry if available
    const promotedModel = eco.modelRegistry.find(
      (m) => m.speciesId === species.id && m.isPromotedBase
    );
    let customBrain: FishBrainInstance | undefined;
    if (promotedModel && promotedModel.weights?.length) {
      const base = createBaseBrainInstance(promotedModel.brainConfig, Date.now() & 0xffff);
      base.inheritedWeights = promotedModel.weights.map((w) => [...w]);
      base.inheritedBiases = promotedModel.biases.map((b) => [...b]);
      customBrain = base;
    }

    const newFish = spawnFoundingFish(
      species,
      eco.activeTankTier,
      eco.simHoursTotal,
      aliveFishes.length,
      customBrain
    );
    eco.bioCredits -= price;
    eco.fishes.push(newFish);
    const xpRes = awardOwnerXp(eco, 25);

    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    audioEngine.playBirthChime();

    const username = mypc.info()?.profile?.name || 'Keeper';
    const profileId = mypc.info()?.profile?.id || 'local-caretaker';
    const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
    syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount);

    showToast(
      xpRes.leveledUp
        ? `Bought ${species.name} (${newFish.lineage.name})! Owner Level Up → Level ${xpRes.newLevel}!`
        : `Purchased ${species.name} (${newFish.lineage.name})! Tank space: ${
            aliveFishes.length + 1
          }/${tank.maxFishCapacity}.`
    );
  };

  // Buy or switch to a bigger Aquarium Tank Tier (Strictly for Space: 3 -> 4 -> 5 -> 6)
  const handleBuyOrSelectTank = (tierIndex: number) => {
    const tier = TANK_TIERS[tierIndex];
    if (!tier) return;
    const eco = ecosystemRef.current;
    const isUnlocked = eco.unlockedTankTiers.includes(tierIndex);

    if (!isUnlocked) {
      if (eco.bioCredits < tier.costCredits) {
        showToast(
          `Need ${tier.costCredits} Credits to buy ${tier.name} (you have ${Math.round(
            eco.bioCredits
          )}). Keep feeding your fishes to earn credits!`
        );
        return;
      }
      eco.bioCredits -= tier.costCredits;
      eco.unlockedTankTiers.push(tierIndex);
      awardOwnerXp(eco, 40);
    }

    eco.activeTankTier = tierIndex;
    for (const f of eco.fishes) {
      if (f.lineage.alive) {
        f.lineage.tankId = tier.id;
      }
    }
    if (!eco.autoFeederCountByTank[tier.id]) {
      eco.autoFeederCountByTank[tier.id] = 1;
    }

    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    audioEngine.playTankUpgrade();
    showToast(
      isUnlocked
        ? `Moved your fishes into ${tier.name} (Space Capacity: ${tier.maxFishCapacity} fishes + babies).`
        : `Purchased ${tier.name}! Space expanded to ${tier.maxFishCapacity} fishes (+ babies over max).`
    );
  };

  // Buy an additional Auto-Feeder for the current tank
  const handleBuyAutoFeeder = () => {
    const eco = ecosystemRef.current;
    const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const currentCount = eco.autoFeederCountByTank[tank.id] || 0;
    const cost = 75;

    if (currentCount >= tank.maxAutoFeeders) {
      showToast(`Maximum Auto-Feeders (${tank.maxAutoFeeders}) installed on ${tank.name}.`);
      return;
    }
    if (eco.bioCredits < cost) {
      showToast(`Need ${cost} Credits to install a top-mounted Auto-Feeder.`);
      return;
    }

    eco.bioCredits -= cost;
    eco.autoFeederCountByTank[tank.id] = currentCount + 1;
    awardOwnerXp(eco, 20);
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    audioEngine.playTankUpgrade();

    const username = mypc.info()?.profile?.name || 'Keeper';
    const profileId = mypc.info()?.profile?.id || 'local-caretaker';
    syncUserBrainsToFirestore(username, profileId, eco.fishes, true, currentCount + 1);

    showToast(
      `Installed Top Auto-Feeder #${currentCount + 1} (${
        currentCount + 1
      }/${tank.maxAutoFeeders}). Also feeds your fishes in the 24/7 Offline Keeper!`
    );
  };

  // Restock 2 starter fishes ONLY if the owner's tank has fewer than 2 live fishes
  const handleRestockStarterPair = () => {
    const eco = ecosystemRef.current;
    const alive = eco.fishes.filter((f) => f.lineage.alive);
    if (alive.length >= 2) {
      showToast('You already have live fishes! Feed them so they breed naturally via AI.');
      return;
    }
    const sp = eco.speciesList[0] || DEFAULT_SPECIES_LIST[0];
    const needed = 2 - alive.length;
    for (let i = 0; i < needed; i++) {
      eco.fishes.push(spawnFoundingFish(sp, eco.activeTankTier, eco.simHoursTotal, i));
    }
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const username = mypc.info()?.profile?.name || 'Keeper';
    const profileId = mypc.info()?.profile?.id || 'local-caretaker';
    syncUserBrainsToFirestore(
      username,
      profileId,
      eco.fishes,
      true,
      eco.autoFeederCountByTank[tank.id] || 0
    );
    showToast('Added a new pair of starter fishes to your aquarium.');
  };

  // Remove a single dead fish body from the aquarium
  const handleRemoveDeadFish = (fishId: string) => {
    const eco = ecosystemRef.current;
    const target = eco.fishes.find((f) => f.lineage.fishId === fishId);
    if (target && !target.lineage.alive) {
      if (!eco.deceasedArchive.some((d) => d.fishId === target.lineage.fishId)) {
        eco.deceasedArchive.unshift({ ...target.lineage });
      }
      eco.fishes = eco.fishes.filter((f) => f.lineage.fishId !== fishId);
      saveEcosystemState(eco);
      setEcosystem({ ...eco });
      const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
      const username = mypc.info()?.profile?.name || 'Keeper';
      const profileId = mypc.info()?.profile?.id || 'local-caretaker';
      syncUserBrainsToFirestore(
        username,
        profileId,
        eco.fishes,
        true,
        eco.autoFeederCountByTank[tank.id] || 0
      );
      showToast(`Removed deceased fish (${target.lineage.name}) from your tank.`);
    }
  };

  // Clear all dead fish bodies from the aquarium
  const handleClearAllDeadFishes = () => {
    const eco = ecosystemRef.current;
    const deadList = eco.fishes.filter((f) => !f.lineage.alive);
    if (deadList.length === 0) return;
    for (const df of deadList) {
      if (!eco.deceasedArchive.some((d) => d.fishId === df.lineage.fishId)) {
        eco.deceasedArchive.unshift({ ...df.lineage });
      }
    }
    eco.fishes = eco.fishes.filter((f) => f.lineage.alive);
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const username = mypc.info()?.profile?.name || 'Keeper';
    const profileId = mypc.info()?.profile?.id || 'local-caretaker';
    syncUserBrainsToFirestore(
      username,
      profileId,
      eco.fishes,
      true,
      eco.autoFeederCountByTank[tank.id] || 0
    );
    showToast(`Cleared ${deadList.length} deceased fish(es) from your aquarium.`);
  };

  // Update 3D Fish Polygon Quality or Graphics settings
  const handleUpdatePolygonQuality = (polyQuality: FishPolygonQuality) => {
    const eco = ecosystemRef.current;
    const prev = eco.graphicsSettings || {
      fishPolygonQuality: 'high',
      environmentQuality: 'high',
      showCaustics: true,
      showParticles: true,
      antiAliasing: true,
      framelessTvMode: true,
      showFps: false,
    };
    eco.graphicsSettings = {
      ...prev,
      fishPolygonQuality: polyQuality,
      ...(polyQuality === 'very_low'
        ? {
            environmentQuality: 'very_low',
            showCaustics: false,
            showParticles: false,
            antiAliasing: false,
          }
        : {}),
    };
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    const spec = getPolygonSpecForQuality(polyQuality);
    showToast(
      polyQuality === 'very_low'
        ? `Very Low Quality Activated (${spec.label}, Unlit Fast Shaders)`
        : `3D Fish Mesh Quality set to ${spec.label}`
    );
  };

  // Toggle Show FPS on Top Right
  const handleToggleShowFps = useCallback(() => {
    const eco = ecosystemRef.current;
    const currentlyShown = eco.graphicsSettings?.showFps === true;
    const nextShown = !currentlyShown;
    eco.graphicsSettings = {
      ...(eco.graphicsSettings || {
        fishPolygonQuality: 'high',
        environmentQuality: 'high',
        showCaustics: true,
        showParticles: true,
        antiAliasing: true,
        framelessTvMode: true,
        lightIntensity: 0.95,
        backgroundBrightness: 0.22,
      }),
      showFps: nextShown,
    };
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    showToast(
      nextShown
        ? 'FPS Counter enabled on Top Right.'
        : 'FPS Counter hidden.'
    );
  }, [showToast]);

  // Toggle Full-Screen TV Mode (Frameless Aquarium vs Framed Tank)
  const handleToggleFramelessTvMode = useCallback(() => {
    const eco = ecosystemRef.current;
    const currentlyFrameless = eco.graphicsSettings?.framelessTvMode !== false;
    const nextFrameless = !currentlyFrameless;
    eco.graphicsSettings = {
      ...(eco.graphicsSettings || {
        fishPolygonQuality: 'high',
        environmentQuality: 'high',
        showCaustics: true,
        showParticles: true,
        antiAliasing: true,
        lightIntensity: 0.95,
        backgroundBrightness: 0.22,
      }),
      framelessTvMode: nextFrameless,
    };
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    showToast(
      nextFrameless
        ? 'Full-Screen TV Aquarium Mode ON (No Tank Frames — Arrows control top buttons).'
        : 'Framed Aquarium Tank Mode ON (Tank frames visible).'
    );
  }, [showToast]);

  // Update Aquarium Overhead Light Intensity, Back-of-Tank Blue Brightness & Daylight / Bulb Mode
  const handleUpdateLightingSettings = useCallback(
    (
      patch: {
        lightIntensity?: number;
        backgroundBrightness?: number;
        daylightMode?: boolean;
        timeOfDayOverride?: 'auto' | 'day' | 'night';
      },
      labelMsg?: string
    ) => {
      const eco = ecosystemRef.current;
      const cur = eco.graphicsSettings || {
        fishPolygonQuality: 'high',
        environmentQuality: 'high',
        showCaustics: true,
        showParticles: true,
        antiAliasing: true,
        framelessTvMode: true,
        showFps: false,
        lightIntensity: 0.95,
        backgroundBrightness: 0.22,
        daylightMode: true,
        timeOfDayOverride: 'auto',
      };
      const nextLight =
        patch.lightIntensity !== undefined
          ? Math.max(0.15, Math.min(1.8, Number(patch.lightIntensity.toFixed(2))))
          : cur.lightIntensity ?? 0.95;
      const nextBg =
        patch.backgroundBrightness !== undefined
          ? Math.max(0.0, Math.min(1.0, Number(patch.backgroundBrightness.toFixed(2))))
          : cur.backgroundBrightness ?? 0.22;
      const nextDaylight =
        patch.daylightMode !== undefined ? patch.daylightMode : cur.daylightMode !== false;
      const nextTimeOverride =
        patch.timeOfDayOverride !== undefined
          ? patch.timeOfDayOverride
          : cur.timeOfDayOverride || 'auto';

      eco.graphicsSettings = {
        ...cur,
        lightIntensity: nextLight,
        backgroundBrightness: nextBg,
        daylightMode: nextDaylight,
        timeOfDayOverride: nextTimeOverride,
      };
      saveEcosystemStateAsync(eco, 300);
      setEcosystem({ ...eco });
      if (labelMsg) {
        showToast(labelMsg);
      }
    },
    [showToast]
  );

  // Toggle Daylight Mode (ON = Solar Daylight by day & Bulb Lights at night; OFF = Always Bulb Lights)
  const handleToggleDaylightMode = useCallback(() => {
    const eco = ecosystemRef.current;
    const currentlyOn = eco.graphicsSettings?.daylightMode !== false;
    const nextOn = !currentlyOn;
    handleUpdateLightingSettings(
      { daylightMode: nextOn },
      nextOn
        ? 'Daylight Mode: ON (Natural Daylight by day, automatic Bulb Lights at night).'
        : 'Daylight Mode: OFF (Using overhead Aquarium Bulb Lights continuously).'
    );
  }, [handleUpdateLightingSettings]);

  const handleStartAquarium = useCallback(() => {
    audioEngine.initOrResume();
    // Clear any trainer force-offline simulation override and reload latest state from 24/7 Keeper
    setForceOfflineOverride(false);
    const latest = loadEcosystemState();
    latest.timeMultiplier = 1;
    ecosystemRef.current = latest;
    setEcosystem({ ...latest });
    setScreenState('playing');

    const deadNow = latest.fishes.filter((f) => !f.lineage.alive);
    if (deadNow.length > 0) {
      showToast(
        `Warning: ${deadNow.map((d) => d.lineage.name).join(', ')} died from ${
          deadNow[0].lineage.causeOfDeath || 'starvation'
        } while away!`
      );
    }
  }, [showToast]);

  const toggleOwnerMenuFromController = useCallback(
    (label: string) => {
      if (!canTriggerControllerAction('menu', 420)) return;
      setLastControllerInputLabel(label);
      if (screenStateRef.current === 'title') {
        handleStartAquarium();
        setSettingsOpen(true);
      } else {
        if (screenStateRef.current === 'paused') {
          ecosystemRef.current.paused = false;
          setScreenState('playing');
        }
        setSettingsOpen((prev) => !prev);
      }
    },
    [canTriggerControllerAction, handleStartAquarium]
  );

  const cancelModalFromController = useCallback((): boolean => {
    if (!canTriggerControllerAction('cancel', 320)) return true;
    if (helpModalRef.current) {
      setHelpModalTopic(null);
      return true;
    }
    if (settingsOpenRef.current) {
      setSettingsOpen(false);
      return true;
    }
    return false;
  }, [canTriggerControllerAction]);

  // ============================================================================
  // TV REMOTE & KEYBOARD CONTROLLER LISTENER ("Play/Pause", "+", "Select", "Start")
  // ============================================================================
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key || '';
      const code = e.code || '';
      const keyCode = e.keyCode || 0;

      // 1. TV Remote "Play/Pause" (Tizen 10252 / 415 / 19 / 179 / MediaPlayPause)
      // or Gamepad/Keyboard "+", "Select", "Start", "Menu"
      const isTvPlayPause =
        key === 'MediaPlayPause' ||
        key === 'PlayPause' ||
        key === 'MediaPlay' ||
        key === 'MediaPause' ||
        code === 'MediaPlayPause' ||
        keyCode === 10252 ||
        keyCode === 415 ||
        keyCode === 19 ||
        keyCode === 179;

      const isPlusSelectStartMenu =
        key === '+' ||
        key === '=' ||
        key === 'Select' ||
        key === 'ContextMenu' ||
        key === 'F1' ||
        key.toLowerCase() === 'm' ||
        code === 'ContextMenu';

      if (isTvPlayPause || isPlusSelectStartMenu) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        toggleOwnerMenuFromController(
          isTvPlayPause
            ? 'TV Remote [Play/Pause] pressed → Toggled Owner Menu'
            : 'Controller [+ / Select / Start] pressed → Toggled Owner Menu'
        );
        return;
      }

      // 2. Back / Cancel / Escape / Tizen Return (10009)
      if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || keyCode === 10009) {
        if (helpModalRef.current || settingsOpenRef.current) {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          cancelModalFromController();
          return;
        }
      }

      // 3. Spatial D-Pad / Arrow navigation across top bar buttons (in playing mode) or modal buttons
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        moveControllerFocus(1);
        setLastControllerInputLabel('Arrow [Right/Down] → Focused Next Button');
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        moveControllerFocus(-1);
        setLastControllerInputLabel('Arrow [Left/Up] → Focused Previous Button');
        return;
      }
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (!activateFocusedControllerButton() && screenStateRef.current === 'playing') {
          handleSprinkleFoodOnTop();
        }
        return;
      }
      if (helpModalRef.current || settingsOpenRef.current) {
        if (key === '[' || key === 'PageUp') {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          cycleSettingsTab(-1);
          return;
        }
        if (key === ']' || key === 'PageDown') {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          cycleSettingsTab(1);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [
    activateFocusedControllerButton,
    cancelModalFromController,
    cycleSettingsTab,
    handleSprinkleFoodOnTop,
    moveControllerFocus,
    toggleOwnerMenuFromController,
  ]);

  // Initialize MyPC SDK Lifecycle, Gamepad Listeners & Firestore Brain Sync
  useEffect(() => {
    mypc.init({
      ownMenu: true,
      onInit: (info) => {
        setMypcInfo(info);
        audioEngine.setVolumes(info.volume?.music ?? 0.7, info.volume?.sfx ?? 0.8);

        // Lock player game clock to 1x real-time
        ecosystemRef.current.timeMultiplier = 1;

        // 1. Load latest promoted Base Models & edited species properties from Firestore `base_models`
        fetchBaseModelsFromFirestore().then((cloudModels) => {
          if (cloudModels.length > 0) {
            const eco = ecosystemRef.current;
            eco.modelRegistry = cloudModels;
            for (const cm of cloudModels) {
              // Merge any new or edited species properties saved in the Trainer
              if (cm.speciesConfig) {
                const existingIdx = eco.speciesList.findIndex(
                  (s) => s.id === cm.speciesConfig!.id
                );
                if (existingIdx >= 0) {
                  eco.speciesList[existingIdx] = {
                    ...eco.speciesList[existingIdx],
                    ...cm.speciesConfig,
                    lifespan: {
                      ...eco.speciesList[existingIdx].lifespan,
                      ...cm.speciesConfig.lifespan,
                    },
                  };
                } else {
                  eco.speciesList.push(cm.speciesConfig);
                }
              }
              if (cm.isPromotedBase) {
                const sp = eco.speciesList.find((s) => s.id === cm.speciesId);
                if (sp) {
                  sp.activeBaseModelVersion = cm.versionId;
                }
              }
            }
            saveEcosystemState(eco);
            setEcosystem({ ...eco });
          }
        });

        // 2. Load owner's individual fish brains from Firestore (`mypc_user_brains`)
        const username = info.profile?.name || 'Keeper';
        loadUserBrainsFromFirestore(username).then((cloudRecord) => {
          if (
            cloudRecord &&
            Array.isArray(cloudRecord.fishBrains) &&
            cloudRecord.fishBrains.length > 0
          ) {
            const eco = ecosystemRef.current;
            const hasNewerAdminOverride =
              (cloudRecord.adminOverrideAtMs || 0) > (eco.adminOverrideAtMs || 0) ||
              (cloudRecord.adminOverrideAtMs || 0) > (eco.lastSavedAtMs || 0);
            if (hasNewerAdminOverride || (cloudRecord.updatedAtMs || 0) > (eco.lastSavedAtMs || 0)) {
              applyCloudRecordToEcosystem(cloudRecord, hasNewerAdminOverride);
            }
          }
        });

        mypc.setMenu([
          { id: 'feed', label: 'Sprinkle Food on Top' },
          { id: 'settings', label: 'Owner Menu, Shop & Fish Stats' },
          { id: 'restart', label: 'Reset Aquarium (2 Starter Fishes)' },
        ]);

        mypc.ready();
      },
      onStart: () => {},
      onPause: () => {
        // Deduplicated with keydown / onInput so pressing TV Remote Play/Pause once never double-toggles
        toggleOwnerMenuFromController('TV Remote [Pause] → Toggled Owner Menu');
      },
      onResume: () => {
        ecosystemRef.current.paused = false;
        audioEngine.resume();
        if (screenStateRef.current === 'paused') {
          setScreenState('playing');
        }
      },
      onDestroy: () => {
        const tank = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
        const username = mypc.info()?.profile?.name || 'Keeper';
        const profileId = mypc.info()?.profile?.id || 'local-caretaker';
        const feederCount = ecosystemRef.current.autoFeederCountByTank[tank.id] || 0;
        publishActiveGameSessionLease(tank.id, false);
        setUserOnlineStatusInFirestore(username, profileId, false, feederCount);
        saveEcosystemState(ecosystemRef.current);
        audioEngine.destroy();
      },
      onVolume: (v) => {
        audioEngine.setVolumes(v.music, v.sfx);
      },
      onMenu: (id) => {
        if (id === 'feed') {
          handleSprinkleFoodOnTop();
        } else if (id === 'settings') {
          setSettingsOpen(true);
        } else if (id === 'restart') {
          const fresh = createInitialEcosystemState();
          saveEcosystemState(fresh);
          ecosystemRef.current = fresh;
          setEcosystem(fresh);
          setScreenState('playing');
          showToast('Aquarium reset with 2 starter fishes.');
        }
      },
      onInput: (action, pressed, repeat) => {
        if (!pressed) return;

        // Open/Toggle menu on TV Remote "Play/Pause" (`pause` / `play_pause` / `menu`)
        // or Gamepad `+` / `Select` / `Start` (`select` / `start` / `menu` / `run`)
        if (
          !repeat &&
          (action === 'menu' ||
            action === 'pause' ||
            action === 'play_pause' ||
            action === 'select' ||
            action === 'start' ||
            action === 'run')
        ) {
          toggleOwnerMenuFromController(
            `Controller [${action.toUpperCase()}] → Toggled Owner Menu`
          );
          return;
        }

        // Route D-Pad / Arrows & Confirm/Cancel to focusable buttons (top HUD buttons in playing mode, or modal/title buttons)
        if (action === 'down' || action === 'right') {
          moveControllerFocus(1);
          setLastControllerInputLabel(`Controller [${action.toUpperCase()}] → Focused Next Button`);
          return;
        }
        if (action === 'up' || action === 'left') {
          moveControllerFocus(-1);
          setLastControllerInputLabel(`Controller [${action.toUpperCase()}] → Focused Prev Button`);
          return;
        }
        if (!repeat && (action === 'confirm' || action === 'jump')) {
          if (!activateFocusedControllerButton()) {
            if (screenStateRef.current === 'title') handleStartAquarium();
            else if (screenStateRef.current === 'playing') handleSprinkleFoodOnTop();
          }
          return;
        }
        if (!repeat && action === 'cancel') {
          cancelModalFromController();
          return;
        }
      },
    });

    if (mypc.gamepad) {
      mypc.gamepad.on(
        'button',
        (index: number, pressed: boolean, _value: number, _dev: string, name: string) => {
          if (!pressed) return;
          const btnName = (name || '').toLowerCase();

          // Open/Toggle menu on "+", "Select", "Start", or indices 8 / 9
          if (
            btnName === 'start' ||
            btnName === 'select' ||
            btnName === '+' ||
            btnName === '-' ||
            btnName === 'menu' ||
            index === 8 ||
            index === 9 ||
            btnName === 'y' ||
            btnName === 'x'
          ) {
            toggleOwnerMenuFromController(
              `Gamepad [${name || `Btn ${index}`}] → Toggled Owner Menu`
            );
            return;
          }

          if (helpModalRef.current || settingsOpenRef.current) {
            if (btnName === 'lb' || index === 4) {
              cycleSettingsTab(-1);
            } else if (btnName === 'rb' || index === 5) {
              cycleSettingsTab(1);
            } else if (btnName === 'a' || index === 0) {
              activateFocusedControllerButton();
            } else if (btnName === 'b' || index === 1) {
              cancelModalFromController();
            } else if (index === 12 || index === 14) {
              moveControllerFocus(-1);
            } else if (index === 13 || index === 15) {
              moveControllerFocus(1);
            }
            return;
          }

          if (screenStateRef.current === 'title') {
            if (btnName === 'a' || index === 0) {
              if (!activateFocusedControllerButton()) handleStartAquarium();
            } else if (index === 12 || index === 14) {
              moveControllerFocus(-1);
            } else if (index === 13 || index === 15) {
              moveControllerFocus(1);
            }
            return;
          }

          if (screenStateRef.current === 'playing') {
            if (btnName === 'a' || index === 0) {
              if (!activateFocusedControllerButton()) handleSprinkleFoodOnTop();
            } else if (btnName === 'b' || index === 1) {
              cancelModalFromController();
            } else if (index === 12 || index === 14) {
              moveControllerFocus(-1);
            } else if (index === 13 || index === 15) {
              moveControllerFocus(1);
            }
          }
        }
      );
    }
  }, [
    activateFocusedControllerButton,
    applyCloudRecordToEcosystem,
    cancelModalFromController,
    cycleSettingsTab,
    handleSprinkleFoodOnTop,
    handleStartAquarium,
    moveControllerFocus,
    mypc,
    showToast,
    toggleOwnerMenuFromController,
  ]);

  // 60Hz Simulation & Native HTML5 Gamepad Polling Callback
  const handleTickSimulation = useCallback(
    (dt: number) => {
      // Poll standard HTML5 navigator.getGamepads() for guaranteed controller & TV remote gamepad support
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
        const pads = navigator.getGamepads();
        const pad = pads && (pads[0] || pads[1] || pads[2] || pads[3]);
        if (pad && pad.buttons) {
          const prev = prevGamepadButtonsRef.current;
          for (let b = 0; b < pad.buttons.length; b++) {
            const isDown = Boolean(pad.buttons[b]?.pressed);
            const wasDown = Boolean(prev[b]);
            if (isDown && !wasDown) {
              // Rising edge button press (deduplicated via canTriggerControllerAction)
              if (b === 8 || b === 9) {
                toggleOwnerMenuFromController(
                  b === 9
                    ? 'Gamepad [Start / +] → Toggled Owner Menu'
                    : 'Gamepad [Select / -] → Toggled Owner Menu'
                );
              } else if (helpModalRef.current || settingsOpenRef.current) {
                if (b === 0) activateFocusedControllerButton();
                else if (b === 1) cancelModalFromController();
                else if (b === 4) cycleSettingsTab(-1);
                else if (b === 5) cycleSettingsTab(1);
                else if (b === 12 || b === 14) moveControllerFocus(-1);
                else if (b === 13 || b === 15) moveControllerFocus(1);
              } else if (screenStateRef.current === 'title') {
                if (b === 0) {
                  if (!activateFocusedControllerButton()) handleStartAquarium();
                } else if (b === 12 || b === 14) moveControllerFocus(-1);
                else if (b === 13 || b === 15) moveControllerFocus(1);
              } else if (screenStateRef.current === 'playing') {
                if (b === 0) {
                  if (!activateFocusedControllerButton()) handleSprinkleFoodOnTop();
                } else if (b === 12 || b === 14) moveControllerFocus(-1);
                else if (b === 13 || b === 15) moveControllerFocus(1);
                else if (b === 2 || b === 3) {
                  toggleOwnerMenuFromController('Gamepad [X / Y] → Toggled Owner Menu');
                }
              }
            }
            prev[b] = isDown;
          }

          // Left stick focus navigation across top bar buttons or open modal buttons with cooldown
          const nowMs = performance.now();
          const lx = pad.axes?.[0] || 0;
          const ly = pad.axes?.[1] || 0;
          if (nowMs - lastDpadAxisMoveMsRef.current > 240) {
            if (ly > 0.55 || lx > 0.55) {
              lastDpadAxisMoveMsRef.current = nowMs;
              moveControllerFocus(1);
            } else if (ly < -0.55 || lx < -0.55) {
              lastDpadAxisMoveMsRef.current = nowMs;
              moveControllerFocus(-1);
            }
          }
        }
      }

      // Strict Single-Place Rule: Only run fish simulation in the Owner Game when playing, visible, and not forced offline in Keeper
      if (
        screenStateRef.current !== 'playing' ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
        isForceOfflineOverrideActive()
      ) {
        return;
      }

      const eco = ecosystemRef.current;
      // Lock player time multiplier to 1x real-time
      eco.timeMultiplier = 1;
      const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];

      // Gentle camera look/zoom via gamepad sticks when menu is closed
      if (!settingsOpenRef.current && mypc.gamepad) {
        const rx = mypc.gamepad.axis(2) || mypc.gamepad.axis(0);
        const ry = mypc.gamepad.axis(3) || mypc.gamepad.axis(1);
        const lt = mypc.gamepad.value(6);
        const rt = mypc.gamepad.value(7);

        if (Math.abs(rx) > 0.18) {
          cameraOrbitRef.current.yaw = Math.max(
            -0.9,
            Math.min(0.9, cameraOrbitRef.current.yaw + rx * 1.2 * dt)
          );
        }
        if (Math.abs(ry) > 0.18) {
          cameraOrbitRef.current.pitch = Math.max(
            -0.25,
            Math.min(0.45, cameraOrbitRef.current.pitch + ry * 0.8 * dt)
          );
        }
        if (lt > 0.1 || rt > 0.1) {
          cameraOrbitRef.current.zoom = Math.max(
            0.65,
            Math.min(1.5, cameraOrbitRef.current.zoom + (lt - rt) * 0.7 * dt)
          );
        }
      }

      // Advance Real-Life 1x Aquarium AI Simulation
      stepEcosystemSimulation(eco, pelletsRef.current, threatsRef.current, dt, {
        allowAutoFeeders: true,
        onPelletEaten: () => {
          audioEngine.playPelletEat();
        },
        onBirth: (child, mother) => {
          audioEngine.playBirthChime();
          const maxGen = Math.max(...eco.fishes.map((f) => f.lineage.generation));
          mypc.submitScore(maxGen * 100 + eco.bioCredits);
          saveEcosystemStateAsync(eco, 400);
          setEcosystem({ ...eco });
          const username = mypc.info()?.profile?.name || 'Keeper';
          const profileId = mypc.info()?.profile?.id || 'local-caretaker';
          const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
          syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount);
          showToast(
            `${mother.lineage.name} naturally hatched baby ${child.lineage.name} (Gen ${child.lineage.generation})!`
          );
        },
        onDeath: (fish, reason) => {
          saveEcosystemStateAsync(eco, 400);
          setEcosystem({ ...eco });
          const username = mypc.info()?.profile?.name || 'Keeper';
          const profileId = mypc.info()?.profile?.id || 'local-caretaker';
          const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
          syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount);
          showToast(`${fish.lineage.name} passed away from ${reason}.`);
        },
      });

      const nowMs = performance.now();
      const hudSyncInterval = settingsOpenRef.current ? 1500 : 3500;
      if (nowMs - lastHudSyncMsRef.current > hudSyncInterval) {
        lastHudSyncMsRef.current = nowMs;
        setEcosystem({ ...eco });
      }

      if (nowMs - lastLocalSaveMsRef.current > 25000) {
        lastLocalSaveMsRef.current = nowMs;
        saveEcosystemStateAsync(eco, 900);
      }

      if (nowMs - lastFirestoreSyncMsRef.current > FIRESTORE_CHECKPOINT_INTERVAL_MS) {
        lastFirestoreSyncMsRef.current = nowMs;
        const username = mypc.info()?.profile?.name || 'Keeper';
        const profileId = mypc.info()?.profile?.id || 'local-caretaker';
        const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
        syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount);
      }
    },
    [
      activateFocusedControllerButton,
      applyCloudRecordToEcosystem,
      cancelModalFromController,
      cycleSettingsTab,
      handleSprinkleFoodOnTop,
      handleStartAquarium,
      moveControllerFocus,
      mypc,
      showToast,
      toggleOwnerMenuFromController,
    ]
  );

  const handleFpsUpdate = useCallback((nextFps: number) => {
    if (!ecosystemRef.current.graphicsSettings?.showFps && !settingsOpenRef.current) {
      return;
    }
    setFps((prev) => (prev === nextFps ? prev : nextFps));
  }, []);

  const lang = mypcInfo.lang || 'en';
  const t = I18N[lang] || I18N.en;
  const currentTank = TANK_TIERS[ecosystem.activeTankTier] || TANK_TIERS[0];
  const aliveFishes = ecosystem.fishes.filter((f) => f.lineage.alive);
  const deadFishes = ecosystem.fishes.filter((f) => !f.lineage.alive);
  const adultFishes = aliveFishes.filter(
    (f) => f.state.lifeStage === 'adult' || f.state.lifeStage === 'elder'
  );
  const babyFishes = aliveFishes.filter(
    (f) => f.state.lifeStage === 'egg' || f.state.lifeStage === 'juvenile'
  );
  const highestGeneration = ecosystem.fishes.reduce(
    (m, f) => Math.max(m, f.lineage.generation),
    1
  );
  const ownerLevel = ecosystem.ownerLevel || 1;
  const ownerXp = Math.round(ecosystem.ownerXp || 0);
  const currentPolyQuality: FishPolygonQuality =
    ecosystem.graphicsSettings?.fishPolygonQuality || 'high';
  const currentEnvQuality: EnvironmentQualityTier =
    ecosystem.graphicsSettings?.environmentQuality || mypcInfo.quality?.tier || 'high';
  const isFramelessTvMode = ecosystem.graphicsSettings?.framelessTvMode !== false;
  const isShowFpsEnabled = ecosystem.graphicsSettings?.showFps === true;
  const currentLightIntensity = ecosystem.graphicsSettings?.lightIntensity ?? 0.95;
  const currentBgBrightness = ecosystem.graphicsSettings?.backgroundBrightness ?? 0.22;
  const isDaylightModeOn = ecosystem.graphicsSettings?.daylightMode !== false;
  const currentTimeOverride = ecosystem.graphicsSettings?.timeOfDayOverride || 'auto';

  const clockHourFloat = nowClock.getHours() + nowClock.getMinutes() / 60;
  const isDaytimeForFish =
    currentTimeOverride === 'day'
      ? true
      : currentTimeOverride === 'night'
      ? false
      : clockHourFloat >= 6.0 && clockHourFloat < 18.5;
  const isUsingSolarDaylight = isDaylightModeOn && isDaytimeForFish;

  const formattedFishDate = nowClock.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const formattedFishTime = nowClock.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const fishSimDay = Math.floor((ecosystem.simHoursTotal || 0) / 24) + 1;

  const sortedShopSpecies = [...ecosystem.speciesList].sort(
    (a, b) => (a.requiredOwnerLevel || 1) - (b.requiredOwnerLevel || 1)
  );

  return (
    <div
      dir={mypcInfo.rtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 w-full h-full overflow-hidden select-none"
    >
      {/* Unified Full-Viewport 3D Aquarium & Screensaver View (100vw x 100vh) */}
      <AquariumCanvas3D
        ecosystemRef={ecosystemRef}
        pelletsRef={pelletsRef}
        threatsRef={threatsRef}
        cursorPosRef={cursorPosRef}
        cameraOrbitRef={cameraOrbitRef}
        selectedFishId={null}
        screensaverMode={true}
        qualityTier={currentEnvQuality}
        fishPolygonQuality={currentPolyQuality}
        framelessTvMode={isFramelessTvMode}
        activeTankTier={ecosystem.activeTankTier}
        isPaused={screenState === 'paused' || ecosystem.paused}
        onTickSimulation={handleTickSimulation}
        onPolygonStatsUpdate={setPolyStats}
        onFpsUpdate={handleFpsUpdate}
      />

      {/* Top-Right FPS Overlay when enabled from Settings (visible even when modals or title screen are open) */}
      {isShowFpsEnabled && screenState !== 'playing' && (
        <div
          data-testid="fps-counter-overlay"
          className="fixed top-4 right-5 z-50 pointer-events-none px-3 py-1.5 rounded-lg bg-[#06101e]/90 border border-emerald-400/60 text-xs font-mono font-bold tabular-nums shadow-lg flex items-center gap-2"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              fps >= 45 ? 'bg-emerald-400' : fps >= 25 ? 'bg-amber-400' : 'bg-rose-400'
            }`}
          />
          <span
            className={
              fps >= 45 ? 'text-emerald-300' : fps >= 25 ? 'text-amber-300' : 'text-rose-300'
            }
          >
            {fps} FPS
          </span>
        </div>
      )}

      {/* STATE 1: TITLE SCREEN OVERLAY */}
      {screenState === 'title' && (
        <div
          data-modal-scope="title"
          className="fixed inset-0 z-20 flex flex-col justify-between p-8 sm:p-12 pointer-events-none bg-gradient-to-r from-[#030914]/90 via-[#030914]/50 to-transparent"
        >
          <div className="max-w-xl pointer-events-auto space-y-6 my-auto">
            <svg
              viewBox="0 0 520 110"
              className="w-full max-w-md h-auto overflow-visible"
              role="img"
              aria-label="Abyssal Evo Title Emblem"
            >
              <defs>
                <linearGradient id="crestGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#22d3ee" />
                  <stop offset="60%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#f59e0b" />
                </linearGradient>
              </defs>
              <g transform="translate(8, 12)">
                <path
                  d="M12 42 C32 10, 74 10, 96 42 C74 74, 32 74, 12 42 Z"
                  fill="none"
                  stroke="url(#crestGrad)"
                  strokeWidth="3.5"
                />
                <polygon points="14,42 0,24 4,42 0,60" fill="#f59e0b" />
                <circle cx="42" cy="42" r="4" fill="#22d3ee" />
                <circle cx="62" cy="30" r="3.5" fill="#38bdf8" />
                <circle cx="62" cy="54" r="3.5" fill="#38bdf8" />
                <circle cx="80" cy="42" r="4" fill="#f59e0b" />
                <line x1="42" y1="42" x2="62" y2="30" stroke="#38bdf8" strokeWidth="1.5" />
                <line x1="42" y1="42" x2="62" y2="54" stroke="#38bdf8" strokeWidth="1.5" />
                <line x1="62" y1="30" x2="80" y2="42" stroke="#f59e0b" strokeWidth="1.5" />
                <line x1="62" y1="54" x2="80" y2="42" stroke="#f59e0b" strokeWidth="1.5" />
              </g>
              <text
                x="118"
                y="56"
                fill="#ffffff"
                fontFamily="Plus Jakarta Sans, sans-serif"
                fontSize="44"
                fontWeight="800"
                letterSpacing="2"
              >
                ABYSSAL EVO
              </text>
              <text
                x="120"
                y="82"
                fill="#38bdf8"
                fontFamily="JetBrains Mono, monospace"
                fontSize="13"
                fontWeight="600"
                letterSpacing="3"
              >
                LIVING 3D AI AQUARIUM · NATURAL EVOLUTION
              </text>
            </svg>

            <p className="text-sm sm:text-base text-slate-200 leading-relaxed max-w-md">
              Start with 2 living 3D fishes powered by individual neural brains. Sprinkle food on
              the top water surface, level up as an Owner to unlock famous species in the shop, and
              upgrade your tank from 3 up to 6 fishes (+ babies).
            </p>

            <div className="flex flex-wrap items-center gap-3.5 pt-2">
              <button
                type="button"
                data-start="true"
                data-tv-focusable="true"
                onClick={handleStartAquarium}
                className="px-7 py-3.5 text-sm font-bold bg-cyan-400 text-slate-950 rounded-lg hover:bg-cyan-300 focus:ring-4 focus:ring-white focus:outline-none transition-transform active:scale-95 whitespace-nowrap"
              >
                {t.enterAquarium}
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  handleStartAquarium();
                  setSettingsTab('aquarium_shop');
                  setSettingsOpen(true);
                }}
                className="px-5 py-3.5 text-sm font-semibold bg-[#0c192c]/90 text-amber-300 border border-amber-500/40 rounded-lg hover:bg-[#132642] focus:ring-4 focus:ring-amber-300 focus:outline-none transition-colors whitespace-nowrap"
              >
                Aquarium Shop &amp; Tanks
              </button>
            </div>
          </div>

          <div className="text-xs font-mono text-slate-300/90 hud-text-shadow">
            TV Remote: [Play/Pause] Open Menu · [OK] Feed Top · Gamepad: [+ / Select / Start] Open
            Menu · [A] Feed
          </div>
        </div>
      )}

      {/* STATE 2: UNIFIED LIVING AQUARIUM / SCREENSAVER VIEW */}
      {screenState === 'playing' && (
        <div
          data-modal-scope="hud"
          className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-between p-5"
        >
          {/* Minimal Top Bar: Tank Space, Fish Date & Time, Owner Level & Credits on Left; Actions on Right */}
          <div className="w-full flex flex-wrap items-start justify-between gap-4">
            <div className="pointer-events-auto px-3.5 py-2 rounded-lg bg-[#06101e]/80 border border-slate-700/60 text-xs font-mono text-slate-200 tabular-nums flex flex-wrap items-center gap-2.5">
              <span className="text-cyan-300 font-semibold">{currentTank.name}</span>
              <span className="text-slate-500">·</span>
              <span>
                Space: {adultFishes.length}/{currentTank.maxFishCapacity} Fishes
                {babyFishes.length > 0 ? ` (+${babyFishes.length} Babies)` : ''}
                {deadFishes.length > 0 ? ` · ${deadFishes.length} Dead` : ''}
              </span>
              <span className="text-slate-500">·</span>
              <span
                data-testid="fish-date-time-top"
                className="text-sky-200 font-semibold flex items-center gap-1.5"
                title="Current Date & Time for the Fishes"
              >
                <span>
                  {formattedFishDate} · {formattedFishTime} (Day {fishSimDay})
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isUsingSolarDaylight
                      ? 'bg-sky-500/20 border-sky-400/50 text-sky-200'
                      : 'bg-amber-500/20 border-amber-400/50 text-amber-200'
                  }`}
                >
                  {isUsingSolarDaylight
                    ? 'DAYLIGHT'
                    : isDaylightModeOn
                    ? 'NIGHT · BULB LIGHTS'
                    : 'BULB LIGHTS'}
                </span>
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-violet-300 font-semibold">
                Owner Lv.{ownerLevel} ({ownerXp}/100 XP)
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-emerald-300">Gen {highestGeneration}</span>
              <span className="text-slate-500">·</span>
              <span className="text-amber-300 font-semibold">
                {Math.round(ecosystem.bioCredits)} Credits
              </span>
            </div>

            <div className="pointer-events-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-tv-focusable="true"
                onFocus={() => {
                  focusedBtnIndexRef.current = 0;
                  setFocusedBtnIndex(0);
                }}
                onClick={() => {
                  handleSprinkleFoodOnTop();
                }}
                className={`px-4 py-2 rounded-lg bg-amber-500/95 text-slate-950 text-xs font-bold hover:bg-amber-400 focus:ring-4 focus:ring-white focus:outline-none transition-all shadow-lg whitespace-nowrap ${
                  !settingsOpen && !helpModalTopic && focusedBtnIndex === 0
                    ? 'ring-4 ring-white scale-[1.03]'
                    : ''
                }`}
              >
                Sprinkle Food on Top [OK / A]
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onFocus={() => {
                  focusedBtnIndexRef.current = 1;
                  setFocusedBtnIndex(1);
                }}
                onClick={() => {
                  setSettingsOpen((v) => !v);
                }}
                className={`px-3.5 py-2 rounded-lg bg-[#071324]/90 border border-cyan-500/50 text-xs font-semibold text-cyan-200 hover:bg-slate-800 focus:ring-4 focus:ring-cyan-300 focus:outline-none transition-all shadow-lg whitespace-nowrap ${
                  !settingsOpen && !helpModalTopic && focusedBtnIndex === 1
                    ? 'ring-4 ring-cyan-300 scale-[1.03]'
                    : ''
                }`}
              >
                Owner Menu &amp; Shop [Play/Pause · +/Start]
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                aria-label={isMuted ? 'Unmute Audio' : 'Mute Audio'}
                onFocus={() => {
                  focusedBtnIndexRef.current = 2;
                  setFocusedBtnIndex(2);
                }}
                onClick={() => {
                  const nextMute = !isMuted;
                  setIsMuted(nextMute);
                  audioEngine.setMuted(nextMute);
                }}
                className={`p-2 rounded-lg bg-[#071324]/85 border border-slate-700 text-slate-200 hover:border-cyan-400 focus:ring-4 focus:ring-cyan-300 focus:outline-none transition-all ${
                  !settingsOpen && !helpModalTopic && focusedBtnIndex === 2
                    ? 'ring-4 ring-cyan-300 scale-[1.05]'
                    : ''
                }`}
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                  {isMuted ? (
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  ) : (
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  )}
                </svg>
              </button>

              {isShowFpsEnabled && (
                <div
                  data-testid="fps-counter-top-right"
                  className="px-3 py-2 rounded-lg bg-[#06101e]/95 border border-emerald-400/60 text-xs font-mono font-bold tabular-nums shadow-lg flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      fps >= 45 ? 'bg-emerald-400' : fps >= 25 ? 'bg-amber-400' : 'bg-rose-400'
                    }`}
                  />
                  <span
                    className={
                      fps >= 45
                        ? 'text-emerald-300'
                        : fps >= 25
                        ? 'text-amber-300'
                        : 'text-rose-300'
                    }
                  >
                    {fps} FPS
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Dead / Starved Fish Alert Banner on Game Screen */}
          {deadFishes.length > 0 && (
            <div className="pointer-events-auto mx-auto max-w-3xl w-full px-4 py-3 rounded-xl bg-rose-950/90 border border-rose-500/70 text-xs text-rose-100 shadow-2xl flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-bold text-rose-300">
                  {deadFishes.length} Fish{deadFishes.length > 1 ? 'es' : ''} Appeared Dead in Your
                  Aquarium ({deadFishes.map((f) => f.lineage.name).join(', ')})
                </div>
                <div className="text-[11px] text-rose-200/90 font-mono mt-0.5">
                  Cause of Death:{' '}
                  {deadFishes
                    .map((f) => (f.lineage.causeOfDeath || 'starvation').toUpperCase())
                    .join(', ')}{' '}
                  · Floating belly-up near top water surface
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => {
                    setSettingsTab('fish_stats');
                    setSettingsOpen(true);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/30 border border-rose-400 text-white font-bold hover:bg-rose-500/40"
                >
                  Inspect Dead Fish
                </button>
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={handleClearAllDeadFishes}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 font-semibold hover:bg-slate-800"
                >
                  Remove Dead Body
                </button>
              </div>
            </div>
          )}

          {/* Toast Feedback Banner */}
          {toastMessage && (
            <div className="mx-auto px-4 py-2 rounded-lg bg-[#071324]/95 border border-cyan-400/60 text-xs font-medium text-cyan-200 shadow-lg">
              {toastMessage}
            </div>
          )}

          {/* Subtle Bottom Ambient Hint */}
          <div className="w-full flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-300/85 hud-text-shadow">
            <span>
              Water: {Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}% ·
              Temp: {ecosystem.evolutionConfig.environment.temperatureC.toFixed(1)}°C · My
              Auto-Feeder: {ecosystem.autoFeederCountByTank[currentTank.id] || 0}/
              {currentTank.maxAutoFeeders} · 1x Real-Time
            </span>
            <span>{lastControllerInputLabel}</span>
          </div>
        </div>
      )}

      {/* OWNER MENU & SETTINGS MODAL (Fish Stats, Aquarium Shop & Buy Fishes, 3D Polygon Quality) */}
      {settingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Aquarium Owner Menu and Settings"
          data-modal-scope="settings"
          className="fixed inset-0 z-30 flex items-center justify-center bg-[#02060d]/80 p-4 pointer-events-auto"
        >
          <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl bg-[#071324] border border-cyan-500/40 shadow-2xl overflow-hidden text-slate-100">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-[#09192f] border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2.5">
                  <span>Aquarium Owner Menu &amp; Shop</span>
                  <span className="text-xs font-mono font-normal text-cyan-300">
                    Owner Lv.{ownerLevel} ({ownerXp}/100 XP) · {Math.round(ecosystem.bioCredits)}{' '}
                    Credits
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Navigate with TV Remote Arrows / Gamepad D-Pad · [OK / A] Select · [LB / RB]
                  Switch Tab · [Play/Pause or +/Start or B] Close
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setHelpModalTopic(HELP_TOPICS.controller_remote)}
                  className="px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-400/50 text-xs font-bold text-cyan-300 hover:bg-cyan-500/30 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                >
                  ? Remote / Gamepad Help
                </button>
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setSettingsOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg bg-slate-800 text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-700 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                >
                  Close [B / Play-Pause]
                </button>
              </div>
            </div>

            {/* Modal Tabs */}
            <div className="px-6 py-2.5 bg-[#081528] border-b border-slate-800 flex items-center gap-2 overflow-x-auto">
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setSettingsTab('fish_stats')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                  settingsTab === 'fish_stats'
                    ? 'bg-cyan-400 text-slate-950'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                1. My Fishes ({aliveFishes.length} Live
                {deadFishes.length > 0 ? ` · ${deadFishes.length} Dead` : ''} · Space{' '}
                {adultFishes.length}/{currentTank.maxFishCapacity})
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setSettingsTab('aquarium_shop')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                  settingsTab === 'aquarium_shop'
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                2. Buy Fishes &amp; Upgrade Tank Space ({Math.round(ecosystem.bioCredits)} Credits)
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setSettingsTab('graphics_polygons')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                  settingsTab === 'graphics_polygons'
                    ? 'bg-cyan-400 text-slate-950'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                3. Display, Lights &amp; 3D Quality
              </button>
            </div>

            {/* Modal Content Area */}
            <div className="flex-1 overflow-y-auto lab-scroll p-6 space-y-5">
              {/* TAB 1: STATS OF EACH FISH */}
              {settingsTab === 'fish_stats' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Live Fishes in {currentTank.name} — Adult Space: {adultFishes.length}/
                        {currentTank.maxFishCapacity}
                        {babyFishes.length > 0
                          ? ` (+ ${babyFishes.length} Babies Over Max Allowed)`
                          : ''}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        When you open the game, your fishes dynamically move from the 24/7 Offline
                        Keeper into your live tank. When you leave, they return to the Keeper
                        automatically.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={handleSprinkleFoodOnTop}
                        className="px-3.5 py-1.5 rounded-lg bg-amber-400 text-slate-950 text-xs font-bold hover:bg-amber-300 focus:ring-4 focus:ring-white focus:outline-none"
                      >
                        Sprinkle Food on Top
                      </button>
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => setHelpModalTopic(HELP_TOPICS.ai_breeding)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                        title="How Natural AI Breeding Works"
                      >
                        ?
                      </button>
                    </div>
                  </div>

                  {adultFishes.length > currentTank.maxFishCapacity && (
                    <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-xs text-amber-200">
                      Your babies matured into adults over the tank&rsquo;s space limit (
                      {adultFishes.length}/{currentTank.maxFishCapacity}). They remain safely in
                      your aquarium, and new breeding is paused until count drops below capacity or
                      you upgrade your tank space!
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {ecosystem.fishes.map((fish) => {
                      const sp =
                        ecosystem.speciesList.find((s) => s.id === fish.lineage.speciesId) ||
                        DEFAULT_SPECIES_LIST[0];
                      const isDead = !fish.lineage.alive;
                      const satisfaction = isDead
                        ? 0
                        : Math.round(
                            Math.max(
                              0,
                              Math.min(
                                100,
                                fish.state.energy * 0.65 + (100 - fish.state.stress) * 0.35
                              )
                            )
                          );
                      return (
                        <div
                          key={fish.lineage.fishId}
                          className={`p-4 rounded-xl border space-y-3 ${
                            isDead
                              ? 'bg-slate-900/75 border-slate-500/70 grayscale opacity-85'
                              : 'bg-slate-900/90 border-slate-800'
                          }`}
                        >
                          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-3.5 h-3.5 rounded-full shrink-0 border border-white/30"
                                style={{
                                  backgroundColor: isDead ? '#9ca3af' : sp.primaryColorHex,
                                }}
                              />
                              <div>
                                <div className={`text-sm font-bold ${isDead ? 'text-slate-300 line-through' : 'text-white'}`}>
                                  {fish.lineage.name}{' '}
                                  <span className="text-xs font-mono text-cyan-400">
                                    · Gen {fish.lineage.generation}
                                  </span>
                                </div>
                                <div className="text-xs text-slate-400">
                                  {sp.name} · Brain:{' '}
                                  <span className="font-mono text-slate-300">
                                    {fish.lineage.modelVersion}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <span
                              className={`text-xs font-mono font-bold ${
                                isDead ? 'text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-600' : 'text-cyan-300'
                              }`}
                            >
                              {isDead
                                ? `DEAD · GREYED (${(fish.lineage.causeOfDeath || 'starvation').toUpperCase()})`
                                : fish.state.isGravid
                                ? 'Expecting Babies'
                                : fish.state.lifeStage.toUpperCase()}
                            </span>
                          </div>

                          <div className="space-y-2 text-xs">
                            <div>
                              <div className="flex justify-between font-mono mb-1">
                                <span className="text-slate-400">Fullness / Energy</span>
                                <span
                                  className={
                                    isDead || fish.state.energy < 30
                                      ? 'text-rose-400'
                                      : 'text-emerald-400'
                                  }
                                >
                                  {isDead ? '0% (Starved)' : `${fish.state.energy.toFixed(0)}%`}
                                </span>
                              </div>
                              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    isDead || fish.state.energy < 30
                                      ? 'bg-rose-500'
                                      : 'bg-emerald-400'
                                  }`}
                                  style={{
                                    width: `${isDead ? 0 : Math.min(100, fish.state.energy)}%`,
                                  }}
                                />
                              </div>
                            </div>

                            <div>
                              <div className="flex justify-between font-mono mb-1">
                                <span className="text-slate-400">Satisfaction &amp; Comfort</span>
                                <span className={isDead ? 'text-rose-400' : 'text-cyan-300'}>
                                  {satisfaction}%
                                </span>
                              </div>
                              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-cyan-400 rounded-full"
                                  style={{ width: `${satisfaction}%` }}
                                />
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-1 text-xs font-mono text-slate-300 tabular-nums">
                            <div>
                              Age: {fish.state.ageSimHours.toFixed(1)}h /{' '}
                              {sp.lifespan.lifespanSimHours}h
                            </div>
                            <div>Food Eaten: {fish.state.metrics.foodPelletsEaten}</div>
                            <div>Babies Hatched: {fish.state.metrics.offspringProduced}</div>
                            <div>Speed Gene: {fish.genetics.maxSpeedGene}x</div>
                          </div>

                          {isDead && (
                            <div className="pt-2 border-t border-rose-500/30 flex items-center justify-between gap-2">
                              <span className="text-[11px] font-mono text-rose-300">
                                Died of {fish.lineage.causeOfDeath || 'starvation'}
                              </span>
                              <button
                                type="button"
                                data-tv-focusable="true"
                                onClick={() => handleRemoveDeadFish(fish.lineage.fishId)}
                                className="px-3 py-1 rounded-lg bg-rose-500/30 border border-rose-400/60 text-xs font-bold text-rose-100 hover:bg-rose-500/50"
                              >
                                Remove Dead Fish
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {aliveFishes.length < 2 && (
                    <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/40 flex items-center justify-between">
                      <span className="text-xs text-amber-200">
                        You have fewer than 2 fishes left in your aquarium. Restock a starter pair
                        so they can breed naturally!
                      </span>
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={handleRestockStarterPair}
                        className="px-4 py-2 rounded-lg bg-amber-400 text-slate-950 text-xs font-bold hover:bg-amber-300 focus:ring-4 focus:ring-white focus:outline-none"
                      >
                        Restock 2 Starter Fishes (Free)
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: AQUARIUM SHOP — BUY FISHES (BY OWNER LEVEL) & UPGRADE TANK SPACE (3 -> 4 -> 5 -> 6) */}
              {settingsTab === 'aquarium_shop' && (
                <div className="space-y-6">
                  {/* Top Care & Auto-Feeder Bar */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-bold text-white flex items-center gap-2">
                        <span>Water Filter &amp; Owner Top Auto-Feeder</span>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => setHelpModalTopic(HELP_TOPICS.water_care)}
                          className="w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                        >
                          ?
                        </button>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        Water Quality:{' '}
                        {Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}% ·
                        Owner Top Auto-Feeders Installed:{' '}
                        {ecosystem.autoFeederCountByTank[currentTank.id] || 0}/
                        {currentTank.maxAutoFeeders} (Used by 24/7 Keeper when offline)
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={handleCleanAquariumWater}
                        className="px-3.5 py-2 rounded-lg bg-cyan-500 text-slate-950 text-xs font-bold hover:bg-cyan-400 focus:ring-4 focus:ring-white focus:outline-none"
                      >
                        Refresh Water &amp; Filter (+12 XP)
                      </button>
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={handleBuyAutoFeeder}
                        className="px-3.5 py-2 rounded-lg bg-emerald-500 text-slate-950 text-xs font-bold hover:bg-emerald-400 focus:ring-4 focus:ring-white focus:outline-none"
                      >
                        Buy Owner Auto-Feeder (75 Credits)
                      </button>
                    </div>
                  </div>

                  {/* Section A: Buy Fishes Unlocked by Owner Level */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-white">
                          Buy Fishes for Your Aquarium — Tank Space: {aliveFishes.length}/
                          {currentTank.maxFishCapacity} Fishes
                        </h3>
                        <p className="text-xs text-slate-400">
                          Fish species unlock as your Owner Level increases (Current: Owner Lv.
                          {ownerLevel} · {ownerXp}/100 XP). You can buy fishes up to your active
                          aquarium&rsquo;s space limit ({currentTank.maxFishCapacity}).
                        </p>
                      </div>
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => setHelpModalTopic(HELP_TOPICS.owner_level_shop)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                      >
                        ?
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                      {sortedShopSpecies.map((sp) => {
                        const reqLv = sp.requiredOwnerLevel || 1;
                        const price = sp.shopPriceCredits || 45;
                        const unlockedByLevel = ownerLevel >= reqLv;
                        const hasSpace = aliveFishes.length < currentTank.maxFishCapacity;
                        const canAfford = ecosystem.bioCredits >= price;

                        return (
                          <div
                            key={sp.id}
                            className={`p-4 rounded-xl border flex flex-col justify-between gap-3 ${
                              unlockedByLevel
                                ? 'bg-slate-900/95 border-slate-700'
                                : 'bg-slate-950/75 border-slate-800/80 opacity-80'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span
                                    className="w-3.5 h-3.5 rounded-full shrink-0 border border-white/30"
                                    style={{
                                      background: `linear-gradient(135deg, ${sp.primaryColorHex}, ${sp.secondaryColorHex})`,
                                    }}
                                  />
                                  <span className="text-xs font-bold text-white">{sp.name}</span>
                                </div>
                                <span className="text-xs font-mono text-amber-300 font-semibold">
                                  {price} Cr
                                </span>
                              </div>
                              <div className="text-[11px] font-mono text-slate-400 mt-1">
                                {sp.scientificName} · Lifespan {sp.lifespan.lifespanSimHours}h ·
                                Requires Lv.{reqLv}
                              </div>
                              <p className="text-xs text-slate-300 mt-1.5 line-clamp-2">
                                {sp.description}
                              </p>
                            </div>

                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() => handleBuyFishFromShop(sp)}
                              className={`w-full py-2 px-3 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                                !unlockedByLevel
                                  ? 'bg-slate-800 text-slate-400'
                                  : !hasSpace
                                  ? 'bg-slate-800 text-amber-300'
                                  : canAfford
                                  ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {!unlockedByLevel
                                ? `Unlocks at Owner Lv.${reqLv}`
                                : !hasSpace
                                ? `Tank Full (${currentTank.maxFishCapacity}/${currentTank.maxFishCapacity}) — Upgrade Tank`
                                : `Buy Fish (${price} Credits)`}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Section B: Upgrade Aquarium Tank for More Space (3 -> 4 -> 5 -> 6 Max) */}
                  <div className="space-y-3 pt-2 border-t border-slate-800">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Aquarium Tanks — Upgrade for More Space (3 → 4 → 5 → 6 Max Fishes)
                      </h3>
                      <p className="text-xs text-slate-400">
                        Changing tanks expands your aquarium&rsquo;s space capacity up to the
                        maximum of 6 adult fishes, while allowing babies to exist over the max.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {TANK_TIERS.map((tier) => {
                        const unlocked = ecosystem.unlockedTankTiers.includes(tier.tierIndex);
                        const isCurrent = ecosystem.activeTankTier === tier.tierIndex;
                        return (
                          <div
                            key={tier.id}
                            className={`p-4 rounded-xl border flex flex-col justify-between ${
                              isCurrent
                                ? 'bg-cyan-950/40 border-cyan-400'
                                : unlocked
                                ? 'bg-slate-900/90 border-slate-700'
                                : 'bg-slate-950/80 border-slate-800/80'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-bold text-white">{tier.name}</span>
                                <span className="text-xs font-mono text-amber-300">
                                  {unlocked ? 'OWNED' : `${tier.costCredits} Credits`}
                                </span>
                              </div>
                              <div className="text-xs font-mono text-cyan-300 mt-0.5">
                                Space Capacity: {tier.maxFishCapacity} Adult Fishes (+ Babies Over
                                Max)
                              </div>
                              <p className="text-xs text-slate-400 mt-2">{tier.description}</p>
                            </div>

                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() => handleBuyOrSelectTank(tier.tierIndex)}
                              className={`mt-4 w-full py-2 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                                isCurrent
                                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                                  : unlocked
                                  ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                                  : 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                              }`}
                            >
                              {isCurrent
                                ? `Active Tank (${tier.maxFishCapacity} Fish Space)`
                                : unlocked
                                ? `Switch to Tank (${tier.maxFishCapacity} Fish Space)`
                                : `Buy Tank for ${tier.maxFishCapacity} Fish Space (${tier.costCredits} Cr)`}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: 3D POLYGON & GRAPHICS SETTINGS (Graphics Quality First!) */}
              {settingsTab === 'graphics_polygons' && (
                <div className="space-y-5">
                  {/* 1. FIRST IN TAB: 3D Fish Polygon Quality (Mesh Smoothness) & Top-Right FPS Counter Toggle */}
                  <div className="p-4 rounded-xl bg-slate-900/95 border border-cyan-500/50 space-y-3 shadow-lg">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-white flex items-center gap-2">
                          <span>1. 3D Graphics &amp; Fish Polygon Quality</span>
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={() => setHelpModalTopic(HELP_TOPICS.fish_polygons)}
                            className="w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                          >
                            ?
                          </button>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Current Active Mesh:{' '}
                          <span className="font-mono text-cyan-300">
                            {polyStats.trianglesPerFish.toLocaleString()} triangles per fish (
                            {polyStats.totalFishTriangles.toLocaleString()} total fish triangles)
                          </span>
                        </div>
                      </div>

                      {/* Show FPS on Top Right Toggle right in the top Graphics Quality header */}
                      <div className="flex items-center gap-2.5">
                        <span className="px-2.5 py-1 rounded-lg bg-slate-950 border border-emerald-500/40 text-xs font-mono font-bold text-emerald-300 tabular-nums">
                          Live: {fps} FPS
                        </span>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleToggleShowFps}
                          className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                            isShowFpsEnabled
                              ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                              : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
                          }`}
                        >
                          {isShowFpsEnabled ? 'Show FPS: ON (Top Right)' : 'Show FPS: OFF'}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-1">
                      {(
                        [
                          ['very_low', 'Very Low (Max FPS)', '~140 Tris / Fish'],
                          ['low', 'Low (TV Saver)', '~420 Tris / Fish'],
                          ['medium', 'Medium (Balanced)', '~1,380 Tris / Fish'],
                          ['high', 'High (Sculpted 3D)', '~2,950 Tris / Fish'],
                          ['ultra', 'Ultra (Cinema 3D)', '~6,800 Tris / Fish'],
                        ] as Array<[FishPolygonQuality, string, string]>
                      ).map(([qId, label, sub]) => (
                        <button
                          key={qId}
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => handleUpdatePolygonQuality(qId)}
                          className={`p-3 rounded-xl border text-left transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                            currentPolyQuality === qId
                              ? 'bg-cyan-500/20 border-cyan-400 text-white'
                              : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          <div className="text-xs font-bold">{label}</div>
                          <div className="text-[11px] font-mono text-cyan-400 mt-1">{sub}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 2. SECOND IN TAB: Environment Lighting, Shader Quality & Water Effects */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-bold text-white">
                          2. Environment Shader Quality, Shadows &amp; Water Effects
                        </div>
                        <div className="text-xs text-slate-400">
                          Configure shader quality (Very Low unlit fast mode up to High PBR shadows),
                          caustic light shimmer, and oxygen bubbles.
                        </div>
                      </div>
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => setHelpModalTopic(HELP_TOPICS.lighting_quality)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                      >
                        ?
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      {(['very_low', 'low', 'mid', 'high'] as const).map((tier) => (
                        <button
                          key={tier}
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => {
                            const eco = ecosystemRef.current;
                            const prev = eco.graphicsSettings || {
                              fishPolygonQuality: 'high',
                              environmentQuality: 'high',
                              showCaustics: true,
                              showParticles: true,
                              antiAliasing: true,
                            };
                            eco.graphicsSettings = {
                              ...prev,
                              environmentQuality: tier,
                              ...(tier === 'very_low'
                                ? {
                                    fishPolygonQuality: 'very_low',
                                    showCaustics: false,
                                    showParticles: false,
                                    antiAliasing: false,
                                  }
                                : {}),
                            };
                            saveEcosystemState(eco);
                            setEcosystem({ ...eco });
                            showToast(
                              tier === 'very_low'
                                ? 'Very Low Graphics Quality enabled (Unlit shaders, 0.55x resolution, ~140 tris/fish).'
                                : `Lighting & Environment Quality set to ${tier.toUpperCase()}`
                            );
                          }}
                          className={`px-4 py-2 rounded-lg text-xs font-bold border focus:ring-4 focus:ring-white focus:outline-none ${
                            currentEnvQuality === tier
                              ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                              : 'bg-slate-950 text-slate-300 border-slate-800'
                          }`}
                        >
                          Lighting: {tier === 'very_low' ? 'VERY LOW (MAX FPS)' : tier.toUpperCase()}
                        </button>
                      ))}

                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => {
                          const eco = ecosystemRef.current;
                          const nextVal = eco.graphicsSettings?.showCaustics === false;
                          eco.graphicsSettings = {
                            ...(eco.graphicsSettings || {
                              fishPolygonQuality: 'high',
                              environmentQuality: 'high',
                              showCaustics: true,
                              showParticles: true,
                              antiAliasing: true,
                            }),
                            showCaustics: nextVal,
                          };
                          saveEcosystemState(eco);
                          setEcosystem({ ...eco });
                        }}
                        className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-950 border border-slate-800 text-slate-200 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                      >
                        Caustic Shimmer:{' '}
                        {ecosystem.graphicsSettings?.showCaustics !== false ? 'ON' : 'OFF'}
                      </button>

                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => {
                          const eco = ecosystemRef.current;
                          const nextVal = eco.graphicsSettings?.showParticles === false;
                          eco.graphicsSettings = {
                            ...(eco.graphicsSettings || {
                              fishPolygonQuality: 'high',
                              environmentQuality: 'high',
                              showCaustics: true,
                              showParticles: true,
                              antiAliasing: true,
                            }),
                            showParticles: nextVal,
                          };
                          saveEcosystemState(eco);
                          setEcosystem({ ...eco });
                        }}
                        className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-950 border border-slate-800 text-slate-200 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                      >
                        Oxygen Bubbles:{' '}
                        {ecosystem.graphicsSettings?.showParticles !== false ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>

                  {/* 3. THIRD IN TAB: Daylight Mode (ON / OFF) & Automatic Night Bulb Lights */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-amber-500/40 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-white flex items-center gap-2">
                          <span>3. Daylight Lighting (ON / OFF) &amp; Night Bulb Lights</span>
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={() => setHelpModalTopic(HELP_TOPICS.daylight_mode)}
                            className="w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                          >
                            ?
                          </button>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          When <strong>Daylight is ON</strong>, the aquarium shows natural solar
                          daylight during the day (06:00–18:30) and automatically turns on warm
                          overhead <strong>Bulb Lights</strong> at night. When{' '}
                          <strong>Daylight is OFF</strong>, overhead Bulb Lights are used all the
                          time.
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border ${
                            isUsingSolarDaylight
                              ? 'bg-sky-500/20 border-sky-400/50 text-sky-200'
                              : 'bg-amber-500/20 border-amber-400/50 text-amber-200'
                          }`}
                        >
                          Active Now:{' '}
                          {isUsingSolarDaylight ? 'SOLAR DAYLIGHT' : 'AQUARIUM BULB LIGHTS'}
                        </span>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleToggleDaylightMode}
                          className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                            isDaylightModeOn
                              ? 'bg-sky-400 text-slate-950 hover:bg-sky-300'
                              : 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                          }`}
                        >
                          {isDaylightModeOn
                            ? 'Daylight: ON (Day Sun / Night Bulbs)'
                            : 'Daylight: OFF (Bulb Lights Only)'}
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
                      <span className="text-slate-300 font-mono">
                        Fish Date &amp; Time: {formattedFishDate} · {formattedFishTime} (Sim Day{' '}
                        {fishSimDay})
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-slate-400">Time of Day Cycle:</span>
                        {(
                          [
                            ['auto', 'Auto Real-Time Clock'],
                            ['day', 'Force Day (Sun)'],
                            ['night', 'Force Night (Bulb Lights)'],
                          ] as Array<['auto' | 'day' | 'night', string]>
                        ).map(([modeId, modeLabel]) => (
                          <button
                            key={modeId}
                            type="button"
                            data-tv-focusable="true"
                            onClick={() =>
                              handleUpdateLightingSettings(
                                { timeOfDayOverride: modeId },
                                `Fish time cycle set to ${modeLabel}`
                              )
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                              currentTimeOverride === modeId
                                ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-600'
                            }`}
                          >
                            {modeLabel}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 4. FOURTH IN TAB: Full-Screen Frameless TV Aquarium Mode Toggle (Default ON) */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-cyan-500/40 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-bold text-white flex items-center gap-2">
                        <span>4. Full-Screen TV Aquarium Mode</span>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => setHelpModalTopic(HELP_TOPICS.frameless_tv)}
                          className="w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                        >
                          ?
                        </button>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Removes tank borders so your screen becomes an edge-to-edge aquarium.
                      </p>
                    </div>
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={handleToggleFramelessTvMode}
                      className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                        isFramelessTvMode
                          ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                          : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
                      }`}
                    >
                      {isFramelessTvMode ? 'Full-Screen TV: ON' : 'Full-Screen TV: OFF'}
                    </button>
                  </div>

                  {/* 4. FOURTH IN TAB: Customizable Aquarium Background Blue & Overhead Lighting Tuner */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-cyan-500/30 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold text-white">
                          4. Aquarium Background Blue &amp; Lighting Intensity
                        </div>
                        <p className="text-xs text-slate-400">
                          Customize how dark or bright the blue water at the back of the tank looks,
                          plus overhead reef lamp intensity to match your room and TV.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(
                          [
                            ['Abyssal Night', 0.06, 0.55],
                            ['Deep Ocean (Default)', 0.22, 0.95],
                            ['Natural Reef', 0.45, 1.15],
                            ['Bright Lagoon', 0.78, 1.4],
                          ] as Array<[string, number, number]>
                        ).map(([presetName, bgVal, lightVal]) => {
                          const isSelected =
                            Math.abs(currentBgBrightness - bgVal) < 0.04 &&
                            Math.abs(currentLightIntensity - lightVal) < 0.08;
                          return (
                            <button
                              key={presetName}
                              type="button"
                              data-tv-focusable="true"
                              onClick={() =>
                                handleUpdateLightingSettings(
                                  {
                                    backgroundBrightness: bgVal,
                                    lightIntensity: lightVal,
                                  },
                                  `Lighting preset set to ${presetName}`
                                )
                              }
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors focus:ring-4 focus:ring-white focus:outline-none ${
                                isSelected
                                  ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                  : 'bg-slate-950 text-slate-300 border-slate-700 hover:border-cyan-400/60'
                              }`}
                            >
                              {presetName}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                      {/* Control 1: Back-of-Tank Blue Brightness */}
                      <div className="p-3.5 rounded-xl bg-slate-950/85 border border-slate-800 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-200">
                            Back-of-Tank Blue Brightness
                          </span>
                          <span className="text-xs font-mono font-bold text-cyan-300 tabular-nums">
                            {Math.round(currentBgBrightness * 100)}%
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          0% = Pitch-Black Abyss · 22% = Deep Dark Ocean · 100% = Bright Lagoon Blue
                        </p>
                        <div className="flex items-center gap-2.5 pt-0.5">
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={() =>
                              handleUpdateLightingSettings({
                                backgroundBrightness: currentBgBrightness - 0.08,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono font-bold text-white border border-slate-700 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                          >
                            - Darker
                          </button>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={2}
                            value={Math.round(currentBgBrightness * 100)}
                            onChange={(e) =>
                              handleUpdateLightingSettings({
                                backgroundBrightness: Number(e.target.value) / 100,
                              })
                            }
                            className="flex-1 accent-cyan-400 cursor-pointer"
                            aria-label="Back of Tank Blue Brightness"
                          />
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={() =>
                              handleUpdateLightingSettings({
                                backgroundBrightness: currentBgBrightness + 0.08,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono font-bold text-white border border-slate-700 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                          >
                            + Brighter
                          </button>
                        </div>
                      </div>

                      {/* Control 2: Overhead Aquarium Light Intensity */}
                      <div className="p-3.5 rounded-xl bg-slate-950/85 border border-slate-800 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-200">
                            Overhead Aquarium Light Intensity
                          </span>
                          <span className="text-xs font-mono font-bold text-amber-300 tabular-nums">
                            {Math.round(currentLightIntensity * 100)}%
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          15% = Dim Moonlight Sanctuary · 95% = Natural Sun · 180% = High-Output Reef
                        </p>
                        <div className="flex items-center gap-2.5 pt-0.5">
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={() =>
                              handleUpdateLightingSettings({
                                lightIntensity: currentLightIntensity - 0.1,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono font-bold text-white border border-slate-700 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                          >
                            - Dimmer
                          </button>
                          <input
                            type="range"
                            min={15}
                            max={180}
                            step={5}
                            value={Math.round(currentLightIntensity * 100)}
                            onChange={(e) =>
                              handleUpdateLightingSettings({
                                lightIntensity: Number(e.target.value) / 100,
                              })
                            }
                            className="flex-1 accent-amber-400 cursor-pointer"
                            aria-label="Overhead Aquarium Light Intensity"
                          />
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={() =>
                              handleUpdateLightingSettings({
                                lightIntensity: currentLightIntensity + 0.1,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono font-bold text-white border border-slate-700 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
                          >
                            + Brighter
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Real-Time Clock Status (Time Acceleration Disabled in Player Game) */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold text-white">
                        Aquarium Simulation Clock: Locked to 1x Real-Time
                      </div>
                      <div className="text-xs text-slate-400">
                        Your aquarium runs in authentic 1x real-time ({ecosystem.simHoursTotal.toFixed(2)}h
                        elapsed) and continues living 24/7 in the Offline Fish Keeper when you close
                        the game.
                      </div>
                    </div>
                    <span className="text-xs font-mono text-emerald-300 font-bold">
                      1x REAL-TIME
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PLAIN-ENGLISH "?" EXPLANATION MODAL */}
      {helpModalTopic && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={helpModalTopic.title}
          data-modal-scope="help"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d]/85 p-4 pointer-events-auto"
        >
          <div className="w-full max-w-md rounded-2xl bg-[#09192f] border border-cyan-400/60 p-6 shadow-2xl space-y-4 text-slate-100">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">{helpModalTopic.title}</h3>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setHelpModalTopic(null)}
                className="px-3 py-1 rounded bg-slate-800 text-xs text-slate-200 hover:text-white focus:ring-4 focus:ring-cyan-300 focus:outline-none"
              >
                Close [B / OK]
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
              {helpModalTopic.body}
            </p>
            <div className="p-3 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-xs text-cyan-200">
              <strong>Tip:</strong> {helpModalTopic.tip}
            </div>
          </div>
        </div>
      )}

      {/* STATE 3: PAUSE MODAL OVERLAY */}
      {screenState === 'paused' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Aquarium Paused"
          data-modal-scope="paused"
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#02060d]/80 p-6 pointer-events-auto"
        >
          <div className="w-full max-w-sm rounded-2xl bg-[#071324] border border-cyan-500/40 p-6 shadow-2xl space-y-4 text-center">
            <h2 className="text-xl font-bold text-white">{t.pausedTitle || 'Sanctuary Paused'}</h2>
            <p className="text-xs text-slate-400">
              Aquarium clock paused at {ecosystem.simHoursTotal.toFixed(2)} simulation hours.
            </p>
            <div className="flex flex-col gap-2.5 pt-2">
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  ecosystemRef.current.paused = false;
                  setScreenState('playing');
                }}
                className="w-full py-2.5 rounded-lg bg-cyan-400 text-slate-950 text-xs font-bold hover:bg-cyan-300 focus:ring-4 focus:ring-white focus:outline-none"
              >
                {t.resume}
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  ecosystemRef.current.paused = false;
                  setScreenState('playing');
                  setSettingsOpen(true);
                }}
                className="w-full py-2.5 rounded-lg bg-slate-800 text-cyan-300 text-xs font-semibold hover:bg-slate-700 focus:ring-4 focus:ring-cyan-300 focus:outline-none"
              >
                Open Owner Menu &amp; Shop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
