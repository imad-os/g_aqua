import { createBaseBrainInstance } from './brain';
import {
  DEFAULT_EVOLUTION_CONFIG,
  DEFAULT_SPECIES_LIST,
  TANK_TIERS,
} from './defaults';
import { getMyPC } from './mypc';
import {
  evaluateBrainOnBenchmarks,
  spawnFoundingFish,
} from './simulation';
import {
  ModelVersionRecord,
  SavedEcosystemState,
} from './types';

import {
  createSpeciesConfigFromFamousFish,
  FAMOUS_AQUARIUM_FISHES_50,
} from './famousFishCatalog';

const ECOSYSTEM_SAVE_KEY = 'ecosystem_v2';
const ACTIVE_LEASE_STORAGE_KEY = 'abyssal_evo_active_game_leases';

export function createInitialEcosystemState(
  startingCredits = 250,
  defaultTankTier = 0,
  timeMultiplier = 1
): SavedEcosystemState {
  const baseSpecies = DEFAULT_SPECIES_LIST.map((s) => ({
    ...s,
    lifespan: { ...s.lifespan },
    baseBrainConfig: {
      ...s.baseBrainConfig,
      hiddenLayers: [...s.baseBrainConfig.hiddenLayers],
    },
  }));

  // Also include the top 12 famous aquarium fishes across Owner Levels 1-6 so the shop has a rich selection out of the box
  const extraFamous = FAMOUS_AQUARIUM_FISHES_50.slice(0, 12).map((tpl) =>
    createSpeciesConfigFromFamousFish(tpl)
  );
  const speciesList = [...baseSpecies];
  for (const ef of extraFamous) {
    if (!speciesList.some((s) => s.id === ef.id)) {
      speciesList.push(ef);
    }
  }

  const evolutionConfig = JSON.parse(JSON.stringify(DEFAULT_EVOLUTION_CONFIG));

  const modelRegistry: ModelVersionRecord[] = speciesList.map((sp, idx) => {
    const baseBrain = createBaseBrainInstance(sp.baseBrainConfig, 500 + idx * 111);
    const bench = evaluateBrainOnBenchmarks(baseBrain, sp, evolutionConfig, 500 + idx);
    return {
      versionId: 'v1.0-base',
      speciesId: sp.id,
      parentVersionId: null,
      createdAtIso: new Date().toISOString(),
      generationTrained: 1,
      isPromotedBase: true,
      notes: 'Initial calibrated founding species base model.',
      brainConfig: { ...sp.baseBrainConfig },
      speciesConfig: { ...sp },
      weights: baseBrain.inheritedWeights,
      biases: baseBrain.inheritedBiases,
      benchmark: bench,
    };
  });

  const fishes = [];
  // At first the owner starts with only 2 founding fishes of the starter species
  const starterSpecies = speciesList[0];
  for (let i = 0; i < 2; i++) {
    fishes.push(spawnFoundingFish(starterSpecies, defaultTankTier, 0, i));
  }

  const starterTank = TANK_TIERS[defaultTankTier] || TANK_TIERS[0];

  return {
    version: 2,
    simHoursTotal: 1.5,
    timeMultiplier,
    paused: false,
    bioCredits: startingCredits,
    ownerLevel: 1,
    ownerXp: 20,
    unlockedTankTiers: [0],
    activeTankTier: defaultTankTier,
    autoFeederCountByTank: {
      [starterTank.id]: 1,
    },
    graphicsSettings: {
      fishPolygonQuality: 'high',
      environmentQuality: 'high',
      showCaustics: true,
      showParticles: true,
      antiAliasing: true,
      framelessTvMode: true,
      lightIntensity: 0.95,
      backgroundBrightness: 0.22,
    },
    speciesList,
    evolutionConfig,
    fishes,
    deceasedArchive: [],
    generationHistory: [
      {
        generation: 1,
        simHourReached: 1.5,
        populationAlive: 2,
        birthsCount: 2,
        starvationDeaths: 0,
        oldAgeDeaths: 0,
        predationDeaths: 0,
        avgSpeedGene: 1.0,
        avgMetabolismGene: 1.0,
        avgSensorRangeGene: 1.0,
        avgStressToleranceGene: 1.0,
        avgForagingEfficiency: 68.4,
        avgHarmAvoidance: 64.2,
        avgEnergyManagement: 70.1,
        dominantMutations: ['FoundingInstinct'],
      },
    ],
    modelRegistry,
    experiments: [],
  };
}

function normalizeLoadedEcosystem(parsed: SavedEcosystemState): SavedEcosystemState {
  if (!parsed.ownerLevel || parsed.ownerLevel < 1) {
    parsed.ownerLevel = 1;
  }
  if (typeof parsed.ownerXp !== 'number' || parsed.ownerXp < 0) {
    parsed.ownerXp = 20;
  }
  if (!parsed.graphicsSettings) {
    parsed.graphicsSettings = {
      fishPolygonQuality: 'high',
      environmentQuality: 'high',
      showCaustics: true,
      showParticles: true,
      antiAliasing: true,
      framelessTvMode: true,
      lightIntensity: 0.95,
      backgroundBrightness: 0.22,
    };
  } else {
    if (parsed.graphicsSettings.framelessTvMode === undefined) {
      parsed.graphicsSettings.framelessTvMode = true;
    }
    if (typeof parsed.graphicsSettings.lightIntensity !== 'number') {
      parsed.graphicsSettings.lightIntensity = 0.95;
    }
    if (typeof parsed.graphicsSettings.backgroundBrightness !== 'number') {
      parsed.graphicsSettings.backgroundBrightness = 0.22;
    }
  }
  // Ensure famous starter species are present in speciesList
  const extraFamous = FAMOUS_AQUARIUM_FISHES_50.slice(0, 12).map((tpl) =>
    createSpeciesConfigFromFamousFish(tpl)
  );
  for (const sp of [...DEFAULT_SPECIES_LIST, ...extraFamous]) {
    const existing = parsed.speciesList.find((s) => s.id === sp.id);
    if (!existing) {
      parsed.speciesList.push(sp);
    } else {
      if (!existing.requiredOwnerLevel) existing.requiredOwnerLevel = sp.requiredOwnerLevel || 1;
      if (!existing.shopPriceCredits) existing.shopPriceCredits = sp.shopPriceCredits || 45;
    }
  }
  return parsed;
}

/**
 * Loads the player's progress (fishes, bought tanks, equipment, bio-credits) via `MyPC.load`
 * and mirrors to localStorage so the standalone AI Trainer (`trainer.html`) shares the state.
 */
export function loadEcosystemState(): SavedEcosystemState {
  const mypc = getMyPC();
  const cfg = mypc.app_config || {};
  const defaultCredits = Number(cfg.startingCredits) || 250;
  const defaultTier = Number(cfg.defaultTankTier) || 0;
  const defaultSpeed = Number(cfg.timeMultiplier) || 1;

  try {
    // Check shared localStorage first if updated recently by Trainer App, or MyPC.load
    const sharedRaw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(`mypc:abyssal-evo:${ECOSYSTEM_SAVE_KEY}`)
        : null;
    if (sharedRaw) {
      const parsed = JSON.parse(sharedRaw) as SavedEcosystemState;
      if (parsed && Array.isArray(parsed.fishes) && parsed.speciesList?.length) {
        return normalizeLoadedEcosystem(parsed);
      }
    }

    const fromMyPC = mypc.load<SavedEcosystemState | null>(ECOSYSTEM_SAVE_KEY, null);
    if (fromMyPC && Array.isArray(fromMyPC.fishes) && fromMyPC.speciesList?.length) {
      return normalizeLoadedEcosystem(fromMyPC);
    }
  } catch (e) {
    mypc.report(e, { stage: 'loadEcosystemState' });
  }

  const initial = createInitialEcosystemState(defaultCredits, defaultTier, defaultSpeed);
  saveEcosystemState(initial);
  return initial;
}

/**
 * Saves the player's progress (fishes, bought tanks, auto-feeders, credits) via `MyPC.save`
 * and mirrors to localStorage for immediate cross-tab Trainer access.
 */
export function saveEcosystemState(state: SavedEcosystemState): void {
  const mypc = getMyPC();
  try {
    mypc.save(ECOSYSTEM_SAVE_KEY, state);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`mypc:abyssal-evo:${ECOSYSTEM_SAVE_KEY}`, JSON.stringify(state));
    }
  } catch (e) {
    mypc.report(e, { stage: 'saveEcosystemState' });
  }
}

/**
 * Heartbeat lease management so the AI Trainer's Offline Fish Service knows which tanks/fishes
 * are currently being played with in `index.html` and NEVER interrupts their brain updates.
 */
export function publishActiveGameSessionLease(tankId: string, active: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(ACTIVE_LEASE_STORAGE_KEY);
    const leases: Record<string, number> = raw ? JSON.parse(raw) : {};
    if (active) {
      leases[tankId] = Date.now();
    } else {
      delete leases[tankId];
    }
    localStorage.setItem(ACTIVE_LEASE_STORAGE_KEY, JSON.stringify(leases));
  } catch {
    // ignore storage errors
  }
}

/**
 * Returns the list of tankIds currently locked by an active game session (heartbeat < 4500ms).
 */
export function getActiveGameSessionTankIds(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ACTIVE_LEASE_STORAGE_KEY);
    if (!raw) return [];
    const leases: Record<string, number> = JSON.parse(raw);
    const now = Date.now();
    const activeIds: string[] = [];
    for (const [tankId, ts] of Object.entries(leases)) {
      if (now - ts < 4500) {
        activeIds.push(tankId);
      }
    }
    return activeIds;
  } catch {
    return [];
  }
}
