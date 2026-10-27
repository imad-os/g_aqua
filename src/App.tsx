import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AquariumCanvas3D,
  getPolygonSpecForQuality,
} from './components/AquariumCanvas3D';
import { audioEngine } from './engine/audio';
import { DEFAULT_SPECIES_LIST, TANK_TIERS } from './engine/defaults';
import {
  fetchBaseModelsFromFirestore,
  loadUserBrainsFromFirestore,
  syncUserBrainsToFirestore,
} from './engine/firebaseBrainer';
import { getMyPC, I18N, MyPCInfo } from './engine/mypc';
import {
  nextEntityId,
  spawnFoundingFish,
  stepEcosystemSimulation,
} from './engine/simulation';
import {
  createInitialEcosystemState,
  loadEcosystemState,
  publishActiveGameSessionLease,
  saveEcosystemState,
} from './engine/storage';
import {
  FishPolygonQuality,
  FoodPellet,
  SavedEcosystemState,
  ThreatEntity,
} from './engine/types';

type GameScreenState = 'title' | 'playing' | 'paused';
type SettingsModalTab = 'fish_stats' | 'graphics_polygons' | 'aquarium_shop';

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
  time_speed: {
    title: 'Aquarium Biological Clock Speed',
    body: 'Fishes age, get hungry, mature, and naturally breed based on simulation hours. At 1x speed, 1 simulation hour equals 1 real hour. At 24x speed, a full 24-hour fish day passes in 1 real hour.',
    tip: 'Use 6x or 24x if you want to watch your 2 starter fishes grow up and have babies sooner.',
  },
  ai_breeding: {
    title: '100% AI-Driven Natural Breeding & Satisfaction',
    body: 'Just like a real aquarium, you cannot force fishes to hatch babies manually. When two adult fishes are well-fed (Energy above 60%) and comfortable in clean water, their AI naturally courts and produces offspring that inherit the mother’s brain.',
    tip: 'Sprinkle food on top of the water regularly and keep water quality clean so your fishes stay satisfied and reproduce on their own!',
  },
  top_feeding: {
    title: 'Top-Surface Aquarium Feeding',
    body: 'When you sprinkle food, flakes and pellets float on the top water surface for a few seconds before slowly sinking toward the sand. Hungry fishes sense the food and swim up toward the surface to eat.',
    tip: 'Press OK / A / Space anytime while watching your aquarium to sprinkle food across the top water surface.',
  },
  water_care: {
    title: 'Water Quality & Comfort',
    body: 'Clean, well-filtered water keeps fish stress low and health at 100%. High comfort encourages adult fishes to mate and pass their learned brain behaviors to the next generation.',
    tip: 'Click "Refresh Water & Filter" whenever water quality dips below 90%.',
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

  const [ecosystem, setEcosystem] = useState<SavedEcosystemState>(() =>
    loadEcosystemState()
  );
  const ecosystemRef = useRef<SavedEcosystemState>(ecosystem);
  ecosystemRef.current = ecosystem;

  // Settings & Fish Stats Modal State
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<SettingsModalTab>('fish_stats');
  const [helpModalTopic, setHelpModalTopic] = useState<HelpTopic | null>(null);
  const [polyStats, setPolyStats] = useState<{
    trianglesPerFish: number;
    totalFishTriangles: number;
  }>({ trianglesPerFish: 3850, totalFishTriangles: 7700 });

  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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
  const lastFirestoreSyncMsRef = useRef<number>(0);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const t = window.setTimeout(() => setToastMessage(null), 4000);
    return () => window.clearTimeout(t);
  }, [toastMessage]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.body.dataset.state = screenState;
    }
  }, [screenState]);

  // Publish active game session heartbeat so the standalone Back-Office Trainer App's
  // 24/7 Offline Service knows this owner is currently watching their tank live
  useEffect(() => {
    const currentTank =
      TANK_TIERS[ecosystem.activeTankTier] || TANK_TIERS[0];
    const isPlayingNow = screenState === 'playing';
    publishActiveGameSessionLease(currentTank.id, isPlayingNow);

    if (!isPlayingNow) return;
    const timer = window.setInterval(() => {
      publishActiveGameSessionLease(currentTank.id, true);
    }, 2000);

    return () => {
      window.clearInterval(timer);
      publishActiveGameSessionLease(currentTank.id, false);
    };
  }, [screenState, ecosystem.activeTankTier]);

  // Sprinkle food across the TOP water surface (just like a real aquarium owner)
  const handleSprinkleFoodOnTop = useCallback(() => {
    const tank = TANK_TIERS[ecosystemRef.current.activeTankTier] || TANK_TIERS[0];
    const halfW = tank.width * 0.36;
    const halfD = tank.depth * 0.34;
    const topSurfaceY = tank.height * 0.38 * 0.92;

    for (let i = 0; i < 6; i++) {
      if (pelletsRef.current.length >= 60) break;
      pelletsRef.current.push({
        id: nextEntityId('pellet'),
        x: (Math.random() - 0.5) * halfW * 1.6,
        y: topSurfaceY + (Math.random() - 0.5) * 0.06,
        z: (Math.random() - 0.5) * halfD * 1.6,
        vy: -0.26 - Math.random() * 0.12,
        nutrition: 28,
        ageSeconds: 0,
        source: 'manual',
      });
    }
    audioEngine.playPelletDrop();
    showToast('Sprinkled food flakes across the top water surface.');
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
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    showToast('Water filtered & conditioned to 100% quality (25.0°C). Fish comfort restored!');
  };

  // Buy or switch to a bigger Aquarium Tank Tier
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
        ? `Moved your fishes into ${tier.name} (Capacity: ${tier.maxFishCapacity} fishes).`
        : `Purchased ${tier.name}! Capacity expanded to ${tier.maxFishCapacity} fishes.`
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
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    audioEngine.playTankUpgrade();
    showToast(
      `Installed Top Auto-Feeder #${currentCount + 1} (${currentCount + 1}/${tank.maxAutoFeeders}).`
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
    showToast('Added a new pair of starter fishes to your aquarium.');
  };

  // Update 3D Fish Polygon Quality or Graphics settings
  const handleUpdatePolygonQuality = (polyQuality: FishPolygonQuality) => {
    const eco = ecosystemRef.current;
    eco.graphicsSettings = {
      ...(eco.graphicsSettings || {
        fishPolygonQuality: 'high',
        environmentQuality: 'high',
        showCaustics: true,
        showParticles: true,
        antiAliasing: true,
      }),
      fishPolygonQuality: polyQuality,
    };
    saveEcosystemState(eco);
    setEcosystem({ ...eco });
    const spec = getPolygonSpecForQuality(polyQuality);
    showToast(`3D Fish Mesh Quality set to ${spec.label}`);
  };

  const handleStartAquarium = useCallback(() => {
    audioEngine.initOrResume();
    setScreenState('playing');
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  // Initialize MyPC SDK Lifecycle, Gamepad Listeners & Firestore Brain Sync
  useEffect(() => {
    mypc.init({
      ownMenu: true,
      onInit: (info) => {
        setMypcInfo(info);
        audioEngine.setVolumes(info.volume?.music ?? 0.7, info.volume?.sfx ?? 0.8);

        const cfg = mypc.app_config || {};
        if (cfg.timeMultiplier) {
          ecosystemRef.current.timeMultiplier = Number(cfg.timeMultiplier) || 1;
        }

        // 1. Load latest promoted Base Models from Firestore `base_models` collection
        fetchBaseModelsFromFirestore().then((cloudModels) => {
          if (cloudModels.length > 0) {
            const eco = ecosystemRef.current;
            eco.modelRegistry = cloudModels;
            for (const sp of eco.speciesList) {
              const promoted = cloudModels.find(
                (m) => m.speciesId === sp.id && m.isPromotedBase
              );
              if (promoted) {
                sp.activeBaseModelVersion = promoted.versionId;
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
            for (const cb of cloudRecord.fishBrains) {
              const localFish = eco.fishes.find((f) => f.lineage.fishId === cb.fishId);
              if (localFish) {
                localFish.brain = cb.brain;
                localFish.lineage.alive = cb.alive;
                localFish.lineage.causeOfDeath = (cb.causeOfDeath as any) || null;
                localFish.state.energy = cb.energy;
                localFish.state.hunger = cb.hunger;
                localFish.state.ageSimHours = cb.ageSimHours;
              }
            }
            saveEcosystemState(eco);
            setEcosystem({ ...eco });
          }
        });

        mypc.setMenu([
          { id: 'feed', label: 'Sprinkle Food on Top' },
          { id: 'settings', label: 'Fish Stats & Settings' },
          { id: 'restart', label: 'Reset Aquarium (2 Starter Fishes)' },
        ]);

        mypc.ready();
      },
      onStart: () => {},
      onPause: () => {
        ecosystemRef.current.paused = true;
        audioEngine.pause();
        if (screenStateRef.current === 'playing') {
          setScreenState('paused');
        }
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
        publishActiveGameSessionLease(tank.id, false);
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

        if (screenStateRef.current === 'title') {
          if (action === 'confirm' || action === 'jump') {
            handleStartAquarium();
          }
          return;
        }

        if (screenStateRef.current === 'paused') {
          if (action === 'confirm' || action === 'cancel' || action === 'menu') {
            ecosystemRef.current.paused = false;
            setScreenState('playing');
          }
          return;
        }

        if (screenStateRef.current === 'playing' && !repeat) {
          if (action === 'confirm' || action === 'jump') {
            handleSprinkleFoodOnTop();
          } else if (action === 'menu' || action === 'run') {
            setSettingsOpen((v) => !v);
          } else if (action === 'cancel') {
            setHelpModalTopic(null);
            setSettingsOpen(false);
          } else if (action === 'left') {
            cameraOrbitRef.current.yaw = Math.max(-0.8, cameraOrbitRef.current.yaw - 0.15);
          } else if (action === 'right') {
            cameraOrbitRef.current.yaw = Math.min(0.8, cameraOrbitRef.current.yaw + 0.15);
          } else if (action === 'up') {
            cameraOrbitRef.current.zoom = Math.max(0.65, cameraOrbitRef.current.zoom - 0.1);
          } else if (action === 'down') {
            cameraOrbitRef.current.zoom = Math.min(1.45, cameraOrbitRef.current.zoom + 0.1);
          }
        }
      },
    });

    if (mypc.gamepad) {
      mypc.gamepad.on(
        'button',
        (_index: number, pressed: boolean, _value: number, _dev: string, name: string) => {
          if (!pressed) return;
          if (screenStateRef.current === 'title') {
            if (name === 'A' || name === 'Start') {
              handleStartAquarium();
            }
            return;
          }
          if (screenStateRef.current === 'playing') {
            if (name === 'A') {
              handleSprinkleFoodOnTop();
            } else if (name === 'Y' || name === 'X' || name === 'Start' || name === 'Select') {
              setSettingsOpen((v) => !v);
            } else if (name === 'B') {
              setHelpModalTopic(null);
              setSettingsOpen(false);
            }
          }
        }
      );
    }
  }, [handleSprinkleFoodOnTop, handleStartAquarium, mypc, showToast]);

  // 60Hz Simulation & Gamepad Stick Polling Callback
  const handleTickSimulation = useCallback(
    (dt: number) => {
      if (screenStateRef.current !== 'playing') return;

      const eco = ecosystemRef.current;
      const tank = TANK_TIERS[eco.activeTankTier] || TANK_TIERS[0];

      // Gentle camera look/zoom via gamepad sticks
      if (mypc.gamepad) {
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

      // Advance Real-Life Aquarium AI Simulation
      stepEcosystemSimulation(eco, pelletsRef.current, threatsRef.current, dt, {
        allowAutoFeeders: true,
        onPelletEaten: () => {
          audioEngine.playPelletEat();
        },
        onBirth: (child, mother) => {
          audioEngine.playBirthChime();
          const maxGen = Math.max(...eco.fishes.map((f) => f.lineage.generation));
          mypc.submitScore(maxGen * 100 + eco.bioCredits);
          showToast(
            `${mother.lineage.name} naturally hatched ${child.lineage.name} (Generation ${child.lineage.generation})!`
          );
        },
        onDeath: (fish, reason) => {
          showToast(`${fish.lineage.name} passed away from ${reason}.`);
        },
      });

      const nowMs = performance.now();
      if (nowMs - lastHudSyncMsRef.current > 320) {
        lastHudSyncMsRef.current = nowMs;
        setEcosystem({ ...eco });
        saveEcosystemState(eco);
      }

      if (nowMs - lastFirestoreSyncMsRef.current > 12000) {
        lastFirestoreSyncMsRef.current = nowMs;
        const username = mypc.info()?.profile?.name || 'Keeper';
        const profileId = mypc.info()?.profile?.id || 'local-caretaker';
        const feederCount = eco.autoFeederCountByTank[tank.id] || 0;
        syncUserBrainsToFirestore(username, profileId, eco.fishes, true, feederCount);
      }
    },
    [mypc, showToast]
  );

  const lang = mypcInfo.lang || 'en';
  const t = I18N[lang] || I18N.en;
  const currentTank = TANK_TIERS[ecosystem.activeTankTier] || TANK_TIERS[0];
  const aliveFishes = ecosystem.fishes.filter((f) => f.lineage.alive);
  const highestGeneration = ecosystem.fishes.reduce(
    (m, f) => Math.max(m, f.lineage.generation),
    1
  );
  const currentPolyQuality: FishPolygonQuality =
    ecosystem.graphicsSettings?.fishPolygonQuality || 'high';
  const currentEnvQuality =
    ecosystem.graphicsSettings?.environmentQuality || mypcInfo.quality?.tier || 'high';

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
        activeTankTier={ecosystem.activeTankTier}
        isPaused={screenState === 'paused' || ecosystem.paused}
        onTickSimulation={handleTickSimulation}
        onPolygonStatsUpdate={setPolyStats}
      />

      {/* STATE 1: TITLE SCREEN OVERLAY */}
      {screenState === 'title' && (
        <div className="fixed inset-0 z-20 flex flex-col justify-between p-8 sm:p-12 pointer-events-none bg-gradient-to-r from-[#030914]/90 via-[#030914]/50 to-transparent">
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
              the top water surface, keep their water comfortable, and watch them naturally grow,
              learn, and breed across generations.
            </p>

            <div className="flex flex-wrap items-center gap-3.5 pt-2">
              <button
                type="button"
                data-start="true"
                onClick={handleStartAquarium}
                className="px-7 py-3.5 text-sm font-bold bg-cyan-400 text-slate-950 rounded-lg hover:bg-cyan-300 focus-visible:outline-4 focus-visible:outline-white transition-transform active:scale-95 whitespace-nowrap"
              >
                {t.enterAquarium}
              </button>

              <button
                type="button"
                onClick={() => {
                  handleStartAquarium();
                  setSettingsTab('graphics_polygons');
                  setSettingsOpen(true);
                }}
                className="px-5 py-3.5 text-sm font-semibold bg-[#0c192c]/90 text-cyan-300 border border-cyan-500/40 rounded-lg hover:bg-[#132642] focus-visible:outline-4 focus-visible:outline-cyan-400 transition-colors whitespace-nowrap"
              >
                Settings &amp; 3D Polygons
              </button>
            </div>
          </div>

          <div className="text-xs font-mono text-slate-300/90 hud-text-shadow">
            [OK / A] Sprinkle Food on Top · [Menu / Y] Fish Stats &amp; Graphics Settings
          </div>
        </div>
      )}

      {/* STATE 2: UNIFIED LIVING AQUARIUM / SCREENSAVER VIEW (Calm, Minimal Perimeter) */}
      {screenState === 'playing' && (
        <div className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-between p-5">
          {/* Minimal Top Bar: Tank Info on Left, Sprinkle Food & Settings on Right */}
          <div className="w-full flex items-start justify-between gap-4">
            <div className="pointer-events-auto px-3.5 py-2 rounded-lg bg-[#06101e]/75 border border-slate-700/50 text-xs font-mono text-slate-200 tabular-nums flex items-center gap-3">
              <span className="text-cyan-300 font-semibold">{currentTank.name}</span>
              <span className="text-slate-500">·</span>
              <span>
                {aliveFishes.length}/{currentTank.maxFishCapacity} Live Fishes
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-emerald-300">Gen {highestGeneration}</span>
              <span className="text-slate-500">·</span>
              <span className="text-amber-300">{Math.round(ecosystem.bioCredits)} Credits</span>
              <span className="text-slate-500 hidden sm:inline">·</span>
              <span className="text-slate-400 hidden sm:inline">
                {ecosystem.simHoursTotal.toFixed(1)}h ({ecosystem.timeMultiplier}x)
              </span>
            </div>

            <div className="pointer-events-auto flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleSprinkleFoodOnTop();
                }}
                className="px-4 py-2 rounded-lg bg-amber-500/90 text-slate-950 text-xs font-bold hover:bg-amber-400 transition-colors shadow-lg whitespace-nowrap"
              >
                Sprinkle Food on Top [OK / A]
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  setSettingsOpen((v) => !v);
                }}
                className="px-3.5 py-2 rounded-lg bg-[#071324]/85 border border-cyan-500/40 text-xs font-semibold text-cyan-200 hover:bg-slate-800 transition-colors shadow-lg whitespace-nowrap"
              >
                Fish Stats &amp; Settings [Menu]
              </button>

              <button
                type="button"
                aria-label={isMuted ? 'Unmute Audio' : 'Mute Audio'}
                onClick={(e) => {
                  e.currentTarget.blur();
                  const nextMute = !isMuted;
                  setIsMuted(nextMute);
                  audioEngine.setMuted(nextMute);
                }}
                className="p-2 rounded-lg bg-[#071324]/85 border border-slate-700 text-slate-200 hover:border-cyan-400"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                  {isMuted ? (
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  ) : (
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* Toast Feedback Banner */}
          {toastMessage && (
            <div className="mx-auto px-4 py-2 rounded-lg bg-[#071324]/90 border border-cyan-400/50 text-xs font-medium text-cyan-200 shadow-lg">
              {toastMessage}
            </div>
          )}

          {/* Subtle Bottom Ambient Hint */}
          <div className="w-full flex items-center justify-between text-[11px] font-mono text-slate-400/80 hud-text-shadow">
            <span>
              Water Quality: {Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}%
              · Temp: {ecosystem.evolutionConfig.environment.temperatureC.toFixed(1)}°C · Auto-Feeder:{' '}
              {ecosystem.autoFeederCountByTank[currentTank.id] || 0}
            </span>
            <span>
              3D Polygons: {polyStats.trianglesPerFish.toLocaleString()} tris/fish (
              {currentPolyQuality.toUpperCase()})
            </span>
          </div>
        </div>
      )}

      {/* OWNER MENU & SETTINGS MODAL (Fish Stats, 3D Polygon Quality, Aquarium Shop) */}
      {settingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Aquarium Owner Menu and Settings"
          className="fixed inset-0 z-30 flex items-center justify-center bg-[#02060d]/75 p-4 pointer-events-auto"
        >
          <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-2xl bg-[#071324] border border-cyan-500/40 shadow-2xl overflow-hidden text-slate-100">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-[#09192f] border-b border-slate-800 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">
                  Aquarium Owner Menu &amp; Settings
                </h2>
                <p className="text-xs text-slate-400">
                  Check each fish&rsquo;s health &amp; AI stats, adjust 3D polygon quality, or care
                  for your tank.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-700"
              >
                Close [B / Esc]
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="px-6 py-2.5 bg-[#081528] border-b border-slate-800 flex items-center gap-2 overflow-x-auto">
              <button
                type="button"
                onClick={() => setSettingsTab('fish_stats')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
                  settingsTab === 'fish_stats'
                    ? 'bg-cyan-400 text-slate-950'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                My Fishes ({aliveFishes.length} Live Stats)
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab('graphics_polygons')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
                  settingsTab === 'graphics_polygons'
                    ? 'bg-cyan-400 text-slate-950'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                3D Polygon &amp; Graphics Quality
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab('aquarium_shop')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
                  settingsTab === 'aquarium_shop'
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                Aquarium Shop &amp; Water Care ({Math.round(ecosystem.bioCredits)} Credits)
              </button>
            </div>

            {/* Modal Content Area */}
            <div className="flex-1 overflow-y-auto lab-scroll p-6 space-y-5">
              {/* TAB 1: STATS OF EACH FISH */}
              {settingsTab === 'fish_stats' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Live Fishes in {currentTank.name} ({aliveFishes.length}/
                        {currentTank.maxFishCapacity})
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Fishes grow, forage from the top water surface, and reproduce autonomously
                        when mature (Age ≥ 4.0h) and well-fed (Energy ≥ 60%).
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setHelpModalTopic(HELP_TOPICS.ai_breeding)}
                      className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30"
                      title="How Natural AI Breeding Works"
                    >
                      ?
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {aliveFishes.map((fish) => {
                      const sp =
                        ecosystem.speciesList.find((s) => s.id === fish.lineage.speciesId) ||
                        DEFAULT_SPECIES_LIST[0];
                      const satisfaction = Math.round(
                        Math.max(
                          0,
                          Math.min(100, fish.state.energy * 0.65 + (100 - fish.state.stress) * 0.35)
                        )
                      );
                      return (
                        <div
                          key={fish.lineage.fishId}
                          className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3"
                        >
                          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                            <div>
                              <div className="text-sm font-bold text-white">
                                {fish.lineage.name}{' '}
                                <span className="text-xs font-mono text-cyan-400">
                                  · Generation {fish.lineage.generation}
                                </span>
                              </div>
                              <div className="text-xs text-slate-400">
                                {sp.name} · Base Model:{' '}
                                <span className="font-mono text-slate-300">
                                  {fish.lineage.modelVersion}
                                </span>
                              </div>
                            </div>
                            <span
                              className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold uppercase ${
                                fish.state.isGravid
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : 'bg-cyan-500/15 text-cyan-300'
                              }`}
                            >
                              {fish.state.isGravid ? 'Expecting Babies' : fish.state.lifeStage}
                            </span>
                          </div>

                          {/* Energy & Satisfaction Progress Bars */}
                          <div className="space-y-2 text-xs">
                            <div>
                              <div className="flex justify-between font-mono mb-1">
                                <span className="text-slate-400">Fullness / Energy</span>
                                <span
                                  className={
                                    fish.state.energy < 30 ? 'text-rose-400' : 'text-emerald-400'
                                  }
                                >
                                  {fish.state.energy.toFixed(0)}%
                                </span>
                              </div>
                              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    fish.state.energy < 30 ? 'bg-rose-500' : 'bg-emerald-400'
                                  }`}
                                  style={{ width: `${Math.min(100, fish.state.energy)}%` }}
                                />
                              </div>
                            </div>

                            <div>
                              <div className="flex justify-between font-mono mb-1">
                                <span className="text-slate-400">Satisfaction &amp; Comfort</span>
                                <span className="text-cyan-300">{satisfaction}%</span>
                              </div>
                              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-cyan-400 rounded-full"
                                  style={{ width: `${satisfaction}%` }}
                                />
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-1 text-xs font-mono text-slate-300">
                            <div>
                              Age: {fish.state.ageSimHours.toFixed(1)}h /{' '}
                              {sp.lifespan.lifespanSimHours}h
                            </div>
                            <div>Food Eaten: {fish.state.metrics.foodPelletsEaten}</div>
                            <div>Babies Hatched: {fish.state.metrics.offspringProduced}</div>
                            <div>Speed Gene: {fish.genetics.maxSpeedGene}x</div>
                            <div className="col-span-2 text-slate-400 truncate">
                              Lineage:{' '}
                              {fish.lineage.motherId
                                ? 'Inherited Mother Brain + Mutations'
                                : 'Founding Pair (Base Brain Model)'}
                            </div>
                          </div>
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
                        onClick={handleRestockStarterPair}
                        className="px-4 py-2 rounded-lg bg-amber-400 text-slate-950 text-xs font-bold hover:bg-amber-300"
                      >
                        Restock 2 Starter Fishes (Free)
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: 3D POLYGON & GRAPHICS SETTINGS */}
              {settingsTab === 'graphics_polygons' && (
                <div className="space-y-5">
                  {/* 3D Fish Polygon Density Selector */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-bold text-white">
                          3D Fish Polygon Quality (Mesh Smoothness)
                        </div>
                        <div className="text-xs text-slate-400">
                          Current Active Mesh:{' '}
                          <span className="font-mono text-cyan-300">
                            {polyStats.trianglesPerFish.toLocaleString()} triangles per fish (
                            {polyStats.totalFishTriangles.toLocaleString()} total fish triangles)
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setHelpModalTopic(HELP_TOPICS.fish_polygons)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30"
                      >
                        ?
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                      {(
                        [
                          ['low', 'Low (TV Saver)', '~520 Tris / Fish'],
                          ['medium', 'Medium (Balanced)', '~1,640 Tris / Fish'],
                          ['high', 'High (Sculpted 3D)', '~3,850 Tris / Fish'],
                          ['ultra', 'Ultra (Cinema 3D)', '~8,200 Tris / Fish'],
                        ] as Array<[FishPolygonQuality, string, string]>
                      ).map(([qId, label, sub]) => (
                        <button
                          key={qId}
                          type="button"
                          onClick={() => handleUpdatePolygonQuality(qId)}
                          className={`p-3 rounded-xl border text-left transition-colors ${
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

                  {/* Environment Lighting & Effects */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-bold text-white">
                          Aquarium Lighting, Shadows &amp; Water Effects
                        </div>
                        <div className="text-xs text-slate-400">
                          Configure underwater shadows, caustic light shimmer, and oxygen bubbles.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setHelpModalTopic(HELP_TOPICS.lighting_quality)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30"
                      >
                        ?
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      {(['low', 'mid', 'high'] as const).map((tier) => (
                        <button
                          key={tier}
                          type="button"
                          onClick={() => {
                            const eco = ecosystemRef.current;
                            eco.graphicsSettings = {
                              ...(eco.graphicsSettings || {
                                fishPolygonQuality: 'high',
                                environmentQuality: 'high',
                                showCaustics: true,
                                showParticles: true,
                                antiAliasing: true,
                              }),
                              environmentQuality: tier,
                            };
                            saveEcosystemState(eco);
                            setEcosystem({ ...eco });
                          }}
                          className={`px-4 py-2 rounded-lg text-xs font-bold border ${
                            currentEnvQuality === tier
                              ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                              : 'bg-slate-950 text-slate-300 border-slate-800'
                          }`}
                        >
                          Lighting: {tier.toUpperCase()}
                        </button>
                      ))}

                      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer ml-2">
                        <input
                          type="checkbox"
                          checked={ecosystem.graphicsSettings?.showCaustics !== false}
                          onChange={(e) => {
                            const eco = ecosystemRef.current;
                            eco.graphicsSettings = {
                              ...(eco.graphicsSettings || {
                                fishPolygonQuality: 'high',
                                environmentQuality: 'high',
                                showCaustics: true,
                                showParticles: true,
                                antiAliasing: true,
                              }),
                              showCaustics: e.target.checked,
                            };
                            saveEcosystemState(eco);
                            setEcosystem({ ...eco });
                          }}
                        />
                        <span>Underwater Caustic Shimmer</span>
                      </label>

                      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer ml-2">
                        <input
                          type="checkbox"
                          checked={ecosystem.graphicsSettings?.showParticles !== false}
                          onChange={(e) => {
                            const eco = ecosystemRef.current;
                            eco.graphicsSettings = {
                              ...(eco.graphicsSettings || {
                                fishPolygonQuality: 'high',
                                environmentQuality: 'high',
                                showCaustics: true,
                                showParticles: true,
                                antiAliasing: true,
                              }),
                              showParticles: e.target.checked,
                            };
                            saveEcosystemState(eco);
                            setEcosystem({ ...eco });
                          }}
                        />
                        <span>Oxygen Bubbles</span>
                      </label>
                    </div>
                  </div>

                  {/* Biological Clock Speed */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-bold text-white">
                          Aquarium Time Speed ({ecosystem.timeMultiplier}x)
                        </div>
                        <div className="text-xs text-slate-400">
                          Controls how fast simulation hours pass for aging, feeding, and natural
                          breeding.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setHelpModalTopic(HELP_TOPICS.time_speed)}
                        className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold hover:bg-cyan-500/30"
                      >
                        ?
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      {[
                        [1, '1x Real-Time (Calm Screensaver)'],
                        [6, '6x Accelerated'],
                        [24, '24x Fast Evolution (1 Day / Real Hour)'],
                      ].map(([spd, label]) => (
                        <button
                          key={spd}
                          type="button"
                          onClick={() => {
                            ecosystemRef.current.timeMultiplier = Number(spd);
                            saveEcosystemState(ecosystemRef.current);
                            setEcosystem({ ...ecosystemRef.current });
                          }}
                          className={`px-4 py-2 rounded-lg text-xs font-bold border ${
                            ecosystem.timeMultiplier === spd
                              ? 'bg-emerald-400 text-slate-950 border-emerald-300'
                              : 'bg-slate-950 text-slate-300 border-slate-800'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: AQUARIUM SHOP & WATER CARE */}
              {settingsTab === 'aquarium_shop' && (
                <div className="space-y-5">
                  {/* Real-Life Owner Care Actions */}
                  <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-bold text-white flex items-center gap-2">
                        <span>Water Filter &amp; Top-Surface Feeding</span>
                        <button
                          type="button"
                          onClick={() => setHelpModalTopic(HELP_TOPICS.water_care)}
                          className="w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 text-xs font-bold"
                        >
                          ?
                        </button>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        Water Quality:{' '}
                        {Math.round(ecosystem.evolutionConfig.environment.waterQuality * 100)}% ·
                        Top Auto-Feeders Installed:{' '}
                        {ecosystem.autoFeederCountByTank[currentTank.id] || 0}/
                        {currentTank.maxAutoFeeders}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={handleCleanAquariumWater}
                        className="px-3.5 py-2 rounded-lg bg-cyan-500 text-slate-950 text-xs font-bold hover:bg-cyan-400"
                      >
                        Refresh Water &amp; Filter (100% Clean)
                      </button>
                      <button
                        type="button"
                        onClick={handleBuyAutoFeeder}
                        className="px-3.5 py-2 rounded-lg bg-emerald-500 text-slate-950 text-xs font-bold hover:bg-emerald-400"
                      >
                        Buy Top Auto-Feeder (75 Credits)
                      </button>
                    </div>
                  </div>

                  {/* Upgradable Aquariums */}
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
                              {tier.subtitle} · Holds up to {tier.maxFishCapacity} Fishes
                            </div>
                            <p className="text-xs text-slate-400 mt-2">{tier.description}</p>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleBuyOrSelectTank(tier.tierIndex)}
                            className={`mt-4 w-full py-2 rounded-lg text-xs font-bold transition-colors ${
                              isCurrent
                                ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                                : unlocked
                                ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                                : 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                            }`}
                          >
                            {isCurrent
                              ? 'Active Aquarium'
                              : unlocked
                              ? 'Switch to This Aquarium'
                              : `Buy Aquarium (${tier.costCredits} Credits)`}
                          </button>
                        </div>
                      );
                    })}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d]/80 p-4 pointer-events-auto"
        >
          <div className="w-full max-w-md rounded-2xl bg-[#09192f] border border-cyan-400/60 p-6 shadow-2xl space-y-4 text-slate-100">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">{helpModalTopic.title}</h3>
              <button
                type="button"
                onClick={() => setHelpModalTopic(null)}
                className="px-2.5 py-1 rounded bg-slate-800 text-xs text-slate-300 hover:text-white"
              >
                Close
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
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#02060d]/80 p-6 pointer-events-auto"
        >
          <div className="w-full max-w-sm rounded-2xl bg-[#071324] border border-cyan-500/40 p-6 shadow-2xl space-y-4 text-center">
            <h2 className="text-xl font-bold text-white">{t.paused}</h2>
            <p className="text-xs text-slate-400">
              Aquarium clock paused at {ecosystem.simHoursTotal.toFixed(2)} simulation hours.
            </p>
            <div className="flex flex-col gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  ecosystemRef.current.paused = false;
                  setScreenState('playing');
                }}
                className="w-full py-2.5 rounded-lg bg-cyan-400 text-slate-950 text-xs font-bold hover:bg-cyan-300"
              >
                {t.resume}
              </button>
              <button
                type="button"
                onClick={() => {
                  ecosystemRef.current.paused = false;
                  setScreenState('playing');
                  setSettingsOpen(true);
                }}
                className="w-full py-2.5 rounded-lg bg-slate-800 text-cyan-300 text-xs font-semibold hover:bg-slate-700"
              >
                Open Fish Stats &amp; Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
