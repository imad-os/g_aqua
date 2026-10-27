import {
  ActivationType,
  BrainConfig,
  BrainValidationMetrics,
  EvolutionConfig,
  FishBrainInstance,
} from './types';

// Deterministic Mulberry32 PRNG for reproducible training and mutations
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussianRandom(rng: () => number = Math.random): number {
  const u1 = Math.max(1e-7, rng());
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export function applyActivation(x: number, activation: ActivationType): number {
  switch (activation) {
    case 'relu':
      return x > 0 ? x : 0;
    case 'leaky_relu':
      return x > 0 ? x : 0.1 * x;
    case 'sigmoid':
      return 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, x))));
    case 'tanh':
    default:
      return Math.tanh(x);
  }
}

export function validateAndEstimateBrain(
  config: BrainConfig,
  maxComplexityParams = 8192
): BrainValidationMetrics {
  const errors: string[] = [];
  if (config.inputCount < 4 || config.inputCount > 32) {
    errors.push('Input count must be between 4 and 32.');
  }
  if (!config.hiddenLayers.length || config.hiddenLayers.length > 5) {
    errors.push('Hidden layers must have between 1 and 5 layers.');
  }
  for (let i = 0; i < config.hiddenLayers.length; i++) {
    const n = config.hiddenLayers[i];
    if (n < 4 || n > 128) {
      errors.push(`Layer ${i + 1} neuron count (${n}) must be between 4 and 128.`);
    }
  }
  if (config.outputCount < 3 || config.outputCount > 12) {
    errors.push('Output count must be between 3 and 12.');
  }

  const layerDims = [config.inputCount, ...config.hiddenLayers, config.outputCount];
  let parameterCount = 0;
  let inferenceOpsPerDecision = 0;

  for (let i = 0; i < layerDims.length - 1; i++) {
    const fanIn = layerDims[i];
    const fanOut = layerDims[i + 1];
    const weights = fanIn * fanOut;
    const biases = fanOut;
    parameterCount += weights + biases;
    inferenceOpsPerDecision += weights * 2 + biases;
  }

  if (config.recurrentMemoryEnabled && config.hiddenLayers.length > 0) {
    const recSize = config.hiddenLayers[config.hiddenLayers.length - 1];
    parameterCount += recSize;
    inferenceOpsPerDecision += recSize * 2;
  }
  if (config.attentionModuleEnabled) {
    parameterCount += config.inputCount;
    inferenceOpsPerDecision += config.inputCount * 2;
  }

  if (parameterCount > maxComplexityParams) {
    errors.push(
      `Brain parameter count (${parameterCount}) exceeds maximum complexity budget (${maxComplexityParams}).`
    );
  }
  if (inferenceOpsPerDecision > config.maxComputeBudgetOps) {
    errors.push(
      `Inference cost (${inferenceOpsPerDecision} ops) exceeds per-fish compute budget (${config.maxComputeBudgetOps} ops).`
    );
  }

  // Float32 storage for inherited + learned deltas + episodic memory
  const estimatedMemoryBytes =
    parameterCount * 8 + config.memoryCapacity * 32 + 256;

  const estimatedTrainingTicksPerSec = Math.max(
    500,
    Math.round((2_400_000 / Math.max(64, inferenceOpsPerDecision)) * Math.min(4, config.parallelSimulations))
  );

  return {
    valid: errors.length === 0,
    errors,
    parameterCount,
    estimatedMemoryBytes,
    inferenceOpsPerDecision,
    estimatedTrainingTicksPerSec,
  };
}

/**
 * Creates a fresh species base brain model with sensible foraging priors so
 * Generation 1 fish can swim toward food and avoid walls, while leaving ample
 * room for evolutionary and lifetime improvements.
 */
export function createBaseBrainInstance(
  config: BrainConfig,
  seed = 104729
): FishBrainInstance {
  const rng = createSeededRng(seed);
  const dims = [config.inputCount, ...config.hiddenLayers, config.outputCount];
  const inheritedWeights: number[][] = [];
  const inheritedBiases: number[][] = [];
  const learnedDeltaWeights: number[][] = [];
  const learnedDeltaBiases: number[][] = [];

  for (let l = 0; l < dims.length - 1; l++) {
    const fanIn = dims[l];
    const fanOut = dims[l + 1];
    const scale = Math.sqrt(2.0 / (fanIn + fanOut));
    const wLayer: number[] = new Array(fanIn * fanOut);
    const bLayer: number[] = new Array(fanOut);
    const dwLayer: number[] = new Array(fanIn * fanOut).fill(0);
    const dbLayer: number[] = new Array(fanOut).fill(0);

    for (let i = 0; i < fanIn * fanOut; i++) {
      wLayer[i] = gaussianRandom(rng) * scale;
    }
    for (let o = 0; o < fanOut; o++) {
      bLayer[o] = (rng() - 0.5) * 0.1;
    }

    // Seed gentle instinct weights on first layer from food direction (inputs 0,1,2)
    // and threat direction (inputs 4,5) so Gen 1 baseline is functional
    if (l === 0) {
      for (let o = 0; o < Math.min(3, fanOut); o++) {
        if (o < fanIn) {
          wLayer[o * fanOut + o] += 0.55;
        }
      }
    }
    if (l === dims.length - 2) {
      for (let o = 0; o < Math.min(3, fanOut); o++) {
        if (o < fanIn) {
          wLayer[o * fanOut + o] += 0.55;
        }
      }
    }

    inheritedWeights.push(wLayer);
    inheritedBiases.push(bLayer);
    learnedDeltaWeights.push(dwLayer);
    learnedDeltaBiases.push(dbLayer);
  }

  const lastHiddenDim =
    config.hiddenLayers[config.hiddenLayers.length - 1] || config.outputCount;

  return {
    architecture: {
      inputCount: config.inputCount,
      hiddenLayers: [...config.hiddenLayers],
      outputCount: config.outputCount,
      activation: config.activation,
      recurrentMemoryEnabled: config.recurrentMemoryEnabled,
      attentionModuleEnabled: config.attentionModuleEnabled,
    },
    inheritedWeights,
    inheritedBiases,
    learnedDeltaWeights,
    learnedDeltaBiases,
    recurrentState: new Array(lastHiddenDim).fill(0),
    attentionGates: new Array(config.inputCount).fill(1.0),
    lastInputs: new Array(config.inputCount).fill(0),
    lastOutputs: new Array(config.outputCount).fill(0),
  };
}

/**
 * Deep-clones a brain instance so no two fish ever share mutable weight arrays.
 */
export function deepCloneBrain(brain: FishBrainInstance): FishBrainInstance {
  return {
    architecture: {
      inputCount: brain.architecture.inputCount,
      hiddenLayers: [...brain.architecture.hiddenLayers],
      outputCount: brain.architecture.outputCount,
      activation: brain.architecture.activation,
      recurrentMemoryEnabled: brain.architecture.recurrentMemoryEnabled,
      attentionModuleEnabled: brain.architecture.attentionModuleEnabled,
    },
    inheritedWeights: brain.inheritedWeights.map((layer) => [...layer]),
    inheritedBiases: brain.inheritedBiases.map((layer) => [...layer]),
    learnedDeltaWeights: brain.learnedDeltaWeights.map((layer) => [...layer]),
    learnedDeltaBiases: brain.learnedDeltaBiases.map((layer) => [...layer]),
    recurrentState: [...brain.recurrentState],
    attentionGates: [...brain.attentionGates],
    lastInputs: [...brain.lastInputs],
    lastOutputs: [...brain.lastOutputs],
  };
}

/**
 * Produces an offspring's brain starting from a deep copy of the MOTHER'S brain,
 * optionally blending selected father weights, consolidating a configurable ratio
 * of the mother's lifetime learned weight deltas, and applying bounded mutations
 * (which can be neutral, beneficial, or harmful).
 */
export function inheritOffspringBrain(
  motherBrain: FishBrainInstance,
  fatherBrain: FishBrainInstance | null,
  brainConfig: BrainConfig,
  evoConfig: EvolutionConfig,
  generation: number,
  rng: () => number = Math.random
): { brain: FishBrainInstance; mutationsApplied: string[]; driftAmount: number } {
  const child = deepCloneBrain(motherBrain);
  const mutationsApplied: string[] = [];
  let driftAmount = 0;

  // Milestone mutation budget scaling (Gen 1, Gen 10, Gen 20, Gen 30)
  let milestoneMult = evoConfig.milestones.gen1.mutationBudgetMultiplier;
  if (generation >= evoConfig.milestones.gen30.generationTarget) {
    milestoneMult = evoConfig.milestones.gen30.mutationBudgetMultiplier;
  } else if (generation >= evoConfig.milestones.gen20.generationTarget) {
    milestoneMult = evoConfig.milestones.gen20.mutationBudgetMultiplier;
  } else if (generation >= evoConfig.milestones.gen10.generationTarget) {
    milestoneMult = evoConfig.milestones.gen10.mutationBudgetMultiplier;
  }

  const effectiveMutRate = Math.min(
    0.5,
    brainConfig.mutationRate * milestoneMult
  );
  const effectiveMutMag = Math.min(
    0.6,
    brainConfig.mutationMagnitude * milestoneMult
  );
  const learnedTransfer = Math.max(
    0,
    Math.min(1, brainConfig.learnedInheritanceRate * evoConfig.learnedVsGeneticRatio)
  );

  let weightsMutatedCount = 0;
  let paternalCrossCount = 0;

  for (let l = 0; l < child.inheritedWeights.length; l++) {
    const wArr = child.inheritedWeights[l];
    const dwMother = motherBrain.learnedDeltaWeights[l];
    const fatherWArr =
      fatherBrain &&
      fatherBrain.inheritedWeights[l] &&
      fatherBrain.inheritedWeights[l].length === wArr.length
        ? fatherBrain.inheritedWeights[l]
        : null;

    for (let i = 0; i < wArr.length; i++) {
      // 1. Start from mother's inherited weight + configured fraction of mother's lifetime learned delta
      let w = wArr[i] + (dwMother ? dwMother[i] * learnedTransfer : 0);

      // 2. Optional paternal crossover while mother remains the default baseline
      if (fatherWArr && rng() < evoConfig.fatherBrainCrossoverRate) {
        w = w * 0.65 + fatherWArr[i] * 0.35;
        paternalCrossCount++;
      }

      // 3. Apply random genetic mutation (can be beneficial, neutral, or harmful)
      if (rng() < effectiveMutRate) {
        const delta = gaussianRandom(rng) * effectiveMutMag;
        w = Math.max(-3.5, Math.min(3.5, w + delta));
        driftAmount += Math.abs(delta);
        weightsMutatedCount++;
      }

      wArr[i] = w;
    }

    // Reset child's lifetime learned deltas to 0 so child develops independently
    child.learnedDeltaWeights[l].fill(0);

    const bArr = child.inheritedBiases[l];
    const dbMother = motherBrain.learnedDeltaBiases[l];
    for (let j = 0; j < bArr.length; j++) {
      let b = bArr[j] + (dbMother ? dbMother[j] * learnedTransfer : 0);
      if (rng() < effectiveMutRate) {
        const delta = gaussianRandom(rng) * effectiveMutMag * 0.5;
        b = Math.max(-2.0, Math.min(2.0, b + delta));
        driftAmount += Math.abs(delta);
      }
      bArr[j] = b;
    }
    child.learnedDeltaBiases[l].fill(0);
  }

  // Reset child's working recurrent memory
  child.recurrentState.fill(0);
  child.lastInputs.fill(0);
  child.lastOutputs.fill(0);

  // Structural / attention gate mutation around higher generations
  if (
    generation >= evoConfig.milestones.gen20.generationTarget &&
    rng() < evoConfig.structuralMutationProb
  ) {
    const idx = Math.floor(rng() * child.attentionGates.length);
    const shift = (rng() - 0.48) * 0.35;
    child.attentionGates[idx] = Math.max(0.2, Math.min(2.0, child.attentionGates[idx] + shift));
    mutationsApplied.push(`SensoryAttention[ch${idx}]${shift >= 0 ? '+' : ''}${shift.toFixed(2)}`);
  }

  if (weightsMutatedCount > 0) {
    mutationsApplied.push(`SynapseMut(${weightsMutatedCount}w, Δ${driftAmount.toFixed(2)})`);
  }
  if (paternalCrossCount > 0) {
    mutationsApplied.push(`PaternalCross(${paternalCrossCount}w)`);
  }
  if (learnedTransfer > 0.01) {
    mutationsApplied.push(`MaternalLearned(${(learnedTransfer * 100).toFixed(0)}%)`);
  }

  return { brain: child, mutationsApplied, driftAmount };
}

// Pre-allocated scratch buffers for zero-GC forward inference in the 60fps loop
const _layerBufA = new Float32Array(128);
const _layerBufB = new Float32Array(128);

/**
 * Executes a zero-allocation neural forward pass for an individual fish.
 */
export function forwardFishBrain(
  brain: FishBrainInstance,
  inputs: ArrayLike<number>,
  explorationEpsilon = 0.05,
  rng: () => number = Math.random
): ReadonlyArray<number> {
  const inCount = Math.min(inputs.length, brain.architecture.inputCount);
  const activation = brain.architecture.activation;

  for (let i = 0; i < inCount; i++) {
    const gate = brain.attentionGates[i] ?? 1.0;
    const v = inputs[i] * gate;
    _layerBufA[i] = v;
    brain.lastInputs[i] = v;
  }

  let currentIn = _layerBufA;
  let currentOut = _layerBufB;
  let inDim = inCount;

  const numLayers = brain.inheritedWeights.length;
  for (let l = 0; l < numLayers; l++) {
    const wArr = brain.inheritedWeights[l];
    const dwArr = brain.learnedDeltaWeights[l];
    const bArr = brain.inheritedBiases[l];
    const dbArr = brain.learnedDeltaBiases[l];
    const outDim = bArr.length;
    const isOutputLayer = l === numLayers - 1;

    for (let o = 0; o < outDim; o++) {
      let sum = (bArr[o] || 0) + (dbArr ? dbArr[o] || 0 : 0);
      for (let i = 0; i < inDim; i++) {
        const idx = i * outDim + o;
        const w = (wArr[idx] || 0) + (dwArr ? dwArr[idx] || 0 : 0);
        sum += currentIn[i] * w;
      }

      // Add recurrent context on final hidden layer if enabled
      if (
        !isOutputLayer &&
        l === numLayers - 2 &&
        brain.architecture.recurrentMemoryEnabled &&
        o < brain.recurrentState.length
      ) {
        sum += brain.recurrentState[o] * 0.35;
      }

      const activated = isOutputLayer
        ? Math.tanh(sum)
        : applyActivation(sum, activation);
      currentOut[o] = activated;
    }

    // Update recurrent state on last hidden layer
    if (!isOutputLayer && l === numLayers - 2 && brain.architecture.recurrentMemoryEnabled) {
      for (let o = 0; o < Math.min(outDim, brain.recurrentState.length); o++) {
        brain.recurrentState[o] = brain.recurrentState[o] * 0.65 + currentOut[o] * 0.35;
      }
    }

    // Swap scratch buffers
    const temp = currentIn;
    currentIn = currentOut;
    currentOut = temp;
    inDim = outDim;
  }

  for (let o = 0; o < brain.architecture.outputCount; o++) {
    let val = currentIn[o];
    if (explorationEpsilon > 0 && rng() < explorationEpsilon) {
      val = Math.max(-1, Math.min(1, val + (rng() - 0.5) * 0.6));
    }
    brain.lastOutputs[o] = val;
  }

  return brain.lastOutputs;
}

/**
 * Applies lifetime reward-modulated learning to the individual fish's
 * learnedDeltaWeights (keeping DNA/inheritedWeights distinct from lifetime learning).
 */
export function applyFishLifetimeLearning(
  brain: FishBrainInstance,
  reward: number,
  config: BrainConfig
): void {
  if (config.learningMethod === 'evolution_only' || Math.abs(reward) < 1e-4) {
    return;
  }

  const lr = Math.max(0.0001, Math.min(0.1, config.learningRate)) * Math.max(-1, Math.min(1, reward));
  const lastLayerIdx = brain.learnedDeltaWeights.length - 1;
  if (lastLayerIdx < 0) return;

  // Update output projection layer and first sensory layer using reward-modulated Hebbian trace
  const firstDw = brain.learnedDeltaWeights[0];
  const firstOutDim = brain.inheritedBiases[0].length;
  const inCount = brain.lastInputs.length;

  for (let i = 0; i < inCount; i++) {
    const inp = brain.lastInputs[i];
    if (Math.abs(inp) < 0.01) continue;
    for (let o = 0; o < firstOutDim; o++) {
      const idx = i * firstOutDim + o;
      const outProxy = brain.lastOutputs[o % brain.lastOutputs.length] || 0;
      firstDw[idx] = Math.max(
        -1.2,
        Math.min(1.2, firstDw[idx] * 0.998 + lr * inp * outProxy)
      );
    }
  }

  const lastDb = brain.learnedDeltaBiases[lastLayerIdx];
  for (let o = 0; o < lastDb.length; o++) {
    const outVal = brain.lastOutputs[o] || 0;
    lastDb[o] = Math.max(-0.8, Math.min(0.8, lastDb[o] * 0.998 + lr * outVal * 0.5));
  }
}
