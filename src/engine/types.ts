export type ActivationType = 'tanh' | 'relu' | 'leaky_relu' | 'sigmoid';
export type LearningMethod = 'reinforce_hebbian' | 'td_reward' | 'evolution_only';
export type LifeStage = 'egg' | 'juvenile' | 'adult' | 'elder';
export type CauseOfDeath = 'starvation' | 'old_age' | 'predation' | 'stress' | 'disease' | null;
export type FishPolygonQuality = 'very_low' | 'low' | 'medium' | 'high' | 'ultra';
export type EnvironmentQualityTier = 'very_low' | 'low' | 'mid' | 'high';

export interface UserGraphicsSettings {
  fishPolygonQuality: FishPolygonQuality;
  environmentQuality: EnvironmentQualityTier;
  showCaustics: boolean;
  showParticles: boolean;
  antiAliasing: boolean;
  framelessTvMode?: boolean;
  /** Show real-time FPS counter badge on the top-right corner of the screen */
  showFps?: boolean;
  /** Overall overhead & key lighting intensity multiplier (0.15 .. 1.80, default 0.95) */
  lightIntensity?: number;
  /** Back-of-tank & water background brightness (0.00 pitch abyss .. 1.00 bright blue, default 0.22) */
  backgroundBrightness?: number;
  /** Daylight Mode ON/OFF: when ON, uses natural Daylight during the day and Bulb Light at night; when OFF, always uses Bulb Light */
  daylightMode?: boolean;
  /** Optional time-of-day override ('auto' uses real fish clock, 'day' forces daytime, 'night' forces nighttime) */
  timeOfDayOverride?: 'auto' | 'day' | 'night';
}

export interface AdminUserRecord {
  email: string;
  displayName: string;
  role: 'owner' | 'admin';
  addedAtIso: string;
  addedBy: string;
}

export interface BrainConfig {
  inputCount: number;
  hiddenLayers: number[];
  outputCount: number;
  activation: ActivationType;
  memoryCapacity: number;
  memoryRetention: number; // 0..1 per sim-hour
  forgettingRate: number; // 0..1 per sim-hour
  learningRate: number;
  learningFrequencyTicks: number;
  learningMethod: LearningMethod;
  mutationRate: number;
  mutationMagnitude: number;
  learnedInheritanceRate: number; // 0..1 how much of mother's lifetime learned deltas transfer
  explorationEpsilon: number; // 0..1 exploration vs exploitation
  decisionUpdateIntervalTicks: number;
  maxComputeBudgetOps: number;
  trainingBatchSize: number;
  parallelSimulations: number;
  trainingDurationGenerations: number;
  recurrentMemoryEnabled: boolean;
  attentionModuleEnabled: boolean;
  evasionModuleEnabled: boolean;
  schoolingModuleEnabled: boolean;
  /** Aggressiveness behavior (0 = peaceful/disabled, >0 = periodic attack lunge frequency & intensity 0.01..1.0) */
  aggressiveness?: number;
}

export interface BrainValidationMetrics {
  valid: boolean;
  errors: string[];
  parameterCount: number;
  estimatedMemoryBytes: number;
  inferenceOpsPerDecision: number;
  estimatedTrainingTicksPerSec: number;
}

export interface SpeciesLifespanConfig {
  lifespanSimHours: number; // e.g., 24 sim-hours
  growthRatePerHour: number;
  juvenileDurationHours: number; // e.g., 3.5 sim-hours
  sexualMaturityAgeHours: number; // e.g., 4.0 sim-hours
  reproductionIntervalHours: number; // e.g., 3.0 sim-hours
  maxReproductiveAgeHours: number; // e.g., 20.0 sim-hours
  minEnergyToReproduceRatio: number; // e.g., 0.60
  eggIncubationHours: number; // e.g., 0.8 sim-hours
  offspringIndependenceHours: number; // e.g., 1.2 sim-hours
  feedingIntervalHours: number; // e.g., 2.0 sim-hours
  metabolismEnergyPerHour: number; // e.g., 8.5 energy/sim-hour
  agingRateMultiplier: number; // 1.0 default
  recoverySpeedPerHour: number; // health/stress recovery
  speciesTimeMultiplier: number; // 1.0 default
}

export type FishBodyStyle =
  | 'fusiform_reef'
  | 'angel_disc'
  | 'biolum_Latern'
  | 'mandarin_dragonet'
  | 'betta_veil'
  | 'shark_torpedo'
  | 'puffer_round'
  | 'tang_surgeon'
  | 'koi_dragon'
  | 'lionfish_fan';

export interface SpeciesConfig {
  id: string;
  name: string;
  scientificName: string;
  description: string;
  category?: 'freshwater' | 'marine' | 'cichlid' | 'specialty';
  requiredOwnerLevel?: number;
  shopPriceCredits?: number;
  bodyStyle: FishBodyStyle;
  primaryColorHex: string;
  secondaryColorHex: string;
  accentColorHex: string;
  lifespan: SpeciesLifespanConfig;
  baseBrainConfig: BrainConfig;
  activeBaseModelVersion: string;
}

export interface EvolutionMilestoneRule {
  generationTarget: number;
  label: string;
  description: string;
  mutationBudgetMultiplier: number;
  allowBehavioralShift: boolean;
  allowStructuralInnovation: boolean;
  unlockedCapabilities: string[];
}

export interface EnvironmentalFactorsConfig {
  foodAbundance: number; // 0.1 (scarce) .. 2.0 (abundant)
  predatorPressure: number; // 0.0 (peaceful) .. 1.0 (intense)
  competitionIntensity: number; // 0.0 .. 1.0
  habitatVariability: number; // 0.0 (stable) .. 1.0 (shifting currents/zones)
  waterQuality: number; // 0.2 .. 1.0
  temperatureC: number; // 18 .. 30
}

export interface EvolutionConfig {
  mutationProbPerTrait: number;
  mutationProbPerGeneration: number;
  mutationMagnitude: number;
  cumulativeMutationLimit: number;
  structuralMutationProb: number;
  fatherTraitInheritanceProb: number; // 0..1 (mother's brain remains default starting point)
  fatherBrainCrossoverRate: number; // 0..0.5 optional blending
  learnedVsGeneticRatio: number; // 0..1
  selectionStrengthSurvival: number;
  selectionStrengthReproduction: number;
  selectionStrengthLearning: number;
  selectionStrengthForaging: number;
  maxBrainComplexityParams: number;
  mutationPolicy: 'natural' | 'preserve_beneficial' | 'selective_breeding' | 'revertible';
  milestones: {
    gen1: EvolutionMilestoneRule;
    gen10: EvolutionMilestoneRule;
    gen20: EvolutionMilestoneRule;
    gen30: EvolutionMilestoneRule;
  };
  environment: EnvironmentalFactorsConfig;
}

// 1. Lineage & Identity Category
export interface FishLineageData {
  fishId: string;
  name: string;
  speciesId: string;
  generation: number;
  modelVersion: string;
  motherId: string | null;
  fatherId: string | null;
  birthSimHour: number;
  deathSimHour: number | null;
  alive: boolean;
  causeOfDeath: CauseOfDeath;
  inheritedMutations: string[];
  cumulativeMutationDrift: number;
  tankId: string;
}

// 2. Genetic Traits (DNA) Category
export interface FishGeneticsData {
  maxSpeedGene: number; // 0.6 .. 1.8
  bodyScaleGene: number; // 0.7 .. 1.5
  metabolismEfficiencyGene: number; // 0.6 .. 1.5 (higher = less energy burned)
  sensorRangeGene: number; // 0.7 .. 1.8
  primaryHueShift: number; // -45 .. +45 deg
  luminancePulseGene: number; // 0 .. 1
  finAspectGene: number; // 0.7 .. 1.4
  stressToleranceGene: number; // 0.5 .. 1.5
  threatDetectionGene: number;
  foragingDriveGene: number;
  socialSchoolingGene: number;
  aggressivenessGene?: number; // 0 (peaceful) .. 1.0 (highly aggressive, only active if > 0)
}

// 3. Individual Brain Parameters Category
export interface FishBrainInstance {
  architecture: {
    inputCount: number;
    hiddenLayers: number[];
    outputCount: number;
    activation: ActivationType;
    recurrentMemoryEnabled: boolean;
    attentionModuleEnabled: boolean;
    aggressiveness?: number;
  };
  inheritedWeights: number[][];
  inheritedBiases: number[][];
  learnedDeltaWeights: number[][];
  learnedDeltaBiases: number[][];
  recurrentState: number[];
  attentionGates: number[];
  lastInputs: number[];
  lastOutputs: number[];
}

// 4. Learned Memories, Personality & Biological State Category
export interface EpisodicMemoryEntry {
  simHour: number;
  kind: 'food_found' | 'threat_evaded' | 'hurt_hazard' | 'social_mate';
  x: number;
  y: number;
  z: number;
  valence: number; // -1 .. +1
  strength: number; // decays over time via forgettingRate
}

export interface FishPersonality {
  boldness: number; // 0..1
  socialAffinity: number; // 0..1
  curiosity: number; // 0..1
}

export interface FishBiologicalState {
  ageSimHours: number;
  lifeStage: LifeStage;
  growthProgress: number; // 0.25 (hatchling) .. 1.0 (full adult)
  energy: number; // 0 .. 100
  maxEnergy: number;
  hunger: number; // 0 (full) .. 100 (starving)
  health: number; // 0 .. 100
  stress: number; // 0 .. 100
  reproductionCooldownHours: number;
  isGravid: boolean;
  gestationHoursRemaining: number;
  gravidPartnerId: string | null;
  independenceHoursRemaining: number;
  attackCooldownHours?: number;
  lastAttackTargetId?: string | null;
  attackReactionKind?: 'slowed_down' | 'flee_dart' | 'counter_attack' | null;
  attackReactionHoursRemaining?: number;
  attackReactionDirX?: number;
  attackReactionDirY?: number;
  attackReactionDirZ?: number;
  attackReactionAttackerId?: string | null;
  // Spatial kinematics
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll?: number;
  tailPhase: number;
  // Observable lifetime task metrics
  metrics: {
    foodPelletsEaten: number;
    foragingAttempts: number;
    foodRoutineHits: number;
    threatsEvaded: number;
    harmfulActionsRepeated: number;
    harmfulActionsAvoided: number;
    energyEfficiencyScore: number;
    offspringProduced: number;
    lifetimeReward: number;
    decisionsMade: number;
    attacksPerformed?: number;
    counterAttacksPerformed?: number;
  };
  episodicMemory: EpisodicMemoryEntry[];
  personality: FishPersonality;
}

export interface FishEntity {
  lineage: FishLineageData;
  genetics: FishGeneticsData;
  brain: FishBrainInstance;
  state: FishBiologicalState;
}

export interface FoodPellet {
  id: string;
  x: number;
  y: number;
  z: number;
  vy: number;
  nutrition: number;
  ageSeconds: number;
  source: 'manual' | 'autofeeder' | 'natural_bloom';
}

export interface ThreatEntity {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  activeSecondsRemaining: number;
  kind: 'shadow_predator' | 'current_vortex';
}

export interface TankTierConfig {
  tierIndex: number;
  id: string;
  name: string;
  subtitle: string;
  costCredits: number;
  maxFishCapacity: number;
  width: number;
  height: number;
  depth: number;
  maxAutoFeeders: number;
  waterTintHex: string;
  fogDensity: number;
  ambientLightColorHex: string;
  causticsIntensity: number;
  coralCount: number;
  kelpCount: number;
  rockArchCount: number;
  description: string;
}

export interface BenchmarkTaskScores {
  foragingEfficiency: number; // 0..100
  foodLocationMemory: number; // 0..100
  harmAvoidance: number; // 0..100
  environmentalAdaptation: number; // 0..100
  navigationChallenge: number; // 0..100
  energyAndThreatManagement: number; // 0..100
  reproductiveSurvival: number; // 0..100
  overallComposite: number; // weighted observable task mean
  survivalRatePct: number;
  reproductiveRatePerFish: number;
  computeOpsPerTick: number;
}

export interface ModelVersionRecord {
  versionId: string;
  speciesId: string;
  parentVersionId: string | null;
  createdAtIso: string;
  generationTrained: number;
  isPromotedBase: boolean;
  notes: string;
  brainConfig: BrainConfig;
  speciesConfig?: SpeciesConfig;
  weights: number[][];
  biases: number[][];
  benchmark: BenchmarkTaskScores;
}

export interface GenerationHistoryEntry {
  generation: number;
  simHourReached: number;
  populationAlive: number;
  birthsCount: number;
  starvationDeaths: number;
  oldAgeDeaths: number;
  predationDeaths: number;
  avgSpeedGene: number;
  avgMetabolismGene: number;
  avgSensorRangeGene: number;
  avgStressToleranceGene: number;
  avgForagingEfficiency: number;
  avgHarmAvoidance: number;
  avgEnergyManagement: number;
  dominantMutations: string[];
}

export interface ExperimentComparisonResult {
  id: string;
  name: string;
  timestampIso: string;
  durationSimHours: number;
  environment: EnvironmentalFactorsConfig;
  controlLabel: string;
  variantLabel: string;
  controlScores: BenchmarkTaskScores;
  variantScores: BenchmarkTaskScores;
  winner: 'control' | 'variant' | 'tie';
  summary: string;
}

export interface OfflineServiceTelemetry {
  running: boolean;
  visualModeEnabled: boolean;
  speedMultiplier: number;
  cpuUsageLimitPct: number;
  activeInGameTankIds: string[];
  offlineLiveFishCount: number;
  offlineDeceasedFishCount: number;
  skippedActivePlayFishCount: number;
  totalBrainUpdatesExecuted: number;
  ticksPerSecond: number;
  simHoursElapsedInService: number;
  autoFeederEnabledInService: boolean;
  lastDeathEvent: string | null;
}

export interface SavedEcosystemState {
  version: number;
  lastSavedAtMs?: number;
  adminOverrideAtMs?: number;
  lastAdminAction?: string;
  removedFishIds?: string[];
  acknowledgedDeadFishIds?: string[];
  simHoursTotal: number;
  timeMultiplier: number;
  paused: boolean;
  bioCredits: number;
  ownerLevel?: number;
  ownerXp?: number;
  unlockedTankTiers: number[];
  activeTankTier: number;
  autoFeederCountByTank: Record<string, number>;
  graphicsSettings?: UserGraphicsSettings;
  speciesList: SpeciesConfig[];
  evolutionConfig: EvolutionConfig;
  fishes: FishEntity[];
  deceasedArchive: FishLineageData[];
  generationHistory: GenerationHistoryEntry[];
  modelRegistry: ModelVersionRecord[];
  experiments: ExperimentComparisonResult[];
}


