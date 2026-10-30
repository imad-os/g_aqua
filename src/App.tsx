import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AquariumCanvas3D,
  getPolygonSpecForQuality,
} from './components/AquariumCanvas3D';
import { audioEngine } from './engine/audio';
import { createBaseBrainInstance } from './engine/brain';
import { DEFAULT_SPECIES_LIST, TANK_TIERS } from './engine/defaults';
import {
  createSpeciesConfigFromFamousFish,
  FAMOUS_AQUARIUM_FISHES_50,
} from './engine/famousFishCatalog';
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

const PRESET_FISH_NAMES: string[] = [
  'Aurelia',
  'Zephyr',
  'Neptune',
  'Coral',
  'Solstice',
  'Bubbles',
  'Orion',
  'Sapphire',
  'Luna',
  'Nemo',
  'Finley',
  'Poseidon',
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
    title: 'Fish Shop & Tank Space (3 to 6 Max)',
    body: 'Feeding fishes, keeping water clean, and raising babies earns XP and raises your level. Higher levels unlock new famous fish species in the shop! Upgrading your aquarium tank is strictly for more space: Tank 1 holds 3 fishes, Tank 2 holds 4, Tank 3 holds 5, and Tank 4 holds the maximum of 6 fishes.',
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

  // Fish Renaming Modal State
  const [renamingFishId, setRenamingFishId] = useState<string | null>(null);
  const renamingFishIdRef = useRef<string | null>(null);
  renamingFishIdRef.current = renamingFishId;
  const [renameDraft, setRenameDraft] = useState<string>('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Track when MyPC OS overlay menu is open (e.g. when user presses Return/Back to exit game)
  // While true, the game yields 100% of keyboard/remote/gamepad input and focus to MyPC OS!
  const mypcSystemMenuOpenRef = useRef<boolean>(false);

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
    'TV Remote [Play/Pause] or Gamepad [+ / Select / Start] opens HUD'
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
  const lastAppliedCloudUpdatedMsRef = useRef<number>(ecosystem.lastSavedAtMs || 0);
  const prevGamepadButtonsRef = useRef<boolean[]>([]);
  const lastDpadAxisMoveMsRef = useRef<number>(0);

  // Returns true if the MyPC OS system menu is open or if focus is on an external MyPC DOM element
  const isMypcSystemMenuActive = useCallback((): boolean => {
    if (mypcSystemMenuOpenRef.current) return true;
    if (typeof document === 'undefined') return false;
    const rootEl = document.getElementById('root');
    const activeEl = document.activeElement;
    if (
      activeEl &&
      activeEl !== document.body &&
      activeEl !== document.documentElement &&
      rootEl &&
      !rootEl.contains(activeEl)
    ) {
      return true;
    }
    // Also check if MyPC SDK injected a visible overlay dialog outside #root
    const bodyChildren = Array.from(document.body.children);
    for (const child of bodyChildren) {
      if (child.id === 'root' || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
        continue;
      }
      if (child instanceof HTMLElement) {
        const style = window.getComputedStyle(child);
        if (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.05 &&
          child.offsetWidth > 20 &&
          child.offsetHeight > 20
        ) {
          return true;
        }
      }
    }
    return false;
  }, []);

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
   * immediately takes effect in the user's game even if the user has the game open, with sound effects!
   */
  const applyCloudRecordToEcosystem = useCallback(
    (cloudRecord: CloudUserBrainRecord, isAuthoritativeOverride: boolean) => {
      if (!cloudRecord || !Array.isArray(cloudRecord.fishBrains)) return;
      const eco = ecosystemRef.current;

      // Merge permanent tombstones (removedFishIds) so removed dead bodies never reappear
      const mergedRemovedSet = new Set<string>([
        ...(eco.removedFishIds || []),
        ...(cloudRecord.removedFishIds || []),
      ]);
      eco.removedFishIds = Array.from(mergedRemovedSet).slice(-200);

      const ackDeadSet = new Set<string>(eco.acknowledgedDeadFishIds || []);

      // Filter cloudRecord.fishBrains against mergedRemovedSet
      const validCloudBrains = cloudRecord.fishBrains.filter(
        (cb) => cb && !mergedRemovedSet.has(cb.fishId)
      );

      const overrideTs = Number(cloudRecord.adminOverrideAtMs || 0);
      const cloudUpdatedMs = Number(cloudRecord.updatedAtMs || 0);
      const isNewAdminOverride = overrideTs > lastAppliedAdminOverrideMsRef.current;

      // Detect if there is any structural difference between validCloudBrains and local fishes
      const localFishMap = new Map(eco.fishes.map((f) => [f.lineage.fishId, f]));
      let hasStructuralDifference = validCloudBrains.length !== eco.fishes.length;
      if (!hasStructuralDifference) {
        for (const cb of validCloudBrains) {
          const lf = localFishMap.get(cb.fishId);
          if (
            !lf ||
            lf.lineage.alive !== cb.alive ||
            lf.lineage.speciesId !== cb.speciesId ||
            lf.lineage.name !== cb.name
          ) {
            hasStructuralDifference = true;
            break;
          }
        }
      }

      // If neither a new admin override nor a newer cloud timestamp nor a structural difference, skip
      if (!isNewAdminOverride && !hasStructuralDifference && cloudUpdatedMs <= lastAppliedCloudUpdatedMsRef.current) {
        return;
      }

      // If there is a structural difference, only apply if it comes from a new admin override,
      // an authoritative listener update, or a cloud record newer than our last local admin/user action
      if (
        !isNewAdminOverride &&
        !isAuthoritativeOverride &&
        overrideTs < (eco.adminOverrideAtMs || 0)
      ) {
        return;
      }

      if (overrideTs > lastAppliedAdminOverrideMsRef.current) {
        lastAppliedAdminOverrideMsRef.current = overrideTs;
        eco.adminOverrideAtMs = overrideTs;
      }
      if (cloudUpdatedMs > lastAppliedCloudUpdatedMsRef.current) {
        lastAppliedCloudUpdatedMsRef.current = cloudUpdatedMs;
      }

      const cloudFishIds = new Set(validCloudBrains.map((cb) => cb.fishId));
      const treatAsAuthoritative =
        isAuthoritativeOverride || isNewAdminOverride || hasStructuralDifference;

      if (treatAsAuthoritative) {
        eco.fishes = eco.fishes.filter(
          (f) => cloudFishIds.has(f.lineage.fishId) && !mergedRemovedSet.has(f.lineage.fishId)
        );
        eco.deceasedArchive = eco.deceasedArchive.filter(
          (d) => !mergedRemovedSet.has(d.fishId)
        );
      }

      const newlyKilledNames: string[] = [];
      const newlyAddedNames: string[] = [];
      const newlyReplacedOrRevivedNames: string[] = [];

      for (const cb of validCloudBrains) {
        const localFish = eco.fishes.find((f) => f.lineage.fishId === cb.fishId);

        // Ensure species exists in eco.speciesList (including any of the 50 Famous Fishes gifted/replaced in Trainer!)
        let sp = eco.speciesList.find((s) => s.id === cb.speciesId);
        if (!sp) {
          const famousTpl = FAMOUS_AQUARIUM_FISHES_50.find((f) => f.id === cb.speciesId);
          if (famousTpl) {
            sp = createSpeciesConfigFromFamousFish(famousTpl);
            eco.speciesList.push(sp);
          } else {
            sp = eco.speciesList[0] || DEFAULT_SPECIES_LIST[0];
          }
        }

        if (localFish) {
          const wasAlive = localFish.lineage.alive;
          const prevSpeciesId = localFish.lineage.speciesId;
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
            // Only warn ONCE per dead fishId
            if (wasAlive && !ackDeadSet.has(cb.fishId)) {
              ackDeadSet.add(cb.fishId);
              newlyKilledNames.push(localFish.lineage.name);
            }
          } else {
            ackDeadSet.delete(cb.fishId);
            localFish.state.health = Math.max(80, localFish.state.health);
            if (!wasAlive || prevSpeciesId !== cb.speciesId) {
              newlyReplacedOrRevivedNames.push(`${cb.name} (${sp.name})`);
            }
          }
        } else {
          // Never spawn a dead fish from cloud sync that does not exist in our tank!
          if (!cb.alive) {
            mergedRemovedSet.add(cb.fishId);
            continue;
          }
          // Reconstruct newly gifted or hatched live fish from Trainer / Keeper cloud sync
          const spawned = spawnFoundingFish(
            sp,
            eco.activeTankTier,
            eco.simHoursTotal,
            eco.fishes.length,
            cb.brain
          );
          spawned.lineage.fishId = cb.fishId;
          spawned.lineage.speciesId = sp.id;
          spawned.lineage.name = cb.name;
          spawned.lineage.generation = cb.generation;
          spawned.lineage.modelVersion = cb.modelVersion;
          spawned.lineage.motherId = cb.motherId;
          spawned.lineage.fatherId = cb.fatherId;
          spawned.lineage.alive = true;
          spawned.lineage.causeOfDeath = null;
          spawned.state.energy = cb.energy;
          spawned.state.hunger = cb.hunger;
          spawned.state.ageSimHours = cb.ageSimHours;
          spawned.state.lifeStage =
            cb.ageSimHours < sp.lifespan.sexualMaturityAgeHours ? 'juvenile' : 'adult';
          newlyAddedNames.push(`${spawned.lineage.name} (${sp.name})`);
          eco.fishes.push(spawned);
        }
      }

      eco.removedFishIds = Array.from(mergedRemovedSet).slice(-200);
      eco.acknowledgedDeadFishIds = Array.from(ackDeadSet).slice(-200);

      // Save immediately to localStorage and reset periodic timers so the game never overwrites this cloud update
      saveEcosystemState(eco);
      lastLocalSaveMsRef.current = performance.now();
      lastFirestoreSyncMsRef.current = performance.now();
      ecosystemRef.current = eco;
      setEcosystem({ ...eco });

      // Play distinct sound effects and show toast notifications for real-time updates (only once!)
      if (newlyKilledNames.length > 0) {
        audioEngine.playDeathWarningTone();
        showToast(`Alert: ${newlyKilledNames.join(', ')} died from starvation!`);
      } else if (newlyAddedNames.length > 0) {
        audioEngine.playBirthChime();
        showToast(
          cloudRecord.lastAdminAction
            ? `New Fish Update: ${newlyAddedNames.join(', ')} — ${cloudRecord.lastAdminAction}`
            : `New Fish Arrived: ${newlyAddedNames.join(', ')} joined your aquarium!`
        );
      } else if (newlyReplacedOrRevivedNames.length > 0) {
        audioEngine.playBirthChime();
        showToast(
          cloudRecord.lastAdminAction
            ? `Aquarium Update: ${cloudRecord.lastAdminAction}`
            : `Fish Updated: ${newlyReplacedOrRevivedNames.join(', ')}`
        );
      }
    },
    [showToast]
  );

  // Helper to get all currently visible focusable buttons in the active modal or overlay
  const getVisibleFocusableButtons = useCallback((): HTMLButtonElement[] => {
    if (typeof document === 'undefined' || isMypcSystemMenuActive()) return [];
    const scopeSelector = renamingFishIdRef.current
      ? '[data-modal-scope="rename"]'
      : helpModalRef.current
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
  }, [isMypcSystemMenuActive]);

  // Keep TV Remote / Gamepad visual focus synced when modals or tabs change (unless MyPC OS menu is open)
  useEffect(() => {
    if (isMypcSystemMenuActive()) return;
    setFocusedBtnIndex(0);
    focusedBtnIndexRef.current = 0;
    const timer = window.setTimeout(() => {
      if (isMypcSystemMenuActive()) return;
      if (renamingFishIdRef.current && renameInputRef.current) {
        renameInputRef.current.focus();
        renameInputRef.current.select();
        return;
      }
      const buttons = getVisibleFocusableButtons();
      if (buttons[0]) {
        buttons[0].focus({ preventScroll: false });
      }
    }, 40);
    return () => window.clearTimeout(timer);
  }, [
    settingsOpen,
    settingsTab,
    helpModalTopic,
    renamingFishId,
    screenState,
    getVisibleFocusableButtons,
    isMypcSystemMenuActive,
  ]);

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

  const activeUsername = mypcInfo.profile?.name || mypc.info()?.profile?.name || 'Keeper';
  const activeProfileId =
    mypcInfo.profile?.id || mypc.info()?.profile?.id || 'local-caretaker';
  const activeUsernameRef = useRef<string>(activeUsername);
  activeUsernameRef.current = activeUsername;
  const activeProfileIdRef = useRef<string>(activeProfileId);
  activeProfileIdRef.current = activeProfileId;

  // ============================================================================
  // DYNAMIC 24/7 FISH KEEPER HAND-OFF & REAL-TIME ADMIN OVERRIDE SYNC
  // ============================================================================
  useEffect(() => {
    const syncLatestFromStorage = () => {
      const latest = loadEcosystemState();
      latest.timeMultiplier = 1;
      const incomingOverrideMs = latest.adminOverrideAtMs || 0;
      const currentOverrideMs = Math.max(
        lastAppliedAdminOverrideMsRef.current,
        ecosystemRef.current.adminOverrideAtMs || 0
      );
      // Only adopt storage state if it has a strictly newer adminOverrideAtMs than our current memory
      if (incomingOverrideMs > currentOverrideMs) {
        const prevAliveCount = ecosystemRef.current.fishes.filter((f) => f.lineage.alive).length;
        const nextAliveCount = latest.fishes.filter((f) => f.lineage.alive).length;
        const prevDeadIds = new Set(
          ecosystemRef.current.fishes.filter((f) => !f.lineage.alive).map((f) => f.lineage.fishId)
        );
        const newlyDead = latest.fishes.filter(
          (f) => !f.lineage.alive && !prevDeadIds.has(f.lineage.fishId)
        );

        lastAppliedAdminOverrideMsRef.current = incomingOverrideMs;
        lastLocalSaveMsRef.current = performance.now();
        lastFirestoreSyncMsRef.current = performance.now();
        ecosystemRef.current = latest;
        setEcosystem({ ...latest });

        if (newlyDead.length > 0) {
          audioEngine.playDeathWarningTone();
        } else if (nextAliveCount >= prevAliveCount) {
          audioEngine.playBirthChime();
        }
        if (latest.lastAdminAction) {
          showToast(`Live Update: ${latest.lastAdminAction}`);
        }
      }
    };

    const eco = ecosystemRef.current;
    const currentTank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const uName = activeUsernameRef.current;
    const pId = activeProfileIdRef.current;
    const feederCount = eco.autoFeederCountByTank[currentTank.id] || 0;
    const isVisibleAndPlaying =
      screenState === 'playing' &&
      (typeof document === 'undefined' || document.visibilityState === 'visible') &&
      !isForceOfflineOverrideActive();

    // Always read Firestore FIRST before writing so any Trainer action done while offline/unfocused is applied, never overwritten!
    loadUserBrainsFromFirestore(uName).then((cloudRecord) => {
      if (cloudRecord && Array.isArray(cloudRecord.fishBrains) && cloudRecord.fishBrains.length > 0) {
        const hasAdminOverride =
          (cloudRecord.adminOverrideAtMs || 0) > lastAppliedAdminOverrideMsRef.current ||
          (cloudRecord.adminOverrideAtMs || 0) > (ecosystemRef.current.adminOverrideAtMs || 0);
        if (hasAdminOverride || (cloudRecord.updatedAtMs || 0) > (ecosystemRef.current.lastSavedAtMs || 0)) {
          applyCloudRecordToEcosystem(cloudRecord, true);
        }
      }

      const currentEco = ecosystemRef.current;
      const tankNow = TANK_TIERS[currentEco.activeTankTier] || TANK_TIERS[0];
      const fCount = currentEco.autoFeederCountByTank[tankNow.id] || 0;

      if (isVisibleAndPlaying) {
        publishActiveGameSessionLease(tankNow.id, true);
        syncUserBrainsToFirestore(uName, pId, currentEco.fishes, true, fCount, {
          adminOverrideAtMs: currentEco.adminOverrideAtMs,
          removedFishIds: currentEco.removedFishIds,
        });
        lastFirestoreSyncMsRef.current = performance.now();
      } else {
        publishActiveGameSessionLease(tankNow.id, false);
        setUserOnlineStatusInFirestore(uName, pId, false, fCount);
      }
    });

    // Subscribe to real-time authoritative admin overrides from Firestore (`mypc_user_brains/{username}`)
    const unsubAdminOverride = subscribeToSingleUserBrainRecord(uName, (record) => {
      if (!record) return;
      const hasAdminOverride =
        (record.adminOverrideAtMs || 0) > lastAppliedAdminOverrideMsRef.current;
      applyCloudRecordToEcosystem(record, hasAdminOverride);
    });

    // Fast 4-second cloud poll so even if WebSockets throttle on TV, any Trainer action
    // (kill/starve, give fish, reproduce baby, or replace species) updates the online user ASAP!
    const cloudPollTimer = window.setInterval(() => {
      const pollUser = activeUsernameRef.current;
      loadUserBrainsFromFirestore(pollUser).then((cloudRecord) => {
        if (cloudRecord && Array.isArray(cloudRecord.fishBrains)) {
          const isOverride =
            (cloudRecord.adminOverrideAtMs || 0) > lastAppliedAdminOverrideMsRef.current;
          applyCloudRecordToEcosystem(cloudRecord, isOverride);
        }
      });
    }, 4000);

    const handleVisibilityOrFocus = () => {
      const tankNow = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
      const curUser = activeUsernameRef.current;
      const curPid = activeProfileIdRef.current;
      const visible =
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        screenStateRef.current === 'playing' &&
        !isForceOfflineOverrideActive();

      if (visible) {
        publishActiveGameSessionLease(tankNow.id, true);
        // Read Firestore FIRST on focus/visibility so we never overwrite a Trainer override!
        loadUserBrainsFromFirestore(curUser).then((cloudRecord) => {
          if (cloudRecord && Array.isArray(cloudRecord.fishBrains)) {
            const isOverride =
              (cloudRecord.adminOverrideAtMs || 0) > lastAppliedAdminOverrideMsRef.current;
            applyCloudRecordToEcosystem(cloudRecord, isOverride);
          }
          const latestEco = ecosystemRef.current;
          const fCount = latestEco.autoFeederCountByTank[tankNow.id] || 0;
          setUserOnlineStatusInFirestore(curUser, curPid, true, fCount);
          lastFirestoreSyncMsRef.current = performance.now();
        });
      } else {
        saveEcosystemState(ecosystemRef.current);
        const fCount = ecosystemRef.current.autoFeederCountByTank[tankNow.id] || 0;
        publishActiveGameSessionLease(tankNow.id, false);
        setUserOnlineStatusInFirestore(curUser, curPid, false, fCount);
      }
    };

    const handlePageHide = () => {
      const tankNow = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
      const curUser = activeUsernameRef.current;
      const curPid = activeProfileIdRef.current;
      const fCount = ecosystemRef.current.autoFeederCountByTank[tankNow.id] || 0;
      saveEcosystemState(ecosystemRef.current);
      publishActiveGameSessionLease(tankNow.id, false);
      setUserOnlineStatusInFirestore(curUser, curPid, false, fCount);
    };

    const handleStorageEvent = (ev: StorageEvent) => {
      if (ev.key && ev.key.includes('ecosystem_v2')) {
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
      window.clearInterval(cloudPollTimer);
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', handlePageHide);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('storage', handleStorageEvent);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      publishActiveGameSessionLease(currentTank.id, false);
    };
  }, [screenState, ecosystem.activeTankTier, activeUsername, mypc, applyCloudRecordToEcosystem]);

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

    const uName = mypc.info()?.profile?.name || 'Keeper';
    if (xpRes.leveledUp) {
      setEcosystem({ ...eco });
      showToast(
        `Sprinkled food on top! ${uName} Level Up → Level ${xpRes.newLevel} (New shop fishes unlocked!)`
      );
    } else if (settingsOpenRef.current) {
      setEcosystem({ ...eco });
    }
  }, [mypc, showToast]);

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
    const uName = mypc.info()?.profile?.name || 'Keeper';
    showToast(
      xpRes.leveledUp
        ? `Water filtered to 100%! ${uName} Level Up → Level ${xpRes.newLevel}!`
        : `Water filtered & conditioned to 100% quality (25.0°C). Fish comfort restored (+12 XP)!`
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
      const uName = mypc.info()?.profile?.name || 'Keeper';
      showToast(
        `${species.name} requires ${uName} Level ${reqLevel} (you are Level ${ownerLevel}). Feed & care for your fishes to level up!`
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

    const username = activeUsernameRef.current;
    const profileId = activeProfileIdRef.current;
    const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
    syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount, {
      adminOverrideAtMs: eco.adminOverrideAtMs,
      removedFishIds: eco.removedFishIds,
    });

    showToast(
      xpRes.leveledUp
        ? `Bought ${species.name} (${newFish.lineage.name})! ${username} Level Up → Level ${xpRes.newLevel}!`
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

    const username = activeUsernameRef.current;
    const profileId = activeProfileIdRef.current;
    syncUserBrainsToFirestore(username, profileId, eco.fishes, true, currentCount + 1, {
      adminOverrideAtMs: eco.adminOverrideAtMs,
      removedFishIds: eco.removedFishIds,
    });

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
    const username = activeUsernameRef.current;
    const profileId = activeProfileIdRef.current;
    syncUserBrainsToFirestore(
      username,
      profileId,
      eco.fishes,
      true,
      eco.autoFeederCountByTank[tank.id] || 0,
      {
        adminOverrideAtMs: eco.adminOverrideAtMs,
        removedFishIds: eco.removedFishIds,
      }
    );
    showToast('Added a new pair of starter fishes to your aquarium.');
  };

  // Remove a single dead fish body from the aquarium AND completely delete it from database & Trainer
  const handleRemoveDeadFish = (fishId: string) => {
    const eco = ecosystemRef.current;
    const target = eco.fishes.find((f) => f.lineage.fishId === fishId);
    if (target && !target.lineage.alive) {
      const removedSet = new Set<string>(eco.removedFishIds || []);
      removedSet.add(fishId);
      eco.removedFishIds = Array.from(removedSet).slice(-200);

      const ackSet = new Set<string>(eco.acknowledgedDeadFishIds || []);
      ackSet.add(fishId);
      eco.acknowledgedDeadFishIds = Array.from(ackSet).slice(-200);

      // Completely delete from fishes and deceasedArchive so neither Game nor Trainer sees it
      eco.fishes = eco.fishes.filter((f) => f.lineage.fishId !== fishId);
      eco.deceasedArchive = eco.deceasedArchive.filter((d) => d.fishId !== fishId);
      const now = Date.now();
      eco.adminOverrideAtMs = now;
      eco.lastSavedAtMs = now;
      lastAppliedAdminOverrideMsRef.current = now;
      lastAppliedCloudUpdatedMsRef.current = now;

      saveEcosystemState(eco);
      setEcosystem({ ...eco });
      const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
      const username = activeUsernameRef.current;
      const profileId = activeProfileIdRef.current;
      syncUserBrainsToFirestore(
        username,
        profileId,
        eco.fishes,
        true,
        eco.autoFeederCountByTank[tank.id] || 0,
        {
          adminOverrideAtMs: now,
          lastAdminAction: `User removed dead fish [${target.lineage.name}]`,
          removedFishIds: eco.removedFishIds,
        }
      );
      showToast(`Removed deceased fish [${target.lineage.name}] completely from tank & cloud database.`);
    }
  };

  // Clear all dead fish bodies from the aquarium AND completely delete them from database & Trainer
  const handleClearAllDeadFishes = () => {
    const eco = ecosystemRef.current;
    const deadList = eco.fishes.filter((f) => !f.lineage.alive);
    if (deadList.length === 0) return;

    const removedSet = new Set<string>(eco.removedFishIds || []);
    const ackSet = new Set<string>(eco.acknowledgedDeadFishIds || []);
    for (const df of deadList) {
      removedSet.add(df.lineage.fishId);
      ackSet.add(df.lineage.fishId);
    }
    eco.removedFishIds = Array.from(removedSet).slice(-200);
    eco.acknowledgedDeadFishIds = Array.from(ackSet).slice(-200);

    // Completely remove from fishes and deceasedArchive so Trainer also never sees them
    eco.fishes = eco.fishes.filter((f) => f.lineage.alive);
    eco.deceasedArchive = [];
    const now = Date.now();
    eco.adminOverrideAtMs = now;
    eco.lastSavedAtMs = now;
    lastAppliedAdminOverrideMsRef.current = now;
    lastAppliedCloudUpdatedMsRef.current = now;

    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
    const username = activeUsernameRef.current;
    const profileId = activeProfileIdRef.current;
    syncUserBrainsToFirestore(
      username,
      profileId,
      eco.fishes,
      true,
      eco.autoFeederCountByTank[tank.id] || 0,
      {
        adminOverrideAtMs: now,
        lastAdminAction: `User removed ${deadList.length} dead fish body(s)`,
        removedFishIds: eco.removedFishIds,
      }
    );
    showToast(`Removed ${deadList.length} deceased fish(es) completely from tank & cloud database.`);
  };

  // Open the Rename Fish Console Dialog
  const handleOpenRenameFish = useCallback((fishId: string, currentName: string) => {
    setRenameDraft(currentName);
    setRenamingFishId(fishId);
  }, []);

  // Confirm and save a player's custom name for their fish
  const handleConfirmRenameFish = useCallback(
    (overrideName?: string) => {
      const targetId = renamingFishIdRef.current;
      if (!targetId) return;
      const raw = (overrideName !== undefined ? overrideName : renameDraft).trim();
      const cleaned = raw.slice(0, 24);
      if (!cleaned) {
        showToast('Please enter a name for your fish.');
        return;
      }
      const eco = ecosystemRef.current;
      const target = eco.fishes.find((f) => f.lineage.fishId === targetId);
      if (!target) {
        setRenamingFishId(null);
        return;
      }
      const oldName = target.lineage.name;
      target.lineage.name = cleaned;
      const now = Date.now();
      eco.adminOverrideAtMs = now;
      eco.lastSavedAtMs = now;
      lastAppliedAdminOverrideMsRef.current = now;
      lastAppliedCloudUpdatedMsRef.current = now;

      saveEcosystemStateAsync(eco, 200);
      setEcosystem({ ...eco });
      setRenamingFishId(null);
      audioEngine.playRenameChime();

      const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];
      const uName = mypc.info()?.profile?.name || 'Keeper';
      const pId = mypc.info()?.profile?.id || 'local-caretaker';
      syncUserBrainsToFirestore(
        uName,
        pId,
        eco.fishes,
        true,
        eco.autoFeederCountByTank[tank.id] || 0,
        {
          adminOverrideAtMs: now,
          lastAdminAction: `User renamed fish [${oldName}] -> [${cleaned}]`,
          removedFishIds: eco.removedFishIds,
        }
      );
      showToast(`Renamed "${oldName}" → "[${cleaned}]"!`);
    },
    [mypc, renameDraft, showToast]
  );

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

    const ackSet = new Set<string>(latest.acknowledgedDeadFishIds || []);
    const unwarnedDead = latest.fishes.filter(
      (f) => !f.lineage.alive && !ackSet.has(f.lineage.fishId)
    );
    if (unwarnedDead.length > 0) {
      for (const d of unwarnedDead) {
        ackSet.add(d.lineage.fishId);
      }
      latest.acknowledgedDeadFishIds = Array.from(ackSet).slice(-200);
      saveEcosystemStateAsync(latest, 200);
      showToast(
        `Warning: ${unwarnedDead.map((d) => d.lineage.name).join(', ')} died from ${
          unwarnedDead[0].lineage.causeOfDeath || 'starvation'
        } while away!`
      );
    }

    ecosystemRef.current = latest;
    setEcosystem({ ...latest });
    setScreenState('playing');
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
    if (renamingFishIdRef.current) {
      setRenamingFishId(null);
      return true;
    }
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
  // Respects MyPC OS Menu: Never intercepts input or steals focus when MyPC menu is open!
  // ============================================================================
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If the MyPC OS menu is open, do NOT intercept keys or steal focus from MyPC!
      if (isMypcSystemMenuActive()) {
        return;
      }

      const key = e.key || '';
      const code = e.code || '';
      const keyCode = e.keyCode || 0;

      // If the player is typing inside the Rename Fish text input, let typing keys work naturally
      const isTypingInInput =
        typeof document !== 'undefined' &&
        document.activeElement instanceof HTMLInputElement &&
        document.activeElement.type === 'text';

      if (isTypingInInput) {
        if (key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          handleConfirmRenameFish();
          return;
        }
        if (key === 'Escape' || keyCode === 10009) {
          e.preventDefault();
          e.stopPropagation();
          setRenamingFishId(null);
          return;
        }
        if (key === 'ArrowDown') {
          e.preventDefault();
          moveControllerFocus(1);
          return;
        }
        // Let Backspace, letters, Left/Right arrows edit the text input naturally
        return;
      }

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
        mypcSystemMenuOpenRef.current = false;
        toggleOwnerMenuFromController(
          isTvPlayPause
            ? 'TV Remote [Play/Pause] → Toggled Console HUD'
            : 'Controller [+ / Select / Start] → Toggled Console HUD'
        );
        return;
      }

      // 2. Back / Cancel / Escape / Tizen Return (10009 / 461)
      const isReturnOrBackKey =
        key === 'Escape' ||
        key === 'Backspace' ||
        key === 'BrowserBack' ||
        key === 'GoBack' ||
        key === 'XF86Back' ||
        keyCode === 10009 ||
        keyCode === 461;

      if (isReturnOrBackKey) {
        if (renamingFishIdRef.current || helpModalRef.current || settingsOpenRef.current) {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          cancelModalFromController();
          return;
        }
        // No in-game modal is open! The user pressed Return/Back to open the MyPC System Menu.
        // Yield focus and input completely to MyPC so the user can navigate MyPC and close the game!
        mypcSystemMenuOpenRef.current = true;
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
          const rootEl = document.getElementById('root');
          if (rootEl && rootEl.contains(document.activeElement)) {
            document.activeElement.blur();
          }
        }
        return;
      }

      // 3. Spatial D-Pad / Arrow navigation across top bar buttons (in playing mode) or modal buttons
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        moveControllerFocus(1);
        setLastControllerInputLabel('D-Pad [Right/Down] → Next Control');
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        moveControllerFocus(-1);
        setLastControllerInputLabel('D-Pad [Left/Up] → Previous Control');
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

    window.addEventListener('keydown', handleKeyDown, { capture: false });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: false });
  }, [
    activateFocusedControllerButton,
    cancelModalFromController,
    cycleSettingsTab,
    handleConfirmRenameFish,
    handleSprinkleFoodOnTop,
    isMypcSystemMenuActive,
    moveControllerFocus,
    toggleOwnerMenuFromController,
  ]);

  // Initialize MyPC SDK Lifecycle, Gamepad Listeners & Firestore Brain Sync
  useEffect(() => {
    mypc.init({
      ownMenu: false,
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
        const initUsername = info.profile?.name || 'Keeper';
        loadUserBrainsFromFirestore(initUsername).then((cloudRecord) => {
          if (
            cloudRecord &&
            Array.isArray(cloudRecord.fishBrains) &&
            cloudRecord.fishBrains.length > 0
          ) {
            const eco = ecosystemRef.current;
            const hasNewerAdminOverride =
              (cloudRecord.adminOverrideAtMs || 0) > (eco.adminOverrideAtMs || 0);
            applyCloudRecordToEcosystem(cloudRecord, hasNewerAdminOverride);
          }
        });

        mypc.setMenu([
          { id: 'feed', label: 'Sprinkle Food on Top' },
          { id: 'settings', label: 'Sanctuary Console HUD & Shop' },
          { id: 'restart', label: 'Reset Aquarium (2 Starter Fishes)' },
        ]);

        mypc.ready();
      },
      onStart: () => {
        mypcSystemMenuOpenRef.current = false;
      },
      onPause: () => {
        // MyPC System Menu opened (e.g. via Return button).
        // Yield 100% of focus & input to MyPC so the user can navigate MyPC and close/exit the game!
        mypcSystemMenuOpenRef.current = true;
        ecosystemRef.current.paused = true;
        audioEngine.pause();
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
          const rootEl = document.getElementById('root');
          if (rootEl && rootEl.contains(document.activeElement)) {
            document.activeElement.blur();
          }
        }
      },
      onResume: () => {
        mypcSystemMenuOpenRef.current = false;
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
        mypcSystemMenuOpenRef.current = false;
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
        // Never intercept input when MyPC OS menu is open!
        if (isMypcSystemMenuActive()) return;

        // Open/Toggle HUD on TV Remote "Play/Pause" (`play_pause` / `menu`)
        // or Gamepad `+` / `Select` / `Start` (`select` / `start` / `menu` / `run`)
        if (
          !repeat &&
          (action === 'menu' ||
            action === 'play_pause' ||
            action === 'select' ||
            action === 'start' ||
            action === 'run')
        ) {
          toggleOwnerMenuFromController(
            `Controller [${action.toUpperCase()}] → Toggled Console HUD`
          );
          return;
        }

        // Route D-Pad / Arrows & Confirm/Cancel to focusable buttons
        if (action === 'down' || action === 'right') {
          moveControllerFocus(1);
          setLastControllerInputLabel(`Controller [${action.toUpperCase()}] → Next Control`);
          return;
        }
        if (action === 'up' || action === 'left') {
          moveControllerFocus(-1);
          setLastControllerInputLabel(`Controller [${action.toUpperCase()}] → Prev Control`);
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
          if (renamingFishIdRef.current || helpModalRef.current || settingsOpenRef.current) {
            cancelModalFromController();
          } else {
            mypcSystemMenuOpenRef.current = true;
          }
          return;
        }
      },
    });

    if (mypc.gamepad) {
      mypc.gamepad.on(
        'button',
        (index: number, pressed: boolean, _value: number, _dev: string, name: string) => {
          if (!pressed) return;
          if (isMypcSystemMenuActive()) return;
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
              `Gamepad [${name || `Btn ${index}`}] → Toggled Console HUD`
            );
            return;
          }

          if (renamingFishIdRef.current || helpModalRef.current || settingsOpenRef.current) {
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
    isMypcSystemMenuActive,
    moveControllerFocus,
    mypc,
    showToast,
    toggleOwnerMenuFromController,
  ]);

  // 60Hz Simulation & Native HTML5 Gamepad Polling Callback
  const handleTickSimulation = useCallback(
    (dt: number) => {
      // Poll standard HTML5 navigator.getGamepads() ONLY when MyPC system menu is NOT open
      if (
        !isMypcSystemMenuActive() &&
        typeof navigator !== 'undefined' &&
        typeof navigator.getGamepads === 'function'
      ) {
        const pads = navigator.getGamepads();
        const pad = pads && (pads[0] || pads[1] || pads[2] || pads[3]);
        if (pad && pad.buttons) {
          const prev = prevGamepadButtonsRef.current;
          for (let b = 0; b < pad.buttons.length; b++) {
            const isDown = Boolean(pad.buttons[b]?.pressed);
            const wasDown = Boolean(prev[b]);
            if (isDown && !wasDown) {
              if (b === 8 || b === 9) {
                toggleOwnerMenuFromController(
                  b === 9
                    ? 'Gamepad [Start / +] → Toggled Console HUD'
                    : 'Gamepad [Select / -] → Toggled Console HUD'
                );
              } else if (
                renamingFishIdRef.current ||
                helpModalRef.current ||
                settingsOpenRef.current
              ) {
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
                  toggleOwnerMenuFromController('Gamepad [X / Y] → Toggled Console HUD');
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

      // Low-Resource TV Optimization: Pause background neural simulation & periodic React DOM re-renders
      // while any menu modal is open so TV remote / D-pad navigation has zero CPU or layout lag!
      if (
        screenStateRef.current !== 'playing' ||
        settingsOpenRef.current ||
        Boolean(renamingFishIdRef.current) ||
        Boolean(helpModalRef.current) ||
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
      if (!settingsOpenRef.current && !isMypcSystemMenuActive() && mypc.gamepad) {
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
          const username = activeUsernameRef.current;
          const profileId = activeProfileIdRef.current;
          const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
          syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount, {
            adminOverrideAtMs: eco.adminOverrideAtMs,
            removedFishIds: eco.removedFishIds,
          });
          showToast(
            `${mother.lineage.name} naturally hatched baby ${child.lineage.name} (Gen ${child.lineage.generation})!`
          );
        },
        onDeath: (fish, reason) => {
          const ackSet = new Set<string>(eco.acknowledgedDeadFishIds || []);
          const alreadyWarned = ackSet.has(fish.lineage.fishId);
          ackSet.add(fish.lineage.fishId);
          eco.acknowledgedDeadFishIds = Array.from(ackSet).slice(-200);

          saveEcosystemStateAsync(eco, 400);
          setEcosystem({ ...eco });
          const username = activeUsernameRef.current;
          const profileId = activeProfileIdRef.current;
          const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
          syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount, {
            adminOverrideAtMs: eco.adminOverrideAtMs,
            removedFishIds: eco.removedFishIds,
          });
          if (!alreadyWarned) {
            audioEngine.playDeathWarningTone();
            showToast(`${fish.lineage.name} passed away from ${reason}.`);
          }
        },
      });

      const nowMs = performance.now();
      if (nowMs - lastHudSyncMsRef.current > 3500) {
        lastHudSyncMsRef.current = nowMs;
        setEcosystem({ ...eco });
      }

      if (nowMs - lastLocalSaveMsRef.current > 25000) {
        lastLocalSaveMsRef.current = nowMs;
        saveEcosystemStateAsync(eco, 900);
      }

      if (nowMs - lastFirestoreSyncMsRef.current > FIRESTORE_CHECKPOINT_INTERVAL_MS) {
        lastFirestoreSyncMsRef.current = nowMs;
        const username = activeUsernameRef.current;
        const profileId = activeProfileIdRef.current;
        const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
        syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount, {
          adminOverrideAtMs: eco.adminOverrideAtMs,
          removedFishIds: eco.removedFishIds,
        });
      }
    },
    [
      activateFocusedControllerButton,
      applyCloudRecordToEcosystem,
      cancelModalFromController,
      cycleSettingsTab,
      handleSprinkleFoodOnTop,
      handleStartAquarium,
      isMypcSystemMenuActive,
      moveControllerFocus,
      mypc,
      showToast,
      toggleOwnerMenuFromController,
    ]
  );

  const handleFpsUpdate = useCallback((nextFps: number) => {
    // Do not trigger React state re-renders for FPS while inside menus on low-resource TV
    if (
      settingsOpenRef.current ||
      Boolean(renamingFishIdRef.current) ||
      Boolean(helpModalRef.current)
    ) {
      return;
    }
    if (!ecosystemRef.current.graphicsSettings?.showFps) {
      return;
    }
    setFps((prev) => (prev === nextFps ? prev : nextFps));
  }, []);

  const lang = mypcInfo.lang || 'en';
  const t = I18N[lang] || I18N.en;
  const username = mypcInfo.profile?.name || mypc.info()?.profile?.name || 'Keeper';
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

  const isAnyMenuModalOpen =
    settingsOpen || Boolean(renamingFishId) || Boolean(helpModalTopic) || screenState === 'paused';

  return (
    <div
      dir={mypcInfo.rtl ? 'rtl' : 'ltr'}
      onPointerDown={() => {
        mypcSystemMenuOpenRef.current = false;
      }}
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
        isMenuOpen={isAnyMenuModalOpen}
        onTickSimulation={handleTickSimulation}
        onPolygonStatsUpdate={setPolyStats}
        onFpsUpdate={handleFpsUpdate}
      />

      {/* Top-Right FPS Overlay when enabled from Settings */}
      {isShowFpsEnabled && screenState !== 'playing' && !isAnyMenuModalOpen && (
        <div
          data-testid="fps-counter-overlay"
          className="fixed top-4 right-5 z-50 pointer-events-none px-3 py-1.5 rounded bg-[#06101e] border border-emerald-400 text-xs font-mono font-bold tabular-nums flex items-center gap-2"
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
          className="fixed inset-0 z-20 flex flex-col justify-between p-8 sm:p-12 pointer-events-none bg-gradient-to-r from-[#030914] via-[#030914]/70 to-transparent"
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
              the top water surface, level up as{' '}
              <span className="text-cyan-300 font-semibold">{username}</span> to unlock famous
              species in the shop, and upgrade your tank from 3 up to 6 fishes (+ babies).
            </p>

            <div className="flex flex-wrap items-center gap-3.5 pt-2">
              <button
                type="button"
                data-start="true"
                data-tv-focusable="true"
                onClick={handleStartAquarium}
                className="px-7 py-3.5 text-sm font-bold bg-cyan-400 text-slate-950 rounded hover:bg-cyan-300 whitespace-nowrap"
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
                className="px-5 py-3.5 text-sm font-semibold bg-[#0c192c] text-amber-300 border border-amber-400 rounded hover:bg-[#132642] whitespace-nowrap"
              >
                Aquarium Shop &amp; Tanks
              </button>
            </div>
          </div>

          <div className="text-xs font-mono text-slate-300">
            TV Remote: [Play/Pause] Open Console HUD · [OK] Feed Top · Gamepad: [+ / Select / Start]
            Open HUD · [A] Feed
          </div>
        </div>
      )}

      {/* STATE 2: UNIFIED LIVING AQUARIUM / SCREENSAVER VIEW */}
      {screenState === 'playing' && !isAnyMenuModalOpen && (
        <div
          data-modal-scope="hud"
          className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-between p-5"
        >
          {/* Minimal Top Bar: Tank Space, Fish Date & Time, Owner Level & Credits on Left; Actions on Right */}
          <div className="w-full flex flex-wrap items-start justify-between gap-4">
            <div className="pointer-events-auto px-3.5 py-2 rounded bg-[#050e1c] border border-cyan-500 text-xs font-mono text-slate-200 tabular-nums flex flex-wrap items-center gap-2.5">
              <span className="text-cyan-300 font-bold tracking-wide">{currentTank.name}</span>
              <span className="text-slate-600">|</span>
              <span>
                Space: {adultFishes.length}/{currentTank.maxFishCapacity} Fishes
                {babyFishes.length > 0 ? ` (+${babyFishes.length} Babies)` : ''}
                {deadFishes.length > 0 ? ` · ${deadFishes.length} Dead` : ''}
              </span>
              <span className="text-slate-600">|</span>
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
                      ? 'bg-[#082f49] border-sky-400 text-sky-200'
                      : 'bg-[#451a03] border-amber-400 text-amber-200'
                  }`}
                >
                  {isUsingSolarDaylight
                    ? 'DAYLIGHT'
                    : isDaylightModeOn
                    ? 'NIGHT · BULB LIGHTS'
                    : 'BULB LIGHTS'}
                </span>
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-violet-300 font-semibold">
                {username} Lv.{ownerLevel} ({ownerXp}/100 XP)
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-emerald-300">Gen {highestGeneration}</span>
              <span className="text-slate-600">|</span>
              <span className="text-amber-300 font-bold">
                {Math.round(ecosystem.bioCredits)} CR
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
                className={`px-4 py-2 rounded bg-amber-400 text-slate-950 text-xs font-extrabold tracking-wide hover:bg-amber-300 whitespace-nowrap ${
                  focusedBtnIndex === 0 ? 'outline-2 outline-white' : ''
                }`}
              >
                + FEED TOP [OK / A]
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onFocus={() => {
                  focusedBtnIndexRef.current = 1;
                  setFocusedBtnIndex(1);
                }}
                onClick={() => {
                  setSettingsOpen(true);
                }}
                className={`px-3.5 py-2 rounded bg-[#051020] border-2 border-cyan-400 text-xs font-bold tracking-wide text-cyan-200 hover:bg-[#0a1c36] whitespace-nowrap ${
                  focusedBtnIndex === 1 ? 'outline-2 outline-white' : ''
                }`}
              >
                CONSOLE HUD [{username.toUpperCase()}]
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
                className={`p-2 rounded bg-[#051020] border border-slate-700 text-slate-200 hover:border-cyan-400 ${
                  focusedBtnIndex === 2 ? 'outline-2 outline-white' : ''
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
                  className="px-3 py-2 rounded bg-[#06101e] border border-emerald-400 text-xs font-mono font-bold tabular-nums flex items-center gap-1.5 whitespace-nowrap"
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
            <div className="pointer-events-auto mx-auto max-w-3xl w-full px-4 py-3 rounded bg-[#4c0519] border-2 border-rose-500 text-xs text-rose-100 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-bold text-rose-300 uppercase tracking-wide">
                  [WARNING] {deadFishes.length} Fish{deadFishes.length > 1 ? 'es' : ''} Found Dead
                  in Tank ({deadFishes.map((f) => `[${f.lineage.name}]`).join(', ')})
                </div>
                <div className="text-[11px] text-rose-200 font-mono mt-0.5">
                  Cause of Death:{' '}
                  {deadFishes
                    .map((f) => (f.lineage.causeOfDeath || 'starvation').toUpperCase())
                    .join(', ')}{' '}
                  · Click &ldquo;Remove Dead Body&rdquo; to permanently delete from tank &amp; cloud
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
                  className="px-3 py-1.5 rounded bg-rose-700 border border-rose-300 text-white font-bold"
                >
                  Inspect Dead Fish
                </button>
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={handleClearAllDeadFishes}
                  className="px-3 py-1.5 rounded bg-slate-900 border border-emerald-400 text-emerald-200 font-bold"
                >
                  Remove Dead Body
                </button>
              </div>
            </div>
          )}

          {/* Toast Feedback Banner */}
          {toastMessage && (
            <div className="mx-auto px-4 py-2 rounded bg-[#051020] border-2 border-cyan-400 text-xs font-mono font-bold text-cyan-200 tracking-wide">
              {toastMessage}
            </div>
          )}

          {/* Subtle Bottom Ambient Hint */}
          <div className="w-full flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-300">
            <span>
              Water: {Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}% ·
              Temp: {ecosystem.evolutionConfig.environment.temperatureC.toFixed(1)}°C · Auto-Feeder:{' '}
              {ecosystem.autoFeederCountByTank[currentTank.id] || 0}/{currentTank.maxAutoFeeders} ·
              Cloud Live Sync Active (12s)
            </span>
            <span>{lastControllerInputLabel}</span>
          </div>
        </div>
      )}

      {/* ULTRA-LITE TV CONSOLE GAME HUD MENU (100% Solid Opaque Colors, Zero Box-Shadows, WebGL Paused Behind Menu) */}
      {settingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${username}'s Console Game HUD`}
          data-modal-scope="settings"
          className="fixed inset-0 z-30 flex items-center justify-center bg-[#02060d] p-2 sm:p-4 pointer-events-auto"
        >
          <div className="w-full max-w-6xl h-[94vh] flex flex-col rounded-lg bg-[#040c1a] border-2 border-cyan-400 overflow-hidden text-slate-100">
            {/* TOP CONSOLE HUD STATUS BAR */}
            <div className="px-4 py-2.5 bg-[#061328] border-b-2 border-cyan-500 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-[#0a2246] border border-cyan-400 flex items-center justify-center text-cyan-300 font-mono font-extrabold text-xs">
                  AE
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-400 font-bold">
                      ABYSSAL EVO v1.7.9 // TV LITE HUD
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-[#062e22] border border-emerald-400 text-[10px] font-mono font-bold text-emerald-300">
                      CLOUD SYNC
                    </span>
                  </div>
                  <h2 className="text-sm sm:text-base font-extrabold tracking-wide text-white uppercase">
                    {username}&rsquo;s Aquarium Command Deck
                  </h2>
                </div>
              </div>

              {/* Player Level, XP Bar, Credits, Sim Clock & Resume Button */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="px-2.5 py-1 rounded bg-[#030914] border border-violet-400 flex items-center gap-2">
                  <span className="text-xs font-mono font-extrabold text-violet-300">
                    {username.toUpperCase()} LV.{ownerLevel}
                  </span>
                  <span className="text-[10px] font-mono text-slate-300">({ownerXp}/100 XP)</span>
                </div>

                <div className="px-2.5 py-1 rounded bg-[#030914] border border-amber-400 flex items-center gap-1.5 font-mono">
                  <span className="text-xs font-extrabold text-amber-300 tabular-nums">
                    {Math.round(ecosystem.bioCredits)} CR
                  </span>
                </div>

                <div className="hidden md:flex px-2.5 py-1 rounded bg-[#030914] border border-sky-400 items-center gap-1.5 text-xs font-mono text-sky-200 tabular-nums">
                  <span>DAY {fishSimDay}</span>
                  <span>·</span>
                  <span>{formattedFishTime}</span>
                </div>

                <div className="px-2 py-1 rounded bg-[#030914] border border-emerald-500 text-xs font-mono font-bold text-emerald-300 tabular-nums">
                  {fps} FPS
                </div>

                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setSettingsOpen(false)}
                  className="px-3.5 py-1 rounded bg-[#4c0519] border-2 border-rose-400 text-xs font-mono font-extrabold text-rose-100 uppercase tracking-wider"
                >
                  [B / PLAY] RESUME
                </button>
              </div>
            </div>

            {/* MAIN 2-COLUMN CONSOLE SPLIT BODY */}
            <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
              {/* LEFT COMMAND RAIL: VERTICAL SIDE TABS & QUICK ACTIONS */}
              <div className="w-full md:w-56 shrink-0 bg-[#050f20] border-b md:border-b-0 md:border-r-2 border-cyan-600 p-2.5 flex flex-row md:flex-col justify-between gap-2 overflow-x-auto md:overflow-visible">
                <div className="flex flex-row md:flex-col gap-2 w-full">
                  <div className="hidden md:flex items-center justify-between px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-slate-400 border-b border-slate-800 mb-1">
                    <span>[LB]</span>
                    <span className="text-cyan-400 font-bold">MENU TABS</span>
                    <span>[RB]</span>
                  </div>

                  {/* Side Tab 01: FISHES */}
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setSettingsTab('fish_stats')}
                    className={`w-full px-3 py-2.5 rounded text-left font-mono border-l-4 flex items-center justify-between gap-2 ${
                      settingsTab === 'fish_stats'
                        ? 'bg-[#0a2748] border-cyan-300 text-white'
                        : 'bg-[#08172e] border-transparent text-slate-300'
                    }`}
                  >
                    <div>
                      <div className="text-[10px] text-cyan-400 font-bold">01 // ROSTER</div>
                      <div className="text-xs sm:text-sm font-extrabold uppercase">FISHES</div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded bg-[#030914] border border-cyan-500 text-xs font-bold text-cyan-300 tabular-nums">
                      {aliveFishes.length}/{currentTank.maxFishCapacity}
                    </span>
                  </button>

                  {/* Side Tab 02: SHOP */}
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setSettingsTab('aquarium_shop')}
                    className={`w-full px-3 py-2.5 rounded text-left font-mono border-l-4 flex items-center justify-between gap-2 ${
                      settingsTab === 'aquarium_shop'
                        ? 'bg-[#3b2106] border-amber-300 text-white'
                        : 'bg-[#08172e] border-transparent text-slate-300'
                    }`}
                  >
                    <div>
                      <div className="text-[10px] text-amber-400 font-bold">02 // ARMORY</div>
                      <div className="text-xs sm:text-sm font-extrabold uppercase">SHOP &amp; TANKS</div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded bg-[#030914] border border-amber-500 text-xs font-bold text-amber-300 tabular-nums">
                      {Math.round(ecosystem.bioCredits)}
                    </span>
                  </button>

                  {/* Side Tab 03: GRAPHICS */}
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setSettingsTab('graphics_polygons')}
                    className={`w-full px-3 py-2.5 rounded text-left font-mono border-l-4 flex items-center justify-between gap-2 ${
                      settingsTab === 'graphics_polygons'
                        ? 'bg-[#062e22] border-emerald-300 text-white'
                        : 'bg-[#08172e] border-transparent text-slate-300'
                    }`}
                  >
                    <div>
                      <div className="text-[10px] text-emerald-400 font-bold">03 // ENGINE</div>
                      <div className="text-xs sm:text-sm font-extrabold uppercase">3D &amp; LIGHTS</div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded bg-[#030914] border border-emerald-500 text-[10px] font-bold text-emerald-300 uppercase">
                      {currentPolyQuality.replace('_', ' ')}
                    </span>
                  </button>
                </div>

                {/* Quick Command Deck Actions on Bottom of Left Rail */}
                <div className="hidden md:flex flex-col gap-1.5 pt-2.5 border-t border-slate-800">
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={handleSprinkleFoodOnTop}
                    className="w-full py-2 px-2.5 rounded bg-amber-400 text-slate-950 text-xs font-mono font-extrabold uppercase text-left flex items-center justify-between"
                  >
                    <span>+ FEED TOP</span>
                    <span>[OK]</span>
                  </button>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={handleCleanAquariumWater}
                    className="w-full py-2 px-2.5 rounded bg-[#091d38] border border-cyan-500 text-cyan-200 text-xs font-mono font-bold uppercase text-left flex items-center justify-between"
                  >
                    <span>CLEAN WATER</span>
                    <span>{Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}%</span>
                  </button>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setHelpModalTopic(HELP_TOPICS.controller_remote)}
                    className="w-full py-2 px-2.5 rounded bg-[#081528] border border-slate-700 text-slate-300 text-xs font-mono font-bold uppercase text-left flex items-center justify-between"
                  >
                    <span>? TV REMOTE</span>
                    <span>HELP</span>
                  </button>
                </div>
              </div>

              {/* RIGHT MAIN TACTICAL VIEWPORT */}
              <div className="flex-1 overflow-y-auto lab-scroll p-3.5 sm:p-4 bg-[#040b17] space-y-3.5">
                {/* TAB 01: MY FISHES (WITH RENAME BUTTON & SINGLE-NODE LITE PROGRESS BARS) */}
                {settingsTab === 'fish_stats' && (
                  <div className="space-y-3.5">
                    <div className="p-3 rounded-lg bg-[#071529] border border-cyan-500 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                          01 // ACTIVE SPECIMENS · {currentTank.name.toUpperCase()}
                        </div>
                        <h3 className="text-sm font-extrabold text-white">
                          Adult Space: {adultFishes.length}/{currentTank.maxFishCapacity} Fishes
                          {babyFishes.length > 0 ? ` (+${babyFishes.length} Babies)` : ''}
                          {deadFishes.length > 0 ? ` · ${deadFishes.length} Dead` : ''}
                        </h3>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleSprinkleFoodOnTop}
                          className="px-3 py-1.5 rounded bg-amber-400 text-slate-950 text-xs font-mono font-extrabold uppercase"
                        >
                          + DROP PELLETS
                        </button>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => setHelpModalTopic(HELP_TOPICS.ai_breeding)}
                          className="px-2.5 py-1.5 rounded bg-[#0a2246] border border-cyan-400 text-cyan-200 text-xs font-mono font-bold"
                        >
                          ? BREEDING
                        </button>
                      </div>
                    </div>

                    {adultFishes.length > currentTank.maxFishCapacity && (
                      <div className="p-2.5 rounded bg-[#3b2106] border border-amber-400 text-xs font-mono text-amber-200">
                        [CAPACITY NOTICE] Babies matured over tank capacity ({adultFishes.length}/
                        {currentTank.maxFishCapacity}). Upgrade tank in [02 // SHOP &amp; TANKS] to
                        resume breeding.
                      </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      {ecosystem.fishes.map((fish) => {
                        const sp =
                          ecosystem.speciesList.find((s) => s.id === fish.lineage.speciesId) ||
                          DEFAULT_SPECIES_LIST[0];
                        const isDead = !fish.lineage.alive;
                        const energyPct = isDead
                          ? 0
                          : Math.round(Math.max(0, Math.min(100, fish.state.energy)));
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
                            className={`p-3.5 rounded-lg border-2 space-y-2.5 ${
                              isDead
                                ? 'bg-[#090d16] border-rose-600'
                                : 'bg-[#071426] border-cyan-600'
                            }`}
                          >
                            {/* Card Header: Species Gem, Name, Gen Badge & RENAME Button */}
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-3.5 h-3.5 rounded-sm shrink-0 border border-white"
                                  style={{
                                    backgroundColor: isDead ? '#64748b' : sp.primaryColorHex,
                                  }}
                                />
                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={`text-sm font-extrabold ${
                                        isDead ? 'text-slate-400 line-through' : 'text-white'
                                      }`}
                                    >
                                      {fish.lineage.name}
                                    </span>
                                    <span className="px-1.5 py-0.5 rounded bg-[#0a2246] border border-cyan-400 text-[10px] font-mono font-bold text-cyan-300">
                                      GEN {fish.lineage.generation}
                                    </span>
                                  </div>
                                  <div className="text-[11px] font-mono text-slate-400">
                                    {sp.name} · {fish.lineage.modelVersion}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  data-tv-focusable="true"
                                  onClick={() =>
                                    handleOpenRenameFish(fish.lineage.fishId, fish.lineage.name)
                                  }
                                  className="px-2.5 py-1 rounded bg-[#0a2246] border border-cyan-400 text-[11px] font-mono font-extrabold text-cyan-200 hover:bg-cyan-400 hover:text-slate-950 uppercase"
                                >
                                  RENAME
                                </button>
                                <span
                                  className={`px-2 py-1 rounded text-[10px] font-mono font-extrabold uppercase ${
                                    isDead
                                      ? 'bg-[#4c0519] text-rose-200 border border-rose-500'
                                      : fish.state.isGravid
                                      ? 'bg-[#3b2106] text-amber-300 border border-amber-400'
                                      : 'bg-[#062e22] text-emerald-300 border border-emerald-500'
                                  }`}
                                >
                                  {isDead
                                    ? `DEAD (${(fish.lineage.causeOfDeath || 'starved').toUpperCase()})`
                                    : fish.state.isGravid
                                    ? 'GRAVID'
                                    : fish.state.lifeStage}
                                </span>
                              </div>
                            </div>

                            {/* Single-Node Lite Energy & Comfort Bars (Fast on Low-Resource TV) */}
                            <div className="grid grid-cols-2 gap-2.5 text-xs font-mono">
                              <div>
                                <div className="flex justify-between mb-1 text-[11px]">
                                  <span className="text-slate-400">ENERGY</span>
                                  <span
                                    className={
                                      isDead || energyPct < 30
                                        ? 'text-rose-400 font-bold'
                                        : 'text-emerald-300 font-bold'
                                    }
                                  >
                                    {isDead ? '0%' : `${energyPct}%`}
                                  </span>
                                </div>
                                <div className="w-full h-2 bg-[#02060d] rounded overflow-hidden">
                                  <div
                                    className={`h-full ${
                                      isDead || energyPct < 30 ? 'bg-rose-500' : 'bg-emerald-400'
                                    }`}
                                    style={{ width: `${energyPct}%` }}
                                  />
                                </div>
                              </div>

                              <div>
                                <div className="flex justify-between mb-1 text-[11px]">
                                  <span className="text-slate-400">COMFORT</span>
                                  <span className="text-cyan-300 font-bold">{satisfaction}%</span>
                                </div>
                                <div className="w-full h-2 bg-[#02060d] rounded overflow-hidden">
                                  <div
                                    className="h-full bg-cyan-400"
                                    style={{ width: `${satisfaction}%` }}
                                  />
                                </div>
                              </div>
                            </div>

                            {/* Compact Telemetry Line */}
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono text-slate-300 tabular-nums">
                              <span>
                                AGE: <strong className="text-white">{fish.state.ageSimHours.toFixed(1)}h</strong>/{sp.lifespan.lifespanSimHours}h
                              </span>
                              <span>
                                FED: <strong className="text-amber-300">{fish.state.metrics.foodPelletsEaten}</strong>
                              </span>
                              <span>
                                BABIES: <strong className="text-cyan-300">{fish.state.metrics.offspringProduced}</strong>
                              </span>
                              <span>
                                SPD: <strong className="text-emerald-300">{fish.genetics.maxSpeedGene}x</strong>
                              </span>
                            </div>

                            {isDead && (
                              <div className="pt-2 border-t border-rose-800 flex items-center justify-between gap-2">
                                <span className="text-[11px] font-mono text-rose-300">
                                  CAUSE: {(fish.lineage.causeOfDeath || 'starvation').toUpperCase()}
                                </span>
                                <button
                                  type="button"
                                  data-tv-focusable="true"
                                  onClick={() => handleRemoveDeadFish(fish.lineage.fishId)}
                                  className="px-3 py-1 rounded bg-rose-700 border border-rose-300 text-xs font-mono font-bold text-white uppercase"
                                >
                                  REMOVE BODY
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {aliveFishes.length < 2 && (
                      <div className="p-3.5 rounded-lg bg-[#3b2106] border-2 border-amber-400 flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs font-mono text-amber-200">
                          [LOW POPULATION] Fewer than 2 live fishes remain. Deploy a starter pair!
                        </span>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleRestockStarterPair}
                          className="px-4 py-2 rounded bg-amber-400 text-slate-950 text-xs font-mono font-extrabold uppercase"
                        >
                          DEPLOY 2 STARTER FISHES (FREE)
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 02: SHOP & TANKS */}
                {settingsTab === 'aquarium_shop' && (
                  <div className="space-y-4">
                    {/* Top Life-Support & Auto-Feeder Module */}
                    <div className="p-3.5 rounded-lg bg-[#071529] border-2 border-cyan-500 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                          LIFE-SUPPORT &amp; 24/7 KEEPER HARDWARE
                        </div>
                        <div className="text-sm font-extrabold text-white mt-0.5">
                          Water Purity:{' '}
                          {Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}% ·
                          Auto-Feeders:{' '}
                          {ecosystem.autoFeederCountByTank[currentTank.id] || 0}/
                          {currentTank.maxAutoFeeders}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleCleanAquariumWater}
                          className="px-3 py-1.5 rounded bg-cyan-400 text-slate-950 text-xs font-mono font-extrabold uppercase"
                        >
                          PURIFY WATER (+12 XP)
                        </button>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleBuyAutoFeeder}
                          className="px-3 py-1.5 rounded bg-emerald-400 text-slate-950 text-xs font-mono font-extrabold uppercase"
                        >
                          BUY AUTO-FEEDER (75 CR)
                        </button>
                      </div>
                    </div>

                    {/* Species Unlock Roster */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-wider text-amber-400 font-bold">
                            SPECIES ROSTER // TANK SPACE {aliveFishes.length}/
                            {currentTank.maxFishCapacity}
                          </div>
                          <h3 className="text-sm font-extrabold text-white">
                            Buy Fishes ({username} Lv.{ownerLevel})
                          </h3>
                        </div>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => setHelpModalTopic(HELP_TOPICS.owner_level_shop)}
                          className="px-2.5 py-1 rounded bg-[#0a2246] border border-cyan-400 text-cyan-200 text-xs font-mono font-bold"
                        >
                          ? SHOP INFO
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                        {sortedShopSpecies.map((sp) => {
                          const reqLv = sp.requiredOwnerLevel || 1;
                          const price = sp.shopPriceCredits || 45;
                          const unlockedByLevel = ownerLevel >= reqLv;
                          const hasSpace = aliveFishes.length < currentTank.maxFishCapacity;
                          const canAfford = ecosystem.bioCredits >= price;

                          return (
                            <div
                              key={sp.id}
                              className={`p-3 rounded-lg border-2 flex flex-col justify-between gap-2.5 ${
                                unlockedByLevel
                                  ? 'bg-[#071426] border-cyan-600'
                                  : 'bg-[#040a14] border-slate-800'
                              }`}
                            >
                              <div>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className="w-3 h-3 rounded-sm shrink-0 border border-white"
                                      style={{ backgroundColor: sp.primaryColorHex }}
                                    />
                                    <span className="text-xs font-extrabold text-white uppercase">
                                      {sp.name}
                                    </span>
                                  </div>
                                  <span className="text-xs font-mono text-amber-300 font-extrabold">
                                    {price} CR
                                  </span>
                                </div>
                                <div className="text-[10px] font-mono text-cyan-300 mt-1">
                                  REQ LV.{reqLv} · LIFE {sp.lifespan.lifespanSimHours}H
                                </div>
                              </div>

                              <button
                                type="button"
                                data-tv-focusable="true"
                                onClick={() => handleBuyFishFromShop(sp)}
                                className={`w-full py-1.5 px-2.5 rounded text-xs font-mono font-extrabold uppercase ${
                                  !unlockedByLevel
                                    ? 'bg-slate-900 text-slate-500 border border-slate-800'
                                    : !hasSpace
                                    ? 'bg-slate-900 text-amber-300 border border-amber-500'
                                    : canAfford
                                    ? 'bg-cyan-400 text-slate-950'
                                    : 'bg-slate-800 text-slate-300'
                                }`}
                              >
                                {!unlockedByLevel
                                  ? `LOCKED (LV.${reqLv})`
                                  : !hasSpace
                                  ? `TANK FULL (${currentTank.maxFishCapacity}/${currentTank.maxFishCapacity})`
                                  : `BUY FISH (${price} CR)`}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Tank Expansion Upgrades */}
                    <div className="space-y-2.5 pt-2.5 border-t border-slate-800">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                        TANK EXPANSION // 3 → 4 → 5 → 6 ADULT CAPACITY
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {TANK_TIERS.map((tier) => {
                          const unlocked = ecosystem.unlockedTankTiers.includes(tier.tierIndex);
                          const isCurrent = ecosystem.activeTankTier === tier.tierIndex;
                          return (
                            <div
                              key={tier.id}
                              className={`p-3.5 rounded-lg border-2 flex flex-col justify-between ${
                                isCurrent
                                  ? 'bg-[#09223c] border-cyan-400'
                                  : unlocked
                                  ? 'bg-[#071426] border-slate-700'
                                  : 'bg-[#040b16] border-slate-800'
                              }`}
                            >
                              <div>
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-extrabold text-white uppercase">
                                    {tier.name}
                                  </span>
                                  <span className="text-xs font-mono font-bold text-amber-300">
                                    {unlocked ? 'OWNED' : `${tier.costCredits} CR`}
                                  </span>
                                </div>
                                <div className="text-xs font-mono text-cyan-300 mt-0.5">
                                  CAPACITY: {tier.maxFishCapacity} ADULT FISHES (+ BABIES)
                                </div>
                              </div>

                              <button
                                type="button"
                                data-tv-focusable="true"
                                onClick={() => handleBuyOrSelectTank(tier.tierIndex)}
                                className={`mt-3 w-full py-1.5 rounded text-xs font-mono font-extrabold uppercase ${
                                  isCurrent
                                    ? 'bg-[#0a2748] text-cyan-200 border border-cyan-400'
                                    : unlocked
                                    ? 'bg-cyan-400 text-slate-950'
                                    : 'bg-amber-400 text-slate-950'
                                }`}
                              >
                                {isCurrent
                                  ? `ACTIVE TANK (${tier.maxFishCapacity} SPACE)`
                                  : unlocked
                                  ? `USE TANK (${tier.maxFishCapacity} SPACE)`
                                  : `UNLOCK TANK (${tier.costCredits} CR)`}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 03: LIGHTS & 3D ENGINE QUALITY (Graphics Quality First!) */}
                {settingsTab === 'graphics_polygons' && (
                  <div className="space-y-3.5">
                    {/* 1. FIRST IN TAB: 3D Fish Polygon Quality & Top-Right FPS Counter Toggle */}
                    <div className="p-3.5 rounded-lg bg-[#071529] border-2 border-cyan-400 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                            01 // 3D MESH QUALITY &amp; FPS COUNTER
                          </div>
                          <div className="text-xs font-bold text-white">
                            Active Mesh: {polyStats.trianglesPerFish.toLocaleString()} Tris/Fish (
                            {polyStats.totalFishTriangles.toLocaleString()} Total)
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 rounded bg-[#030914] border border-emerald-500 text-xs font-mono font-bold text-emerald-300 tabular-nums">
                            {fps} FPS
                          </span>
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={handleToggleShowFps}
                            className={`px-3 py-1.5 rounded text-xs font-mono font-extrabold uppercase ${
                              isShowFpsEnabled
                                ? 'bg-emerald-400 text-slate-950'
                                : 'bg-slate-800 text-slate-200 border border-slate-700'
                            }`}
                          >
                            {isShowFpsEnabled ? 'SHOW FPS: ON' : 'SHOW FPS: OFF'}
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {(
                          [
                            ['very_low', 'VERY LOW', '~140 Tris (TV Max)'],
                            ['low', 'LOW', '~420 Tris (TV Fast)'],
                            ['medium', 'MEDIUM', '~1,380 Tris'],
                            ['high', 'HIGH', '~2,950 Tris'],
                            ['ultra', 'ULTRA', '~6,800 Tris'],
                          ] as Array<[FishPolygonQuality, string, string]>
                        ).map(([qId, label, sub]) => (
                          <button
                            key={qId}
                            type="button"
                            data-tv-focusable="true"
                            onClick={() => handleUpdatePolygonQuality(qId)}
                            className={`p-2.5 rounded border-2 text-left font-mono ${
                              currentPolyQuality === qId
                                ? 'bg-[#0a2748] border-cyan-300 text-white'
                                : 'bg-[#040a14] border-slate-800 text-slate-300'
                            }`}
                          >
                            <div className="text-xs font-extrabold">{label}</div>
                            <div className="text-[10px] text-cyan-300 mt-0.5">{sub}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 2. Daylight Mode (ON / OFF) & Night Bulb Lights */}
                    <div className="p-3.5 rounded-lg bg-[#071529] border-2 border-amber-400 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-wider text-amber-400 font-bold">
                            02 // SOLAR DAYLIGHT &amp; NIGHT BULB LIGHTS
                          </div>
                          <div className="text-xs text-slate-300">
                            Daylight ON uses solar light by day and warm bulb lights at night.
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            data-tv-focusable="true"
                            onClick={handleToggleDaylightMode}
                            className={`px-3.5 py-1.5 rounded text-xs font-mono font-extrabold uppercase ${
                              isDaylightModeOn
                                ? 'bg-sky-400 text-slate-950'
                                : 'bg-amber-400 text-slate-950'
                            }`}
                          >
                            {isDaylightModeOn
                              ? 'DAYLIGHT: ON (AUTO NIGHT BULBS)'
                              : 'DAYLIGHT: OFF (BULBS ONLY)'}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800 text-xs font-mono">
                        <span className="text-slate-300">
                          CLOCK: {formattedFishDate} · {formattedFishTime} (DAY {fishSimDay})
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(
                            [
                              ['auto', 'AUTO CLOCK'],
                              ['day', 'FORCE DAY'],
                              ['night', 'FORCE NIGHT'],
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
                              className={`px-2.5 py-1 rounded border text-xs font-bold ${
                                currentTimeOverride === modeId
                                  ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                  : 'bg-[#040a14] text-slate-300 border-slate-800'
                              }`}
                            >
                              {modeLabel}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* 3. Shader Quality, Caustics, Oxygen Bubbles & Full-Screen TV */}
                    <div className="p-3.5 rounded-lg bg-[#071529] border border-slate-800 space-y-2.5">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                        03 // SHADERS &amp; WATER EFFECTS
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
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
                                  ? 'Very Low Shader Mode enabled for maximum TV frame rate.'
                                  : `Shader Quality set to ${tier.toUpperCase()}`
                              );
                            }}
                            className={`px-3 py-1.5 rounded text-xs font-mono font-bold border ${
                              currentEnvQuality === tier
                                ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                : 'bg-[#040a14] text-slate-300 border-slate-800'
                            }`}
                          >
                            SHADERS: {tier === 'very_low' ? 'VERY LOW (TV MAX)' : tier.toUpperCase()}
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
                          className="px-3 py-1.5 rounded text-xs font-mono font-bold bg-[#040a14] border border-slate-700 text-slate-200"
                        >
                          CAUSTICS:{' '}
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
                          className="px-3 py-1.5 rounded text-xs font-mono font-bold bg-[#040a14] border border-slate-700 text-slate-200"
                        >
                          BUBBLES:{' '}
                          {ecosystem.graphicsSettings?.showParticles !== false ? 'ON' : 'OFF'}
                        </button>

                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={handleToggleFramelessTvMode}
                          className={`px-3 py-1.5 rounded text-xs font-mono font-bold border ${
                            isFramelessTvMode
                              ? 'bg-emerald-400 text-slate-950 border-emerald-300'
                              : 'bg-[#040a14] text-slate-300 border-slate-700'
                          }`}
                        >
                          FRAMELESS TV: {isFramelessTvMode ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    </div>

                    {/* 4. Back-of-Tank Blue Brightness & Overhead Light Intensity */}
                    <div className="p-3.5 rounded-lg bg-[#071529] border border-slate-800 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                          04 // WATER BLUE &amp; LAMP POWER
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(
                            [
                              ['ABYSSAL', 0.06, 0.55],
                              ['DEEP OCEAN', 0.22, 0.95],
                              ['REEF', 0.45, 1.15],
                              ['LAGOON', 0.78, 1.4],
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
                                className={`px-2.5 py-1 rounded text-xs font-mono font-bold border ${
                                  isSelected
                                    ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                                    : 'bg-[#040a14] text-slate-300 border-slate-700'
                                }`}
                              >
                                {presetName}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="p-2.5 rounded bg-[#040a14] border border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
                          <span className="text-slate-300">
                            BLUE: <strong className="text-cyan-300">{Math.round(currentBgBrightness * 100)}%</strong>
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() =>
                                handleUpdateLightingSettings({
                                  backgroundBrightness: currentBgBrightness - 0.08,
                                })
                              }
                              className="px-2.5 py-1 rounded bg-slate-800 font-bold text-white border border-slate-700"
                            >
                              -
                            </button>
                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() =>
                                handleUpdateLightingSettings({
                                  backgroundBrightness: currentBgBrightness + 0.08,
                                })
                              }
                              className="px-2.5 py-1 rounded bg-slate-800 font-bold text-white border border-slate-700"
                            >
                              +
                            </button>
                          </div>
                        </div>

                        <div className="p-2.5 rounded bg-[#040a14] border border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
                          <span className="text-slate-300">
                            LAMP: <strong className="text-amber-300">{Math.round(currentLightIntensity * 100)}%</strong>
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() =>
                                handleUpdateLightingSettings({
                                  lightIntensity: currentLightIntensity - 0.1,
                                })
                              }
                              className="px-2.5 py-1 rounded bg-slate-800 font-bold text-white border border-slate-700"
                            >
                              -
                            </button>
                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() =>
                                handleUpdateLightingSettings({
                                  lightIntensity: currentLightIntensity + 0.1,
                                })
                              }
                              className="px-2.5 py-1 rounded bg-slate-800 font-bold text-white border border-slate-700"
                            >
                              +
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* BOTTOM CONSOLE CONTROLLER LEGEND BAR */}
            <div className="px-4 py-2 bg-[#061328] border-t-2 border-cyan-500 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-300">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  <strong className="text-cyan-300">[D-PAD / ARROWS]</strong> MOVE
                </span>
                <span>
                  <strong className="text-emerald-300">[OK / A]</strong> SELECT
                </span>
                <span>
                  <strong className="text-amber-300">[LB / RB]</strong> TAB
                </span>
                <span>
                  <strong className="text-rose-300">[B / PLAY]</strong> RESUME
                </span>
              </div>
              <div className="text-cyan-400 font-bold">
                TV LITE MODE (3D PAUSED IN MENU)
              </div>
            </div>
          </div>
        </div>
      )}

      {/* RENAME FISH CONSOLE DIALOG MODAL (Ultra-Lite Solid Opaque for TV) */}
      {renamingFishId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Rename Fish"
          data-modal-scope="rename"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d] p-4 pointer-events-auto"
        >
          <div className="w-full max-w-lg rounded-lg bg-[#061328] border-2 border-cyan-400 p-5 space-y-4 text-slate-100">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-cyan-400 font-bold">
                  SPECIMEN REGISTRY // CUSTOM CALLSIGN
                </div>
                <h3 className="text-base font-extrabold text-white uppercase">
                  Rename Your Fish
                </h3>
              </div>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setRenamingFishId(null)}
                className="px-3 py-1 rounded bg-slate-800 text-xs font-mono font-bold text-slate-200"
              >
                CANCEL [B]
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-mono uppercase text-slate-300">
                Type Name or Select a 1-Click TV Preset:
              </label>
              <input
                ref={renameInputRef}
                type="text"
                maxLength={24}
                value={renameDraft}
                data-tv-focusable="true"
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleConfirmRenameFish();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenamingFishId(null);
                  }
                }}
                placeholder="Enter fish name..."
                className="w-full px-3 py-2 rounded bg-[#030914] border-2 border-cyan-400 text-sm font-mono font-bold text-white"
              />
            </div>

            {/* 1-Click Quick TV Remote Name Chips */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                1-Click TV Remote Preset Names:
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_FISH_NAMES.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setRenameDraft(preset)}
                    className={`px-2.5 py-1 rounded text-xs font-mono font-bold border ${
                      renameDraft === preset
                        ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                        : 'bg-[#040a14] text-cyan-200 border-slate-700'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => {
                    const pick =
                      PRESET_FISH_NAMES[Math.floor(Math.random() * PRESET_FISH_NAMES.length)];
                    setRenameDraft(`${pick}-${Math.floor(10 + Math.random() * 89)}`);
                  }}
                  className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-[#3b2106] text-amber-300 border border-amber-400"
                >
                  RANDOM
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2.5 border-t border-slate-800">
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setRenamingFishId(null)}
                className="px-4 py-2 rounded bg-slate-800 text-xs font-mono font-bold text-slate-200 uppercase"
              >
                Cancel
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => handleConfirmRenameFish()}
                className="px-5 py-2 rounded bg-cyan-400 text-slate-950 text-xs font-mono font-extrabold uppercase"
              >
                Save Name [OK]
              </button>
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d] p-4 pointer-events-auto"
        >
          <div className="w-full max-w-md rounded-lg bg-[#061328] border-2 border-cyan-400 p-5 space-y-3.5 text-slate-100">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold text-white uppercase">
                {helpModalTopic.title}
              </h3>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setHelpModalTopic(null)}
                className="px-3 py-1 rounded bg-slate-800 text-xs font-mono text-slate-200"
              >
                Close [B / OK]
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
              {helpModalTopic.body}
            </p>
            <div className="p-3 rounded bg-[#040a14] border border-cyan-500 text-xs text-cyan-200">
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
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#02060d] p-6 pointer-events-auto"
        >
          <div className="w-full max-w-sm rounded-lg bg-[#061328] border-2 border-cyan-400 p-6 space-y-4 text-center">
            <h2 className="text-xl font-extrabold text-white uppercase">
              {t.pausedTitle || 'Sanctuary Paused'}
            </h2>
            <p className="text-xs font-mono text-slate-400">
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
                className="w-full py-2.5 rounded bg-cyan-400 text-slate-950 text-xs font-mono font-extrabold uppercase"
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
                className="w-full py-2.5 rounded bg-slate-800 text-cyan-300 text-xs font-mono font-bold uppercase"
              >
                Open Console HUD
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
