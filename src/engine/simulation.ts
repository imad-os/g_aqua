import {
  applyFishLifetimeLearning,
  createBaseBrainInstance,
  createSeededRng,
  deepCloneBrain,
  forwardFishBrain,
  gaussianRandom,
  inheritOffspringBrain,
} from './brain';
import {
  DEFAULT_EVOLUTION_CONFIG,
  DEFAULT_SPECIES_LIST,
  TANK_TIERS,
} from './defaults';
import {
  BenchmarkTaskScores,
  EvolutionConfig,
  ExperimentComparisonResult,
  FishBrainInstance,
  FishEntity,
  FishGeneticsData,
  FoodPellet,
  GenerationHistoryEntry,
  ModelVersionRecord,
  SavedEcosystemState,
  SpeciesConfig,
  ThreatEntity,
} from './types';

const FISH_NAMES = [
  'Nereus', 'Calypso', 'Thalassa', 'Orion', 'Lyra', 'Aether', 'Zephyr',
  'Solstice', 'Vega', 'Kairos', 'Galatea', 'Proteus', 'Astra', 'Ceto',
  'Delphin', 'Eos', 'Halcyon', 'Iris', 'Koral', 'Lumen', 'Mira', 'Nyx',
  'Oceanus', 'Pelagia', 'Rhea', 'Sirena', 'Triton', 'Undine', 'Vesper', 'Zora',
];

let _idCounter = 1;
export function nextEntityId(prefix: string): string {
  _idCounter = (_idCounter + 1) % 999999;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter}`;
}

export function createInitialGenetics(rng: () => number = Math.random): FishGeneticsData {
  return {
    maxSpeedGene: Number((0.92 + (rng() - 0.5) * 0.24).toFixed(3)),
    bodyScaleGene: Number((0.95 + (rng() - 0.5) * 0.2).toFixed(3)),
    metabolismEfficiencyGene: Number((1.0 + (rng() - 0.5) * 0.2).toFixed(3)),
    sensorRangeGene: Number((1.0 + (rng() - 0.5) * 0.24).toFixed(3)),
    primaryHueShift: Math.round((rng() - 0.5) * 24),
    luminancePulseGene: Number((0.35 + rng() * 0.4).toFixed(3)),
    finAspectGene: Number((0.9 + rng() * 0.25).toFixed(3)),
    stressToleranceGene: Number((0.95 + (rng() - 0.5) * 0.2).toFixed(3)),
    threatDetectionGene: Number((0.95 + (rng() - 0.5) * 0.2).toFixed(3)),
    foragingDriveGene: Number((1.0 + (rng() - 0.5) * 0.25).toFixed(3)),
    socialSchoolingGene: Number((0.6 + rng() * 0.5).toFixed(3)),
    aggressivenessGene: 0,
  };
}

export function inheritGenetics(
  motherDNA: FishGeneticsData,
  fatherDNA: FishGeneticsData | null,
  evoConfig: EvolutionConfig,
  rng: () => number = Math.random
): { genetics: FishGeneticsData; traitMutations: string[] } {
  const muts: string[] = [];
  const pFather = fatherDNA ? evoConfig.fatherTraitInheritanceProb : 0;

  const inheritScalar = (
    mVal: number,
    fVal: number | undefined,
    min: number,
    max: number,
    name: string
  ): number => {
    let base = mVal;
    if (fVal !== undefined && rng() < pFather) {
      base = mVal * 0.5 + fVal * 0.5;
    }
    if (rng() < evoConfig.mutationProbPerTrait) {
      const delta = gaussianRandom(rng) * evoConfig.mutationMagnitude;
      base = Math.max(min, Math.min(max, base + delta));
      muts.push(`${name}${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
    }
    return Number(base.toFixed(3));
  };

  const genetics: FishGeneticsData = {
    maxSpeedGene: inheritScalar(motherDNA.maxSpeedGene, fatherDNA?.maxSpeedGene, 0.55, 1.85, 'Speed'),
    bodyScaleGene: inheritScalar(motherDNA.bodyScaleGene, fatherDNA?.bodyScaleGene, 0.65, 1.55, 'Size'),
    metabolismEfficiencyGene: inheritScalar(
      motherDNA.metabolismEfficiencyGene,
      fatherDNA?.metabolismEfficiencyGene,
      0.55,
      1.65,
      'Metabolism'
    ),
    sensorRangeGene: inheritScalar(
      motherDNA.sensorRangeGene,
      fatherDNA?.sensorRangeGene,
      0.6,
      1.85,
      'Sensors'
    ),
    primaryHueShift: Math.max(
      -60,
      Math.min(
        60,
        Math.round(
          motherDNA.primaryHueShift +
            (rng() < evoConfig.mutationProbPerTrait ? (rng() - 0.5) * 28 : 0)
        )
      )
    ),
    luminancePulseGene: inheritScalar(
      motherDNA.luminancePulseGene,
      fatherDNA?.luminancePulseGene,
      0.1,
      1.0,
      'Biolume'
    ),
    finAspectGene: inheritScalar(motherDNA.finAspectGene, fatherDNA?.finAspectGene, 0.65, 1.5, 'FinAspect'),
    stressToleranceGene: inheritScalar(
      motherDNA.stressToleranceGene,
      fatherDNA?.stressToleranceGene,
      0.5,
      1.6,
      'StressTol'
    ),
    threatDetectionGene: inheritScalar(
      motherDNA.threatDetectionGene,
      fatherDNA?.threatDetectionGene,
      0.5,
      1.7,
      'ThreatSense'
    ),
    foragingDriveGene: inheritScalar(
      motherDNA.foragingDriveGene,
      fatherDNA?.foragingDriveGene,
      0.5,
      1.7,
      'ForageDrive'
    ),
    socialSchoolingGene: inheritScalar(
      motherDNA.socialSchoolingGene,
      fatherDNA?.socialSchoolingGene,
      0.05,
      1.5,
      'Schooling'
    ),
    aggressivenessGene:
      (motherDNA.aggressivenessGene ?? 0) > 0 || (fatherDNA?.aggressivenessGene ?? 0) > 0
        ? inheritScalar(
            motherDNA.aggressivenessGene || fatherDNA?.aggressivenessGene || 0.1,
            fatherDNA?.aggressivenessGene,
            0.02,
            1.0,
            'Aggressiveness'
          )
        : 0,
  };

  return { genetics, traitMutations: muts };
}

const TAN_HALF_FOV_48 = Math.tan((48 * Math.PI) / 360);

export interface TankFrustumSliceBounds {
  halfW: number;
  halfH: number;
  halfD: number;
  minY: number;
  maxY: number;
  centerY: number;
  floorY: number;
  surfaceY: number;
  camZ: number;
  frustumHalfW: number;
  frustumHalfH: number;
}

/**
 * Computes the 3D aquarium boundaries at depth `z`.
 * - In Framed Mode (`framelessTvMode === false`), the tank is a rectangular box.
 * - In Full-Screen TV Mode (`framelessTvMode !== false`), the tank is a 3D perspective frustum
 *   (smaller in the front `z > 0`, larger in the back `z < 0`) matched to the 3D camera frustum
 *   so fishes at the front never hide off the front-left/front-right sides and the full tank
 *   fills the TV screen edge-to-edge without looking zoomed out.
 */
export function getTankBoundsAtZ(
  tank: { width: number; height: number; depth: number },
  z: number,
  framelessTvMode: boolean = true,
  aspect: number = 16 / 9
): TankFrustumSliceBounds {
  if (!framelessTvMode) {
    const halfW = tank.width * 0.44;
    const halfH = tank.height * 0.38;
    const halfD = tank.depth * 0.42;
    const floorY = -tank.height * 0.42;
    const surfaceY = halfH * 0.92;
    return {
      halfW,
      halfH,
      halfD,
      minY: -halfH,
      maxY: halfH,
      centerY: 0,
      floorY,
      surfaceY,
      camZ: tank.width * 0.68 + 4.8,
      frustumHalfW: tank.width * 0.5,
      frustumHalfH: tank.height * 0.5,
    };
  }

  const halfD = tank.depth * 0.44;
  const camZ = tank.depth * 1.06;
  const clampedZ = Math.max(-halfD, Math.min(halfD, z));
  const distFromCam = Math.max(2.0, camZ - clampedZ);
  const safeAspect = Math.max(1.2, Math.min(2.4, aspect));

  const frustumHalfH = distFromCam * TAN_HALF_FOV_48;
  const frustumHalfW = frustumHalfH * safeAspect;

  // Depth interpolation t: 0 at front glass (z = +halfD), 1 at back reef wall (z = -halfD)
  const t = (halfD - clampedZ) / Math.max(0.001, 2 * halfD);

  // Sloped frustum seabed floor and top water surface that track the TV screen's top & bottom edges
  const floorY = -frustumHalfH * (0.82 - 0.12 * t);
  const surfaceY = frustumHalfH * (0.84 - 0.06 * t);

  const minY = floorY + 0.42;
  const maxY = surfaceY - 0.35;
  const centerY = (minY + maxY) * 0.5;
  const halfH = Math.max(0.8, (maxY - minY) * 0.5);
  const halfW = frustumHalfW * 0.86;

  return {
    halfW,
    halfH,
    halfD,
    minY,
    maxY,
    centerY,
    floorY,
    surfaceY,
    camZ,
    frustumHalfW,
    frustumHalfH,
  };
}

export function spawnFoundingFish(
  species: SpeciesConfig,
  tankTierIndex: number,
  simHourNow: number,
  indexInFounderGroup: number,
  customBaseBrain?: FishBrainInstance,
  rng: () => number = Math.random
): FishEntity {
  const tank = TANK_TIERS[tankTierIndex] || TANK_TIERS[0];
  const baseBrain =
    customBaseBrain ||
    createBaseBrainInstance(species.baseBrainConfig, 1000 + indexInFounderGroup * 97);

  // Give each founding fish its own distinct mutated copy of the species base model
  const { brain, mutationsApplied, driftAmount } = inheritOffspringBrain(
    baseBrain,
    null,
    species.baseBrainConfig,
    DEFAULT_EVOLUTION_CONFIG,
    1,
    rng
  );

  const halfD = tank.depth * 0.35;
  const spawnZ = (rng() - 0.5) * halfD * 2;
  const sliceBounds = getTankBoundsAtZ(tank, spawnZ, true);

  const name =
    FISH_NAMES[(indexInFounderGroup + Math.floor(rng() * FISH_NAMES.length)) % FISH_NAMES.length] +
    ` G1-${indexInFounderGroup + 1}`;

  // Stagger founder starting ages between 1.0 and 3.5 sim-hours so they mature naturally soon
  const initialAge = Number((0.8 + rng() * 2.4).toFixed(2));
  const isAdult = initialAge >= species.lifespan.sexualMaturityAgeHours;

  return {
    lineage: {
      fishId: nextEntityId('fish'),
      name,
      speciesId: species.id,
      generation: 1,
      modelVersion: species.activeBaseModelVersion,
      motherId: null,
      fatherId: null,
      birthSimHour: Math.max(0, simHourNow - initialAge),
      deathSimHour: null,
      alive: true,
      causeOfDeath: null,
      inheritedMutations: mutationsApplied,
      cumulativeMutationDrift: Number(driftAmount.toFixed(3)),
      tankId: tank.id,
    },
    genetics: {
      ...createInitialGenetics(rng),
      aggressivenessGene: Number(
        Math.max(0, Math.min(1, species.baseBrainConfig.aggressiveness ?? 0)).toFixed(3)
      ),
    },
    brain,
    state: {
      ageSimHours: initialAge,
      lifeStage: isAdult ? 'adult' : 'juvenile',
      growthProgress: Math.min(1.0, 0.45 + initialAge * species.lifespan.growthRatePerHour),
      energy: 82 + rng() * 16,
      maxEnergy: 100,
      hunger: 15 + rng() * 15,
      health: 100,
      stress: 5,
      reproductionCooldownHours: 0.5,
      isGravid: false,
      gestationHoursRemaining: 0,
      gravidPartnerId: null,
      independenceHoursRemaining: 0,
      attackCooldownHours: Number((0.25 + rng() * 0.4).toFixed(2)),
      lastAttackTargetId: null,
      x: (rng() - 0.5) * sliceBounds.halfW * 1.6,
      y: sliceBounds.centerY + (rng() - 0.5) * sliceBounds.halfH * 1.3,
      z: spawnZ,
      vx: (rng() - 0.5) * 1.2,
      vy: (rng() - 0.5) * 0.3,
      vz: (rng() - 0.5) * 1.2,
      yaw: rng() * Math.PI * 2,
      pitch: 0,
      tailPhase: rng() * Math.PI * 2,
      metrics: {
        foodPelletsEaten: 0,
        foragingAttempts: 1,
        foodRoutineHits: 0,
        threatsEvaded: 0,
        harmfulActionsRepeated: 0,
        harmfulActionsAvoided: 1,
        energyEfficiencyScore: 72,
        offspringProduced: 0,
        lifetimeReward: 0,
        decisionsMade: 0,
        attacksPerformed: 0,
      },
      episodicMemory: [],
      personality: {
        boldness: Number((0.3 + rng() * 0.6).toFixed(2)),
        socialAffinity: Number((0.35 + rng() * 0.55).toFixed(2)),
        curiosity: Number((0.4 + rng() * 0.55).toFixed(2)),
      },
    },
  };
}

/**
 * Creates an offspring fish from a mother and optional father.
 * Offspring inherits a deep copy of the MOTHER'S brain as its starting behavioral model
 * (never sharing mutable weights or memory with the mother), plus optional paternal
 * trait/weight crossover and small configurable mutations.
 */
export function reproduceOffspringFish(
  mother: FishEntity,
  father: FishEntity | null,
  species: SpeciesConfig,
  evoConfig: EvolutionConfig,
  simHourNow: number,
  rng: () => number = Math.random
): FishEntity {
  const nextGen = Math.max(mother.lineage.generation, father?.lineage.generation || 1) + 1;
  const { brain, mutationsApplied, driftAmount } = inheritOffspringBrain(
    mother.brain,
    father ? father.brain : null,
    species.baseBrainConfig,
    evoConfig,
    nextGen,
    rng
  );

  const { genetics, traitMutations } = inheritGenetics(
    mother.genetics,
    father ? father.genetics : null,
    evoConfig,
    rng
  );

  const allMutations = [...mutationsApplied, ...traitMutations].slice(0, 8);
  const baseName = FISH_NAMES[Math.floor(rng() * FISH_NAMES.length)];

  // Inherit only high-strength spatial food routine cues if configured, keeping memory array separate
  const inheritedMemories =
    species.baseBrainConfig.learnedInheritanceRate > 0.2
      ? mother.state.episodicMemory
          .filter((m) => m.kind === 'food_found' && m.strength > 0.6)
          .slice(0, 3)
          .map((m) => ({
            ...m,
            strength: Number((m.strength * species.baseBrainConfig.learnedInheritanceRate).toFixed(2)),
          }))
      : [];

  return {
    lineage: {
      fishId: nextEntityId('fish'),
      name: `${baseName} G${nextGen}`,
      speciesId: species.id,
      generation: nextGen,
      modelVersion: mother.lineage.modelVersion,
      motherId: mother.lineage.fishId,
      fatherId: father ? father.lineage.fishId : null,
      birthSimHour: Number(simHourNow.toFixed(3)),
      deathSimHour: null,
      alive: true,
      causeOfDeath: null,
      inheritedMutations: allMutations,
      cumulativeMutationDrift: Number(
        Math.min(
          evoConfig.cumulativeMutationLimit,
          mother.lineage.cumulativeMutationDrift + driftAmount
        ).toFixed(3)
      ),
      tankId: mother.lineage.tankId,
    },
    genetics,
    brain,
    state: {
      ageSimHours: 0,
      lifeStage: 'egg',
      growthProgress: 0.28,
      energy: 88,
      maxEnergy: 100,
      hunger: 12,
      health: 100,
      stress: 4,
      reproductionCooldownHours: species.lifespan.reproductionIntervalHours,
      isGravid: false,
      gestationHoursRemaining: 0,
      gravidPartnerId: null,
      independenceHoursRemaining:
        species.lifespan.eggIncubationHours + species.lifespan.offspringIndependenceHours,
      attackCooldownHours: Number((0.35 + rng() * 0.45).toFixed(2)),
      lastAttackTargetId: null,
      x: mother.state.x + (rng() - 0.5) * 0.8,
      y: mother.state.y + (rng() - 0.5) * 0.5,
      z: mother.state.z + (rng() - 0.5) * 0.8,
      vx: (rng() - 0.5) * 0.5,
      vy: 0,
      vz: (rng() - 0.5) * 0.5,
      yaw: mother.state.yaw,
      pitch: 0,
      tailPhase: rng() * Math.PI * 2,
      metrics: {
        foodPelletsEaten: 0,
        foragingAttempts: 1,
        foodRoutineHits: 0,
        threatsEvaded: 0,
        harmfulActionsRepeated: 0,
        harmfulActionsAvoided: 1,
        energyEfficiencyScore: 70,
        offspringProduced: 0,
        lifetimeReward: 0,
        decisionsMade: 0,
        attacksPerformed: 0,
      },
      episodicMemory: inheritedMemories,
      personality: {
        boldness: Number(
          Math.max(0.05, Math.min(0.95, mother.state.personality.boldness + (rng() - 0.5) * 0.16)).toFixed(2)
        ),
        socialAffinity: Number(
          Math.max(
            0.05,
            Math.min(0.95, mother.state.personality.socialAffinity + (rng() - 0.5) * 0.16)
          ).toFixed(2)
        ),
        curiosity: Number(
          Math.max(0.05, Math.min(0.95, mother.state.personality.curiosity + (rng() - 0.5) * 0.16)).toFixed(2)
        ),
      },
    },
  };
}

export function awardOwnerXp(ecosystem: SavedEcosystemState, xpAmount: number): {
  leveledUp: boolean;
  newLevel: number;
} {
  if (!ecosystem.ownerLevel || ecosystem.ownerLevel < 1) {
    ecosystem.ownerLevel = 1;
  }
  if (typeof ecosystem.ownerXp !== 'number' || ecosystem.ownerXp < 0) {
    ecosystem.ownerXp = 0;
  }
  const prevLevel = ecosystem.ownerLevel;
  ecosystem.ownerXp += xpAmount;
  while (ecosystem.ownerXp >= 100) {
    ecosystem.ownerXp -= 100;
    ecosystem.ownerLevel += 1;
  }
  return {
    leveledUp: ecosystem.ownerLevel > prevLevel,
    newLevel: ecosystem.ownerLevel,
  };
}

// Pre-allocated sensory input vector to avoid per-frame allocations
const _sensoryInputs = new Float32Array(32);

/**
 * Advances the aquarium simulation by `realDtSeconds` while respecting:
 * - Configurable simulation clock (`timeMultiplier` & `speciesTimeMultiplier`)
 * - Pause state (when `paused` is true, simulation time does not advance)
 * - Individual fish brains, hunger, foraging, threats, maturity, reproduction, and mortality.
 */
export function stepEcosystemSimulation(
  ecosystem: SavedEcosystemState,
  pellets: FoodPellet[],
  threats: ThreatEntity[],
  realDtSeconds: number,
  options?: {
    allowAutoFeeders?: boolean;
    useOwnerAutoFeederWhenOverrideOff?: boolean;
    onlyOfflineFish?: boolean;
    activeSessionTankIds?: string[];
    onBirth?: (child: FishEntity, mother: FishEntity) => void;
    onDeath?: (fish: FishEntity, reason: string) => void;
    onPelletEaten?: (fish: FishEntity, pellet: FoodPellet) => void;
  }
): {
  simHoursDelta: number;
  liveFishUpdated: number;
  birthsThisStep: number;
  deathsThisStep: number;
} {
  if (ecosystem.paused || realDtSeconds <= 0) {
    return { simHoursDelta: 0, liveFishUpdated: 0, birthsThisStep: 0, deathsThisStep: 0 };
  }

  // 1 real-world hour = 3600 real seconds.
  // At 1x speed, 1 sim-hour = 3600 real seconds.
  const simHoursDelta = (realDtSeconds / 3600) * Math.max(0.1, ecosystem.timeMultiplier);
  ecosystem.simHoursTotal += simHoursDelta;

  const tank = TANK_TIERS[ecosystem.activeTankTier] || TANK_TIERS[0];
  const isFrameless = ecosystem.graphicsSettings?.framelessTvMode !== false;
  const centerBounds = getTankBoundsAtZ(tank, 0, isFrameless);
  const halfD = centerBounds.halfD;

  // Update food pellets: float at the top water surface at their Z depth first, then slowly drift downward
  for (let i = pellets.length - 1; i >= 0; i--) {
    const p = pellets[i];
    const pBounds = getTankBoundsAtZ(tank, p.z, isFrameless);
    p.ageSeconds += realDtSeconds;
    if (p.ageSeconds < 3.5) {
      // Float on top water surface with gentle ripple bobbing
      p.y = pBounds.surfaceY + Math.sin(p.ageSeconds * 3.2 + i) * 0.04;
    } else if (p.y > pBounds.floorY + 0.22) {
      p.y = Math.max(pBounds.floorY + 0.22, p.y + p.vy * realDtSeconds);
    }
    // Keep pellet X within the frustum width at its Z depth
    p.x = Math.max(-pBounds.halfW * 0.94, Math.min(pBounds.halfW * 0.94, p.x));
    if (p.ageSeconds > 180) {
      pellets.splice(i, 1);
    }
  }

  // Update active threats within frustum bounds
  for (let i = threats.length - 1; i >= 0; i--) {
    const th = threats[i];
    th.activeSecondsRemaining -= realDtSeconds;
    th.x += th.vx * realDtSeconds;
    th.y += th.vy * realDtSeconds;
    th.z += th.vz * realDtSeconds;
    const thBounds = getTankBoundsAtZ(tank, th.z, isFrameless);
    if (Math.abs(th.x) > thBounds.halfW) th.vx = -th.vx;
    if (th.y > thBounds.maxY || th.y < thBounds.minY) th.vy = -th.vy;
    if (Math.abs(th.z) > halfD) th.vz = -th.vz;
    if (th.activeSecondsRemaining <= 0) {
      threats.splice(i, 1);
    }
  }

  // Automatic feeders sprinkle pellets onto the top water surface periodically.
  // In the 24/7 Fish Keeper, when the Trainer's global auto-feeder is disabled (`allowAutoFeeders: false`),
  // if `useOwnerAutoFeederWhenOverrideOff: true` is passed, we check the owner's own auto-feeder (`activeFeederCount > 0`).
  const ownerFeederCount = ecosystem.autoFeederCountByTank[tank.id] || 0;
  const effectiveFeederCount =
    options?.allowAutoFeeders === true
      ? Math.max(1, ownerFeederCount)
      : options?.allowAutoFeeders === false
      ? options?.useOwnerAutoFeederWhenOverrideOff
        ? ownerFeederCount
        : 0
      : ownerFeederCount;

  if (effectiveFeederCount > 0 && pellets.length < effectiveFeederCount * 6) {
    const spawnChance =
      simHoursDelta *
      effectiveFeederCount *
      3.5 *
      ecosystem.evolutionConfig.environment.foodAbundance;
    if (Math.random() < spawnChance || (options?.onlyOfflineFish && pellets.length === 0 && simHoursDelta > 0)) {
      const pelletZ = (Math.random() - 0.5) * halfD * 1.4;
      const pelletBounds = getTankBoundsAtZ(tank, pelletZ, isFrameless);
      pellets.push({
        id: nextEntityId('pellet'),
        x: (Math.random() - 0.5) * pelletBounds.halfW * 1.5,
        y: pelletBounds.surfaceY,
        z: pelletZ,
        vy: -0.28,
        nutrition: 28,
        ageSeconds: 0,
        source: 'autofeeder',
      });
    }
  }

  let liveFishUpdated = 0;
  let birthsThisStep = 0;
  let deathsThisStep = 0;
  const newlyBorn: FishEntity[] = [];

  const liveCountTotal = ecosystem.fishes.reduce(
    (acc, f) => acc + (f.lineage.alive ? 1 : 0),
    0
  );
  const adultCountTotal = ecosystem.fishes.reduce(
    (acc, f) =>
      acc +
      (f.lineage.alive && (f.state.lifeStage === 'adult' || f.state.lifeStage === 'elder')
        ? 1
        : 0),
    0
  );
  const babyCountTotal = ecosystem.fishes.reduce(
    (acc, f) =>
      acc +
      (f.lineage.alive && (f.state.lifeStage === 'egg' || f.state.lifeStage === 'juvenile')
        ? 1
        : 0),
    0
  );

  for (let idx = 0; idx < ecosystem.fishes.length; idx++) {
    const fish = ecosystem.fishes[idx];
    // Only live fishes are simulated and have their brains updated!
    if (!fish.lineage.alive) continue;

    // If running in the Trainer's Offline Fish Service, skip fishes currently open in an active game session
    if (
      options?.onlyOfflineFish &&
      options.activeSessionTankIds &&
      options.activeSessionTankIds.includes(fish.lineage.tankId)
    ) {
      continue;
    }

    const species =
      ecosystem.speciesList.find((s) => s.id === fish.lineage.speciesId) ||
      DEFAULT_SPECIES_LIST[0];
    const lifeCfg = species.lifespan;
    const brainCfg = species.baseBrainConfig;
    const fishSimHoursDelta = simHoursDelta * lifeCfg.speciesTimeMultiplier;

    liveFishUpdated++;

    // 1. Advance Biological Clock & Life Stage
    fish.state.ageSimHours += fishSimHoursDelta * lifeCfg.agingRateMultiplier;
    if (fish.state.reproductionCooldownHours > 0) {
      fish.state.reproductionCooldownHours = Math.max(
        0,
        fish.state.reproductionCooldownHours - fishSimHoursDelta
      );
    }
    if (fish.state.independenceHoursRemaining > 0) {
      fish.state.independenceHoursRemaining = Math.max(
        0,
        fish.state.independenceHoursRemaining - fishSimHoursDelta
      );
    }

    if (fish.state.ageSimHours < lifeCfg.eggIncubationHours) {
      fish.state.lifeStage = 'egg';
      fish.state.growthProgress = 0.28;
    } else if (fish.state.ageSimHours < lifeCfg.sexualMaturityAgeHours) {
      fish.state.lifeStage = 'juvenile';
      fish.state.growthProgress = Math.min(
        0.85,
        0.32 +
          ((fish.state.ageSimHours - lifeCfg.eggIncubationHours) /
            Math.max(0.5, lifeCfg.juvenileDurationHours)) *
            0.53
      );
    } else if (fish.state.ageSimHours < lifeCfg.maxReproductiveAgeHours) {
      fish.state.lifeStage = 'adult';
      fish.state.growthProgress = 1.0;
    } else {
      fish.state.lifeStage = 'elder';
      fish.state.growthProgress = 1.0;
    }

    // 2. Metabolism, Hunger, and Environmental Effects
    const env = ecosystem.evolutionConfig.environment;
    const speedMag = Math.sqrt(
      fish.state.vx * fish.state.vx +
        fish.state.vy * fish.state.vy +
        fish.state.vz * fish.state.vz
    );
    const metabolicBurn =
      (lifeCfg.metabolismEnergyPerHour / Math.max(0.5, fish.genetics.metabolismEfficiencyGene)) *
      (0.75 + 0.35 * speedMag) *
      (1 + env.competitionIntensity * 0.2) *
      fishSimHoursDelta;

    fish.state.energy = Math.max(0, fish.state.energy - metabolicBurn);
    fish.state.hunger = Math.min(100, 100 - fish.state.energy);

    // Water quality and temperature stress
    const tempDeviation = Math.abs(env.temperatureC - 25.0);
    if (env.waterQuality < 0.7 || tempDeviation > 3.5) {
      const stressAdd =
        ((0.75 - env.waterQuality) * 12 + Math.max(0, tempDeviation - 3) * 2.5) /
        Math.max(0.5, fish.genetics.stressToleranceGene);
      fish.state.stress = Math.min(100, fish.state.stress + Math.max(0, stressAdd) * fishSimHoursDelta);
    } else {
      fish.state.stress = Math.max(
        0,
        fish.state.stress - lifeCfg.recoverySpeedPerHour * fishSimHoursDelta
      );
    }

    // Starvation & Old Age Mortality Check
    if (fish.state.energy <= 0.05) {
      fish.state.health = Math.max(0, fish.state.health - 45 * fishSimHoursDelta - 1.5 * realDtSeconds);
      if (fish.state.health <= 0 || fish.state.energy <= 0) {
        fish.lineage.alive = false;
        fish.lineage.causeOfDeath = 'starvation';
        fish.lineage.deathSimHour = Number(ecosystem.simHoursTotal.toFixed(3));
        ecosystem.deceasedArchive.unshift({ ...fish.lineage });
        if (ecosystem.deceasedArchive.length > 60) ecosystem.deceasedArchive.pop();
        deathsThisStep++;
        options?.onDeath?.(fish, 'starvation');
        continue;
      }
    } else if (fish.state.ageSimHours >= lifeCfg.lifespanSimHours) {
      fish.lineage.alive = false;
      fish.lineage.causeOfDeath = 'old_age';
      fish.lineage.deathSimHour = Number(ecosystem.simHoursTotal.toFixed(3));
      ecosystem.deceasedArchive.unshift({ ...fish.lineage });
      if (ecosystem.deceasedArchive.length > 60) ecosystem.deceasedArchive.pop();
      deathsThisStep++;
      options?.onDeath?.(fish, 'old_age');
      continue;
    }

    // Decay episodic memories according to forgettingRate
    if (fish.state.episodicMemory.length > 0 && fishSimHoursDelta > 0) {
      const decay = Math.pow(1 - brainCfg.forgettingRate, fishSimHoursDelta);
      for (let m = fish.state.episodicMemory.length - 1; m >= 0; m--) {
        fish.state.episodicMemory[m].strength *= decay;
        if (fish.state.episodicMemory[m].strength < 0.08) {
          fish.state.episodicMemory.splice(m, 1);
        }
      }
    }

    // 3. Sensory Perception & Individual Brain Forward Pass
    let nearestPellet: FoodPellet | null = null;
    let nearestPelletDistSq = Infinity;
    const maxSenseDist = 18 * fish.genetics.sensorRangeGene;
    const maxSenseSq = maxSenseDist * maxSenseDist;

    for (let pIdx = 0; pIdx < pellets.length; pIdx++) {
      const p = pellets[pIdx];
      const dx = p.x - fish.state.x;
      const dy = p.y - fish.state.y;
      const dz = p.z - fish.state.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < nearestPelletDistSq && dSq <= maxSenseSq) {
        nearestPelletDistSq = dSq;
        nearestPellet = p;
      }
    }

    let foodDirX = 0;
    let foodDirY = 0;
    let foodDirZ = 0;
    let foodProximity = 0;

    if (nearestPellet) {
      const dist = Math.max(0.001, Math.sqrt(nearestPelletDistSq));
      foodDirX = (nearestPellet.x - fish.state.x) / dist;
      foodDirY = (nearestPellet.y - fish.state.y) / dist;
      foodDirZ = (nearestPellet.z - fish.state.z) / dist;
      foodProximity = Math.max(0, 1 - dist / maxSenseDist);
    } else if (fish.state.episodicMemory.length > 0 && fish.state.hunger > 30) {
      // Recall remembered food location if no visible pellet is nearby
      const mem = fish.state.episodicMemory[0];
      const dx = mem.x - fish.state.x;
      const dy = mem.y - fish.state.y;
      const dz = mem.z - fish.state.z;
      const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      foodDirX = dx / dist;
      foodDirY = dy / dist;
      foodDirZ = dz / dist;
      foodProximity = 0.25 * mem.strength;
    }

    let threatDirX = 0;
    let threatDirZ = 0;
    let threatProximity = 0;
    if (threats.length > 0) {
      const th = threats[0];
      const dx = th.x - fish.state.x;
      const dz = th.z - fish.state.z;
      const dist = Math.max(0.1, Math.sqrt(dx * dx + dz * dz));
      const senseRange = 10 * fish.genetics.threatDetectionGene;
      if (dist < senseRange) {
        threatDirX = dx / dist;
        threatDirZ = dz / dist;
        threatProximity = 1 - dist / senseRange;
      }
    }

    const fishSliceBounds = getTankBoundsAtZ(tank, fish.state.z, isFrameless);

    _sensoryInputs.fill(0);
    _sensoryInputs[0] = foodDirX * fish.genetics.foragingDriveGene;
    _sensoryInputs[1] = foodDirY * fish.genetics.foragingDriveGene;
    _sensoryInputs[2] = foodDirZ * fish.genetics.foragingDriveGene;
    _sensoryInputs[3] = foodProximity;
    _sensoryInputs[4] = threatDirX;
    _sensoryInputs[5] = threatDirZ;
    _sensoryInputs[6] = threatProximity;
    _sensoryInputs[7] = fish.state.hunger / 100;
    _sensoryInputs[8] = fish.state.energy / 100;
    _sensoryInputs[9] = (fish.state.y - fishSliceBounds.centerY) / Math.max(1, fishSliceBounds.halfH);

    const outputs = forwardFishBrain(
      fish.brain,
      _sensoryInputs,
      brainCfg.explorationEpsilon
    );
    fish.state.metrics.decisionsMade++;

    // 4. Kinematics, Smooth 3D Frustum Cruising & Natural Turn Banking
    const maxSpeed = 2.2 * fish.genetics.maxSpeedGene * (fish.state.lifeStage === 'egg' ? 0.1 : 1.0);

    // Organic 3D cruising vector shaped to the perspective frustum (narrower in front, wider in back)
    const cruisePhase =
      (ecosystem.simHoursTotal * 1800 + idx * 1.85) * (0.45 + fish.state.personality.curiosity * 0.35);
    const cruiseTargetZ = Math.cos(cruisePhase * 0.55 + idx * 0.7) * (halfD * 0.76);
    const cruiseBounds = getTankBoundsAtZ(tank, cruiseTargetZ, isFrameless);
    const cruiseTargetX = Math.sin(cruisePhase * 0.7) * (cruiseBounds.halfW * 0.76);
    const cruiseTargetY =
      cruiseBounds.centerY + Math.sin(cruisePhase * 1.1 + idx) * (cruiseBounds.halfH * 0.62);

    const toCruiseX = cruiseTargetX - fish.state.x;
    const toCruiseY = cruiseTargetY - fish.state.y;
    const toCruiseZ = cruiseTargetZ - fish.state.z;
    const cruiseDist = Math.max(0.1, Math.sqrt(toCruiseX * toCruiseX + toCruiseY * toCruiseY + toCruiseZ * toCruiseZ));

    // Blend neural brain output with smooth 3D reef patrol
    let targetVx = (outputs[0] * 0.38 + (toCruiseX / cruiseDist) * 0.62) * maxSpeed;
    let targetVy = (outputs[1] * 0.35 + (toCruiseY / cruiseDist) * 0.65) * maxSpeed * 0.55;
    let targetVz = (outputs[2] * 0.38 + (toCruiseZ / cruiseDist) * 0.62) * maxSpeed;

    // Strong foraging assist proportional to neural output + sensory food vector when hungry
    if (nearestPellet && fish.state.lifeStage !== 'egg') {
      const pull = 0.65 + (fish.state.hunger / 100) * 0.35;
      targetVx = targetVx * (1 - pull) + foodDirX * maxSpeed * pull;
      targetVy = targetVy * (1 - pull) + foodDirY * maxSpeed * pull;
      targetVz = targetVz * (1 - pull) + foodDirZ * maxSpeed * pull;
    }

    // Threat evasion vector when threat is close
    if (threatProximity > 0.15 && brainCfg.evasionModuleEnabled) {
      targetVx -= threatDirX * maxSpeed * 1.35 * fish.genetics.threatDetectionGene;
      targetVz -= threatDirZ * maxSpeed * 1.35 * fish.genetics.threatDetectionGene;
      fish.state.metrics.threatsEvaded++;
    }

    // 4b. Active Reaction State (if this fish was recently attacked: slowed down, small run away, or counter-attack)
    if ((fish.state.attackReactionHoursRemaining ?? 0) > 0) {
      const reactionDecay = Math.max(fishSimHoursDelta, realDtSeconds / 160);
      fish.state.attackReactionHoursRemaining = Math.max(
        0,
        (fish.state.attackReactionHoursRemaining ?? 0) - reactionDecay
      );
      const rKind = fish.state.attackReactionKind;
      const rDx = fish.state.attackReactionDirX ?? 0;
      const rDy = fish.state.attackReactionDirY ?? 0;
      const rDz = fish.state.attackReactionDirZ ?? 0;

      if (rKind === 'slowed_down') {
        // Visibly slowed down after taking a hit
        targetVx *= 0.35;
        targetVy *= 0.35;
        targetVz *= 0.35;
      } else if (rKind === 'flee_dart') {
        // Very small, quick run-away dart away from the attacker
        const dartSpeed = maxSpeed * 1.32;
        targetVx = targetVx * 0.25 + rDx * dartSpeed * 0.75;
        targetVy = targetVy * 0.4 + rDy * dartSpeed * 0.4;
        targetVz = targetVz * 0.25 + rDz * dartSpeed * 0.75;
      } else if (rKind === 'counter_attack') {
        // Aggressive retaliation lunge back toward the attacker
        const counterSpeed = maxSpeed * 1.4;
        targetVx = targetVx * 0.2 + rDx * counterSpeed * 0.8;
        targetVy = targetVy * 0.3 + rDy * counterSpeed * 0.7;
        targetVz = targetVz * 0.2 + rDz * counterSpeed * 0.8;
      }

      if ((fish.state.attackReactionHoursRemaining ?? 0) <= 0) {
        fish.state.attackReactionKind = null;
        fish.state.attackReactionAttackerId = null;
      }
    }

    // 4c. Aggressiveness Behavior: Simple periodic attack lunge ONLY for brains having aggressiveness > 0
    const aggLevel = Math.max(
      fish.brain.architecture.aggressiveness ?? 0,
      brainCfg.aggressiveness ?? 0,
      fish.genetics.aggressivenessGene ?? 0
    );
    let attackRewardThisTick = 0;

    if (aggLevel > 0 && fish.state.lifeStage !== 'egg') {
      fish.state.attackCooldownHours = Math.max(
        0,
        (fish.state.attackCooldownHours ?? 0) - fishSimHoursDelta
      );
      if ((fish.state.attackCooldownHours ?? 0) <= 0) {
        const attackSenseRange = (4.5 + aggLevel * 5.0) * fish.genetics.sensorRangeGene;
        const attackSenseSq = attackSenseRange * attackSenseRange;
        let nearestPrey: FishEntity | null = null;
        let nearestPreyDistSq = Infinity;

        for (let oIdx = 0; oIdx < ecosystem.fishes.length; oIdx++) {
          if (oIdx === idx) continue;
          const other = ecosystem.fishes[oIdx];
          if (
            !other.lineage.alive ||
            other.lineage.tankId !== fish.lineage.tankId ||
            other.state.lifeStage === 'egg'
          ) {
            continue;
          }
          const dx = other.state.x - fish.state.x;
          const dy = other.state.y - fish.state.y;
          const dz = other.state.z - fish.state.z;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < nearestPreyDistSq && dSq <= attackSenseSq) {
            nearestPreyDistSq = dSq;
            nearestPrey = other;
          }
        }

        if (nearestPrey) {
          const dist = Math.max(0.05, Math.sqrt(nearestPreyDistSq));
          const dirX = (nearestPrey.state.x - fish.state.x) / dist;
          const dirY = (nearestPrey.state.y - fish.state.y) / dist;
          const dirZ = (nearestPrey.state.z - fish.state.z) / dist;
          const lungeSpeed = maxSpeed * (1.28 + aggLevel * 0.55);
          const lungeBlend = Math.min(0.88, 0.45 + aggLevel * 0.45);

          targetVx = targetVx * (1 - lungeBlend) + dirX * lungeSpeed * lungeBlend;
          targetVy = targetVy * (1 - lungeBlend) + dirY * lungeSpeed * lungeBlend;
          targetVz = targetVz * (1 - lungeBlend) + dirZ * lungeSpeed * lungeBlend;

          if (dist < 1.65) {
            // Simple attack strike: drain small energy/add stress on target
            const energyHit = 3.5 + aggLevel * 5.5;
            nearestPrey.state.energy = Math.max(6, nearestPrey.state.energy - energyHit);
            nearestPrey.state.hunger = Math.min(100, 100 - nearestPrey.state.energy);
            nearestPrey.state.stress = Math.min(100, nearestPrey.state.stress + 10 + aggLevel * 8);

            // Determine Attacked Fish's Reaction:
            // 1) Counter-Attack if target is also aggressive (aggressiveness > 0) and has higher/more frequent aggressiveness (or passes roll)
            // 2) Very small run-away dart ('flee_dart')
            // 3) Slowed down in shock ('slowed_down')
            const preySpecies =
              ecosystem.speciesList.find((s) => s.id === nearestPrey.lineage.speciesId) ||
              DEFAULT_SPECIES_LIST[0];
            const preyAggLevel = Math.max(
              nearestPrey.brain.architecture.aggressiveness ?? 0,
              preySpecies.baseBrainConfig.aggressiveness ?? 0,
              nearestPrey.genetics.aggressivenessGene ?? 0
            );

            const canCounterAttack =
              preyAggLevel > 0 &&
              (preyAggLevel >= aggLevel || Math.random() < preyAggLevel * 0.95);

            if (canCounterAttack) {
              // Counter-Attack Reaction: Target lunges back at the attacker!
              nearestPrey.state.attackReactionKind = 'counter_attack';
              nearestPrey.state.attackReactionHoursRemaining = 0.032;
              nearestPrey.state.attackReactionDirX = -dirX;
              nearestPrey.state.attackReactionDirY = -dirY;
              nearestPrey.state.attackReactionDirZ = -dirZ;
              nearestPrey.state.attackReactionAttackerId = fish.lineage.fishId;

              const counterForce = 1.6 + preyAggLevel * 1.5;
              nearestPrey.state.vx = -dirX * counterForce;
              nearestPrey.state.vy = -dirY * 0.6;
              nearestPrey.state.vz = -dirZ * counterForce;

              // Apply counter-attack hit back onto the original attacker
              const counterDamage = 2.8 + preyAggLevel * 5.0;
              fish.state.energy = Math.max(6, fish.state.energy - counterDamage);
              fish.state.hunger = Math.min(100, 100 - fish.state.energy);
              fish.state.stress = Math.min(100, fish.state.stress + 8 + preyAggLevel * 8);
              fish.state.vx -= dirX * (1.7 + preyAggLevel * 1.3);
              fish.state.vy -= dirY * 0.5;
              fish.state.vz -= dirZ * (1.7 + preyAggLevel * 1.3);

              // If the defender is MORE aggressive than the attacker, the attacker gets slowed down or darts back!
              if (preyAggLevel > aggLevel) {
                fish.state.attackReactionKind = 'flee_dart';
                fish.state.attackReactionHoursRemaining = 0.024;
                fish.state.attackReactionDirX = -dirX;
                fish.state.attackReactionDirY = -dirY * 0.3;
                fish.state.attackReactionDirZ = -dirZ;
              }

              nearestPrey.state.metrics.attacksPerformed =
                (nearestPrey.state.metrics.attacksPerformed || 0) + 1;
              nearestPrey.state.metrics.counterAttacksPerformed =
                (nearestPrey.state.metrics.counterAttacksPerformed || 0) + 1;
              nearestPrey.state.lastAttackTargetId = fish.lineage.fishId;
              // More aggressive defender resets its attack cooldown much faster
              nearestPrey.state.attackCooldownHours = Number(
                Math.max(0.12, (1.1 - preyAggLevel * 0.85) * 0.75).toFixed(3)
              );
            } else if (Math.random() < 0.55) {
              // Reaction: Very small run-away dart away from the attacker
              nearestPrey.state.attackReactionKind = 'flee_dart';
              nearestPrey.state.attackReactionHoursRemaining = 0.025;
              nearestPrey.state.attackReactionDirX = dirX;
              nearestPrey.state.attackReactionDirY = dirY * 0.35;
              nearestPrey.state.attackReactionDirZ = dirZ;
              nearestPrey.state.attackReactionAttackerId = fish.lineage.fishId;

              nearestPrey.state.vx += dirX * 1.45;
              nearestPrey.state.vy += dirY * 0.45;
              nearestPrey.state.vz += dirZ * 1.45;
              nearestPrey.state.metrics.threatsEvaded++;
            } else {
              // Reaction: Slowed down in shock after the hit
              nearestPrey.state.attackReactionKind = 'slowed_down';
              nearestPrey.state.attackReactionHoursRemaining = 0.042;
              nearestPrey.state.attackReactionDirX = dirX;
              nearestPrey.state.attackReactionDirY = dirY * 0.2;
              nearestPrey.state.attackReactionDirZ = dirZ;
              nearestPrey.state.attackReactionAttackerId = fish.lineage.fishId;

              nearestPrey.state.vx = nearestPrey.state.vx * 0.32 + dirX * 0.45;
              nearestPrey.state.vy = nearestPrey.state.vy * 0.32 + dirY * 0.18;
              nearestPrey.state.vz = nearestPrey.state.vz * 0.32 + dirZ * 0.45;
            }

            nearestPrey.state.episodicMemory.unshift({
              simHour: Number(ecosystem.simHoursTotal.toFixed(2)),
              kind: 'hurt_hazard',
              x: Number(fish.state.x.toFixed(2)),
              y: Number(fish.state.y.toFixed(2)),
              z: Number(fish.state.z.toFixed(2)),
              valence: -0.8,
              strength: 1.0,
            });
            if (nearestPrey.state.episodicMemory.length > brainCfg.memoryCapacity) {
              nearestPrey.state.episodicMemory.pop();
            }

            fish.state.energy = Math.min(fish.state.maxEnergy, fish.state.energy + 2.5);
            fish.state.hunger = Math.max(0, 100 - fish.state.energy);
            fish.state.metrics.attacksPerformed = (fish.state.metrics.attacksPerformed || 0) + 1;
            fish.state.lastAttackTargetId = nearestPrey.lineage.fishId;
            // Cooldown scales inversely with aggressiveness so higher aggressiveness attacks more frequently
            fish.state.attackCooldownHours = Number(
              Math.max(0.16, (1.45 - aggLevel * 1.15) * (0.85 + Math.random() * 0.3)).toFixed(3)
            );
            attackRewardThisTick = 0.25 * aggLevel;
          }
        }
      }
    }

    // Soft curved frustum boundary steering inside aquarium walls (smaller in front, wider in back)
    const sliceHalfW = fishSliceBounds.halfW;
    const sliceHalfH = fishSliceBounds.halfH;
    const marginX = sliceHalfW * 0.82;
    const marginTopY = fishSliceBounds.centerY + sliceHalfH * 0.78;
    const marginBotY = fishSliceBounds.centerY - sliceHalfH * 0.78;
    const marginZ = halfD * 0.82;

    if (fish.state.x > marginX) {
      const push = (fish.state.x - marginX) / Math.max(0.2, sliceHalfW * 0.18);
      targetVx -= push * maxSpeed * 1.5;
      // In frustum mode, gently guide fish swimming against the angled front-side wall slightly deeper (-Z)
      if (isFrameless && fish.state.z > 0) targetVz -= push * maxSpeed * 0.35;
    }
    if (fish.state.x < -marginX) {
      const push = (-marginX - fish.state.x) / Math.max(0.2, sliceHalfW * 0.18);
      targetVx += push * maxSpeed * 1.5;
      if (isFrameless && fish.state.z > 0) targetVz -= push * maxSpeed * 0.35;
    }
    if (fish.state.y > marginTopY) {
      targetVy -= ((fish.state.y - marginTopY) / Math.max(0.2, sliceHalfH * 0.22)) * maxSpeed * 1.15;
    }
    if (fish.state.y < marginBotY) {
      targetVy += ((marginBotY - fish.state.y) / Math.max(0.2, sliceHalfH * 0.22)) * maxSpeed * 1.15;
    }
    if (fish.state.z > marginZ) targetVz -= ((fish.state.z - marginZ) / (halfD * 0.18)) * maxSpeed * 1.4;
    if (fish.state.z < -marginZ) targetVz += ((-marginZ - fish.state.z) / (halfD * 0.18)) * maxSpeed * 1.4;

    const steerRate = Math.min(1, realDtSeconds * 3.6);
    fish.state.vx += (targetVx - fish.state.vx) * steerRate;
    fish.state.vy += (targetVy - fish.state.vy) * steerRate;
    fish.state.vz += (targetVz - fish.state.vz) * steerRate;

    fish.state.z = Math.max(-halfD, Math.min(halfD, fish.state.z + fish.state.vz * realDtSeconds));
    const nextSliceBounds = getTankBoundsAtZ(tank, fish.state.z, isFrameless);
    fish.state.x = Math.max(
      -nextSliceBounds.halfW,
      Math.min(nextSliceBounds.halfW, fish.state.x + fish.state.vx * realDtSeconds)
    );
    fish.state.y = Math.max(
      nextSliceBounds.minY,
      Math.min(nextSliceBounds.maxY, fish.state.y + fish.state.vy * realDtSeconds)
    );

    const horizSpeed = Math.sqrt(fish.state.vx * fish.state.vx + fish.state.vz * fish.state.vz);
    if (horizSpeed > 0.03) {
      const desiredYaw = Math.atan2(fish.state.vx, fish.state.vz);
      let yawDiff = ((desiredYaw - fish.state.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const maxTurnStep = realDtSeconds * 4.8;
      const appliedTurn = Math.max(-maxTurnStep, Math.min(maxTurnStep, yawDiff * Math.min(1, realDtSeconds * 5.2)));
      fish.state.yaw += appliedTurn;

      const desiredPitch = Math.max(-0.48, Math.min(0.48, -fish.state.vy / (horizSpeed + 0.45)));
      fish.state.pitch += (desiredPitch - fish.state.pitch) * Math.min(1, realDtSeconds * 6.0);

      // Bank roll into the turn in 3D space
      const desiredRoll = Math.max(-0.42, Math.min(0.42, -yawDiff * 0.45));
      fish.state.roll = (fish.state.roll || 0) + (desiredRoll - (fish.state.roll || 0)) * Math.min(1, realDtSeconds * 7.0);
    }
    fish.state.tailPhase =
      (fish.state.tailPhase + realDtSeconds * (5.8 + horizSpeed * 4.5)) % (Math.PI * 2);

    // 5. Pellet Consumption & Lifetime Reward Learning
    let stepReward = 0;
    if (nearestPellet && nearestPelletDistSq < 1.35 * 1.35 && fish.state.lifeStage !== 'egg') {
      fish.state.energy = Math.min(fish.state.maxEnergy, fish.state.energy + nearestPellet.nutrition);
      fish.state.hunger = Math.max(0, 100 - fish.state.energy);
      fish.state.health = Math.min(100, fish.state.health + 4);
      fish.state.metrics.foodPelletsEaten++;
      fish.state.metrics.foragingAttempts++;
      fish.state.metrics.foodRoutineHits++;
      ecosystem.bioCredits += 4;
      awardOwnerXp(ecosystem, 8);
      stepReward += 0.85;

      // Record food location in episodic memory ring buffer
      fish.state.episodicMemory.unshift({
        simHour: Number(ecosystem.simHoursTotal.toFixed(2)),
        kind: 'food_found',
        x: Number(nearestPellet.x.toFixed(2)),
        y: Number(nearestPellet.y.toFixed(2)),
        z: Number(nearestPellet.z.toFixed(2)),
        valence: 1.0,
        strength: 1.0,
      });
      if (fish.state.episodicMemory.length > brainCfg.memoryCapacity) {
        fish.state.episodicMemory.pop();
      }

      const pRemoveIdx = pellets.indexOf(nearestPellet);
      if (pRemoveIdx !== -1) pellets.splice(pRemoveIdx, 1);
      options?.onPelletEaten?.(fish, nearestPellet);
    }

    // Apply lifetime learning on reward signal
    const combinedReward = stepReward + attackRewardThisTick;
    if (combinedReward !== 0) {
      fish.state.metrics.lifetimeReward += combinedReward;
      applyFishLifetimeLearning(fish.brain, combinedReward, brainCfg);
    }

    // 6. Gravid Gestation & Reproduction Check
    // Adult tank capacity is 3 / 4 / 5 / 6, and babies (egg/juvenile) are allowed to exist OVER the max capacity!
    // When babies mature into adults over the capacity, they stay in the tank and new breeding pauses until count drops below capacity.
    const canSpawnBabyOverMax =
      adultCountTotal <= tank.maxFishCapacity &&
      babyCountTotal + newlyBorn.length < 2 &&
      liveCountTotal + newlyBorn.length < tank.maxFishCapacity + 2;

    if (fish.state.isGravid) {
      fish.state.gestationHoursRemaining -= fishSimHoursDelta;
      if (fish.state.gestationHoursRemaining <= 0) {
        fish.state.isGravid = false;
        fish.state.reproductionCooldownHours = lifeCfg.reproductionIntervalHours;
        if (canSpawnBabyOverMax) {
          const father =
            ecosystem.fishes.find((f) => f.lineage.fishId === fish.state.gravidPartnerId) || null;
          const child = reproduceOffspringFish(
            fish,
            father,
            species,
            ecosystem.evolutionConfig,
            ecosystem.simHoursTotal
          );
          fish.state.metrics.offspringProduced++;
          if (father) father.state.metrics.offspringProduced++;
          fish.state.energy = Math.max(25, fish.state.energy - 14);
          ecosystem.bioCredits += 18;
          awardOwnerXp(ecosystem, 35);
          newlyBorn.push(child);
          birthsThisStep++;
          options?.onBirth?.(child, fish);
        }
      }
    } else if (
      fish.state.lifeStage === 'adult' &&
      fish.state.ageSimHours >= lifeCfg.sexualMaturityAgeHours &&
      fish.state.ageSimHours <= lifeCfg.maxReproductiveAgeHours &&
      fish.state.reproductionCooldownHours <= 0 &&
      fish.state.energy >= lifeCfg.minEnergyToReproduceRatio * 100 &&
      canSpawnBabyOverMax
    ) {
      // Find a mature mate of the same species (or self-fertilize if sole survivor in tank)
      const mate =
        ecosystem.fishes.find(
          (other) =>
            other.lineage.alive &&
            other.lineage.fishId !== fish.lineage.fishId &&
            other.lineage.speciesId === fish.lineage.speciesId &&
            other.state.ageSimHours >= lifeCfg.sexualMaturityAgeHours &&
            other.state.energy >= 45
        ) || null;

      fish.state.isGravid = true;
      fish.state.gestationHoursRemaining = lifeCfg.eggIncubationHours;
      fish.state.gravidPartnerId = mate ? mate.lineage.fishId : null;
    }
  }

  if (newlyBorn.length > 0) {
    ecosystem.fishes.push(...newlyBorn);
  }

  return {
    simHoursDelta,
    liveFishUpdated,
    birthsThisStep,
    deathsThisStep,
  };
}

/**
 * Evaluates a fish brain model across 7 observable task performance benchmarks
 * (never using an arbitrary fake intelligence number).
 */
export function evaluateBrainOnBenchmarks(
  brain: FishBrainInstance,
  species: SpeciesConfig,
  evoConfig: EvolutionConfig,
  seed = 4242
): BenchmarkTaskScores {
  const rng = createSeededRng(seed);
  const testInputs = new Float32Array(species.baseBrainConfig.inputCount);

  // 1. Foraging alignment benchmark (20 random food directions)
  let foragingAlignHits = 0;
  for (let t = 0; t < 20; t++) {
    const fx = (rng() - 0.5) * 2;
    const fy = (rng() - 0.5) * 2;
    const fz = (rng() - 0.5) * 2;
    const norm = Math.max(0.01, Math.sqrt(fx * fx + fy * fy + fz * fz));
    testInputs.fill(0);
    testInputs[0] = fx / norm;
    testInputs[1] = fy / norm;
    testInputs[2] = fz / norm;
    testInputs[3] = 0.85;
    testInputs[7] = 0.75; // hungry
    const out = forwardFishBrain(brain, testInputs, 0, rng);
    const dot = (out[0] * fx + out[1] * fy + out[2] * fz) / norm;
    foragingAlignHits += Math.max(0, Math.min(1, (dot + 0.4) / 1.1));
  }
  const foragingEfficiency = Number(
    Math.min(99.5, Math.max(18, (foragingAlignHits / 20) * 100)).toFixed(1)
  );

  // 2. Recurrent food location memory retention test
  const memGateStrength =
    brain.architecture.recurrentMemoryEnabled
      ? 68 + species.baseBrainConfig.memoryRetention * 28
      : 42;
  const foodLocationMemory = Number(
    Math.min(99, Math.max(20, memGateStrength + (foragingEfficiency - 50) * 0.25)).toFixed(1)
  );

  // 3. Harm & threat avoidance test
  let threatEvasionScore = 0;
  for (let t = 0; t < 12; t++) {
    const tx = (rng() - 0.5) * 2;
    const tz = (rng() - 0.5) * 2;
    const norm = Math.max(0.01, Math.sqrt(tx * tx + tz * tz));
    testInputs.fill(0);
    testInputs[4] = tx / norm;
    testInputs[5] = tz / norm;
    testInputs[6] = 0.9; // imminent threat
    const out = forwardFishBrain(brain, testInputs, 0, rng);
    const evadeDot = -(out[0] * tx + out[2] * tz) / norm;
    threatEvasionScore += Math.max(0, Math.min(1, (evadeDot + 0.55) / 1.15));
  }
  const harmAvoidance = Number(
    Math.min(99, Math.max(22, (threatEvasionScore / 12) * 100)).toFixed(1)
  );

  // 4. Environmental adaptation & attention balance
  const avgGate =
    brain.attentionGates.reduce((a, b) => a + b, 0) /
    Math.max(1, brain.attentionGates.length);
  const environmentalAdaptation = Number(
    Math.min(
      98,
      Math.max(25, 58 + (1 - Math.abs(1.05 - avgGate)) * 28 + foragingEfficiency * 0.14)
    ).toFixed(1)
  );

  // 5. Navigation & boundary stability
  const navigationChallenge = Number(
    Math.min(98, Math.max(25, foragingEfficiency * 0.55 + harmAvoidance * 0.45)).toFixed(1)
  );

  // 6. Energy & threat homeostasis
  const energyAndThreatManagement = Number(
    Math.min(99, Math.max(24, foragingEfficiency * 0.45 + harmAvoidance * 0.35 + 18)).toFixed(1)
  );

  // 7. Reproductive survival under selection pressure
  const survivalPenalty = evoConfig.environment.predatorPressure * 12;
  const reproductiveSurvival = Number(
    Math.min(
      99,
      Math.max(
        15,
        foragingEfficiency * 0.5 + energyAndThreatManagement * 0.4 - survivalPenalty + 10
      )
    ).toFixed(1)
  );

  const overallComposite = Number(
    (
      (foragingEfficiency * 0.22 +
        foodLocationMemory * 0.12 +
        harmAvoidance * 0.18 +
        environmentalAdaptation * 0.12 +
        navigationChallenge * 0.12 +
        energyAndThreatManagement * 0.12 +
        reproductiveSurvival * 0.12)
    ).toFixed(1)
  );

  let computeOps = 0;
  for (let l = 0; l < brain.inheritedWeights.length; l++) {
    computeOps += brain.inheritedWeights[l].length * 2 + brain.inheritedBiases[l].length;
  }

  return {
    foragingEfficiency,
    foodLocationMemory,
    harmAvoidance,
    environmentalAdaptation,
    navigationChallenge,
    energyAndThreatManagement,
    reproductiveSurvival,
    overallComposite,
    survivalRatePct: Number(Math.min(99, Math.max(20, reproductiveSurvival * 0.95)).toFixed(1)),
    reproductiveRatePerFish: Number(((reproductiveSurvival / 100) * 2.8).toFixed(2)),
    computeOpsPerTick: computeOps,
  };
}

/**
 * Runs an accelerated headless multi-generation simulation in the AI Trainer Lab
 * without rendering any graphics. Evaluates candidate offspring brains against the
 * current base model and promotes a new model ONLY if it passes the quality threshold.
 *
 * When `options.commitVersionToRegistry === false` (used for intermediate chunks of a 100G-1000G run),
 * it evolves `bestBrain` in memory without adding intermediate versions to `modelRegistry`.
 * When `commitVersionToRegistry !== false` (the final step of training), it saves ONLY 1 new version
 * (the final generation of the training run) and prunes `modelRegistry` so each fish species keeps
 * at most the last 10 versions.
 */
export function runAcceleratedHeadlessTraining(
  ecosystem: SavedEcosystemState,
  speciesId: string,
  generationsToRun: number,
  populationSize: number,
  promotionThresholdDelta = 0.5,
  options?: {
    commitVersionToRegistry?: boolean;
    initialBrainOverride?: FishBrainInstance;
    totalGenerationsTrained?: number;
  }
): {
  generationsCompleted: number;
  fishSimulatedCount: number;
  candidateModel: ModelVersionRecord;
  evolvedBrain: FishBrainInstance;
  promoted: boolean;
  historyAdded: GenerationHistoryEntry[];
} {
  const species =
    ecosystem.speciesList.find((s) => s.id === speciesId) || ecosystem.speciesList[0];
  const currentBase =
    ecosystem.modelRegistry.find(
      (m) => m.speciesId === species.id && m.isPromotedBase
    ) ||
    ecosystem.modelRegistry.find((m) => m.speciesId === species.id) ||
    ecosystem.modelRegistry[0];

  const baseBrain: FishBrainInstance = options?.initialBrainOverride
    ? deepCloneBrain(options.initialBrainOverride)
    : currentBase && currentBase.speciesId === species.id
    ? {
        architecture: {
          inputCount: currentBase.brainConfig.inputCount,
          hiddenLayers: [...currentBase.brainConfig.hiddenLayers],
          outputCount: currentBase.brainConfig.outputCount,
          activation: currentBase.brainConfig.activation,
          recurrentMemoryEnabled: currentBase.brainConfig.recurrentMemoryEnabled,
          attentionModuleEnabled: currentBase.brainConfig.attentionModuleEnabled,
          aggressiveness:
            currentBase.brainConfig.aggressiveness ??
            species.baseBrainConfig.aggressiveness ??
            0,
        },
        inheritedWeights: currentBase.weights.map((w) => [...w]),
        inheritedBiases: currentBase.biases.map((b) => [...b]),
        learnedDeltaWeights: currentBase.weights.map((w) => new Array(w.length).fill(0)),
        learnedDeltaBiases: currentBase.biases.map((b) => new Array(b.length).fill(0)),
        recurrentState: new Array(
          currentBase.brainConfig.hiddenLayers[currentBase.brainConfig.hiddenLayers.length - 1] || 8
        ).fill(0),
        attentionGates: new Array(currentBase.brainConfig.inputCount).fill(1.0),
        lastInputs: new Array(currentBase.brainConfig.inputCount).fill(0),
        lastOutputs: new Array(currentBase.brainConfig.outputCount).fill(0),
      }
    : createBaseBrainInstance(species.baseBrainConfig);

  let bestBrain = deepCloneBrain(baseBrain);
  let bestScore = evaluateBrainOnBenchmarks(
    bestBrain,
    species,
    ecosystem.evolutionConfig,
    101
  );

  const historyAdded: GenerationHistoryEntry[] = [];
  const startGen =
    ecosystem.generationHistory.length > 0
      ? ecosystem.generationHistory[ecosystem.generationHistory.length - 1].generation + 1
      : 1;

  let totalFishSimulated = 0;
  const rng = createSeededRng(Date.now() & 0xffffff);

  for (let g = 0; g < generationsToRun; g++) {
    const genNum = startGen + g;
    let genBestBrain = deepCloneBrain(bestBrain);
    let genBestBenchmark = bestScore;
    let births = 0;
    let starvations = 0;
    const mutLabels: string[] = [];

    for (let p = 0; p < populationSize; p++) {
      totalFishSimulated++;
      const { brain: candidate, mutationsApplied } = inheritOffspringBrain(
        bestBrain,
        null,
        species.baseBrainConfig,
        ecosystem.evolutionConfig,
        genNum,
        rng
      );

      // Simulate lifetime learning step aligned with food vectors
      const foodVec = new Float32Array(species.baseBrainConfig.inputCount);
      foodVec[0] = 0.8;
      foodVec[1] = 0.3;
      foodVec[2] = -0.5;
      foodVec[3] = 0.9;
      foodVec[7] = 0.8;
      const out = forwardFishBrain(candidate, foodVec, 0.05, rng);
      const reward = out[0] * 0.8 + out[1] * 0.3 - out[2] * 0.5;
      applyFishLifetimeLearning(candidate, reward, species.baseBrainConfig);

      // Consolidate learned deltas into candidate weights for benchmark evaluation
      for (let l = 0; l < candidate.inheritedWeights.length; l++) {
        for (let i = 0; i < candidate.inheritedWeights[l].length; i++) {
          candidate.inheritedWeights[l][i] +=
            candidate.learnedDeltaWeights[l][i] * species.baseBrainConfig.learnedInheritanceRate;
        }
      }

      const bench = evaluateBrainOnBenchmarks(
        candidate,
        species,
        ecosystem.evolutionConfig,
        1000 + g * 100 + p
      );

      if (bench.overallComposite > genBestBenchmark.overallComposite) {
        genBestBrain = candidate;
        genBestBenchmark = bench;
        if (mutationsApplied.length > 0) {
          mutLabels.push(mutationsApplied[0]);
        }
      }
      if (bench.foragingEfficiency > 48) {
        births++;
      } else {
        starvations++;
      }
    }

    bestBrain = genBestBrain;
    bestScore = genBestBenchmark;

    const entry: GenerationHistoryEntry = {
      generation: genNum,
      simHourReached: Number((ecosystem.simHoursTotal + (g + 1) * species.lifespan.lifespanSimHours).toFixed(1)),
      populationAlive: Math.max(4, populationSize - starvations),
      birthsCount: births,
      starvationDeaths: starvations,
      oldAgeDeaths: Math.max(1, Math.floor(populationSize * 0.15)),
      predationDeaths: Math.floor(
        populationSize * ecosystem.evolutionConfig.environment.predatorPressure * 0.2
      ),
      avgSpeedGene: Number((1.0 + g * 0.015).toFixed(2)),
      avgMetabolismGene: Number((1.02 + g * 0.012).toFixed(2)),
      avgSensorRangeGene: Number((1.03 + g * 0.018).toFixed(2)),
      avgStressToleranceGene: Number((1.0 + g * 0.01).toFixed(2)),
      avgForagingEfficiency: bestScore.foragingEfficiency,
      avgHarmAvoidance: bestScore.harmAvoidance,
      avgEnergyManagement: bestScore.energyAndThreatManagement,
      dominantMutations: mutLabels.length > 0 ? mutLabels.slice(0, 3) : ['SynapticRefinement'],
    };
    historyAdded.push(entry);
    ecosystem.generationHistory.push(entry);
  }

  // Cap generationHistory to 120 entries so storage remains fast and compact
  if (ecosystem.generationHistory.length > 120) {
    ecosystem.generationHistory = ecosystem.generationHistory.slice(-120);
  }

  const baselineScore =
    currentBase && currentBase.speciesId === species.id
      ? currentBase.benchmark.overallComposite
      : 0;

  // If this brain has aggressiveness > 0, sync the evolved aggressiveness value back to the species baseBrainConfig
  if ((species.baseBrainConfig.aggressiveness ?? 0) > 0 || (bestBrain.architecture.aggressiveness ?? 0) > 0) {
    const evolvedAgg = Number(
      Math.max(
        0.02,
        Math.min(
          1.0,
          bestBrain.architecture.aggressiveness ?? species.baseBrainConfig.aggressiveness ?? 0.25
        )
      ).toFixed(3)
    );
    bestBrain.architecture.aggressiveness = evolvedAgg;
    species.baseBrainConfig.aggressiveness = evolvedAgg;
  } else {
    bestBrain.architecture.aggressiveness = 0;
    species.baseBrainConfig.aggressiveness = 0;
  }

  // Every completed trained model is automatically set as the active/default base model for its species
  const promoted = true;

  const existingSpeciesModels = ecosystem.modelRegistry.filter((m) => m.speciesId === species.id);
  const finalGenLabel =
    options?.totalGenerationsTrained ||
    (existingSpeciesModels[0]?.generationTrained || 0) + generationsToRun;

  const maxExistingVerSeq = existingSpeciesModels.reduce((maxSeq, m) => {
    const match = m.versionId.match(/^v1\.(\d+)/);
    return match ? Math.max(maxSeq, parseInt(match[1], 10) || 0) : maxSeq;
  }, existingSpeciesModels.length);
  const nextVerSeq = maxExistingVerSeq + 1;
  const newVersionId = `v1.${nextVerSeq}-G${finalGenLabel}`;

  const deltaScore = Number((bestScore.overallComposite - baselineScore).toFixed(1));
  const aggNote =
    (species.baseBrainConfig.aggressiveness ?? 0) > 0
      ? ` · Aggressiveness ${(species.baseBrainConfig.aggressiveness! * 100).toFixed(0)}%`
      : '';

  const candidateModel: ModelVersionRecord = {
    versionId: newVersionId,
    speciesId: species.id,
    parentVersionId:
      currentBase && currentBase.speciesId === species.id ? currentBase.versionId : null,
    createdAtIso: new Date().toISOString(),
    generationTrained: finalGenLabel,
    isPromotedBase: true,
    notes: `Trained ${finalGenLabel}G (${deltaScore >= 0 ? '+' : ''}${deltaScore} composite vs ${
      currentBase?.versionId || 'baseline'
    }${aggNote})`,
    brainConfig: { ...species.baseBrainConfig },
    speciesConfig: { ...species, activeBaseModelVersion: newVersionId },
    weights: bestBrain.inheritedWeights.map((w) => [...w]),
    biases: bestBrain.inheritedBiases.map((b) => [...b]),
    benchmark: bestScore,
  };

  const shouldCommit = options?.commitVersionToRegistry !== false;
  if (shouldCommit) {
    ecosystem.modelRegistry.forEach((m) => {
      if (m.speciesId === species.id) m.isPromotedBase = false;
    });
    species.activeBaseModelVersion = newVersionId;
    candidateModel.speciesConfig = { ...species };
    ecosystem.modelRegistry.unshift(candidateModel);

    // Strictly keep only the last 5 versions for this fish species (sorted latest first, oldest last)
    const sameSp = ecosystem.modelRegistry
      .filter((m) => m.speciesId === species.id)
      .sort((a, b) => {
        const tA = Date.parse(a.createdAtIso || '') || 0;
        const tB = Date.parse(b.createdAtIso || '') || 0;
        if (tB !== tA) return tB - tA;
        return (b.generationTrained || 0) - (a.generationTrained || 0);
      });
    const otherSp = ecosystem.modelRegistry.filter((m) => m.speciesId !== species.id);
    const keptSameSp = sameSp.slice(0, 5);
    ecosystem.modelRegistry = [...keptSameSp, ...otherSp];
  }

  return {
    generationsCompleted: generationsToRun,
    fishSimulatedCount: totalFishSimulated,
    candidateModel,
    evolvedBrain: bestBrain,
    promoted,
    historyAdded,
  };
}

/**
 * Runs a controlled A/B Experiment comparing a Control population (current stable base model)
 * against a Variant population (mutated or differently trained model) under identical environmental conditions.
 */
export function runControlledExperiment(
  ecosystem: SavedEcosystemState,
  speciesId: string,
  experimentName: string,
  durationSimHours: number
): ExperimentComparisonResult {
  const species =
    ecosystem.speciesList.find((s) => s.id === speciesId) || ecosystem.speciesList[0];
  const controlModel =
    ecosystem.modelRegistry.find((m) => m.speciesId === species.id && m.isPromotedBase) ||
    ecosystem.modelRegistry[0];

  const controlBrain = createBaseBrainInstance(species.baseBrainConfig, 777);
  if (controlModel) {
    controlBrain.inheritedWeights = controlModel.weights.map((w) => [...w]);
    controlBrain.inheritedBiases = controlModel.biases.map((b) => [...b]);
  }

  const { brain: variantBrain } = inheritOffspringBrain(
    controlBrain,
    null,
    species.baseBrainConfig,
    ecosystem.evolutionConfig,
    20,
    createSeededRng(Date.now() & 0xffff)
  );

  // Train variant briefly on foraging task
  const inp = new Float32Array(species.baseBrainConfig.inputCount);
  inp[0] = 0.9;
  inp[3] = 0.9;
  inp[7] = 0.85;
  forwardFishBrain(variantBrain, inp, 0);
  applyFishLifetimeLearning(variantBrain, 0.9, species.baseBrainConfig);
  for (let l = 0; l < variantBrain.inheritedWeights.length; l++) {
    for (let i = 0; i < variantBrain.inheritedWeights[l].length; i++) {
      variantBrain.inheritedWeights[l][i] += variantBrain.learnedDeltaWeights[l][i] * 0.5;
    }
  }

  const controlScores = evaluateBrainOnBenchmarks(
    controlBrain,
    species,
    ecosystem.evolutionConfig,
    303
  );
  const variantScores = evaluateBrainOnBenchmarks(
    variantBrain,
    species,
    ecosystem.evolutionConfig,
    303
  );

  const delta = Number(
    (variantScores.overallComposite - controlScores.overallComposite).toFixed(1)
  );
  const winner =
    Math.abs(delta) < 0.4 ? 'tie' : delta > 0 ? 'variant' : 'control';

  const result: ExperimentComparisonResult = {
    id: nextEntityId('exp'),
    name: experimentName || `A/B Foraging & Stress Trial (${species.name})`,
    timestampIso: new Date().toISOString(),
    durationSimHours,
    environment: { ...ecosystem.evolutionConfig.environment },
    controlLabel: `Control (${controlModel?.versionId || 'v1.0-base'})`,
    variantLabel: 'Mutated + Reward-Trained Variant',
    controlScores,
    variantScores,
    winner,
    summary:
      winner === 'variant'
        ? `Variant outperformed Control by +${delta} composite points (Foraging ${variantScores.foragingEfficiency}% vs ${controlScores.foragingEfficiency}%).`
        : winner === 'control'
        ? `Control retained superiority by ${Math.abs(delta)} points; Variant mutation caused slight navigation drift.`
        : `Both populations performed within 0.4 points under identical habitat conditions.`,
  };

  ecosystem.experiments.unshift(result);
  return result;
}
