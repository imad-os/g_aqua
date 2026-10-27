import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBaseBrainInstance,
  forwardFishBrain,
  inheritOffspringBrain,
  validateAndEstimateBrain,
} from './brain';
import { DEFAULT_BRAIN_CONFIG, DEFAULT_EVOLUTION_CONFIG, DEFAULT_SPECIES_LIST } from './defaults';
import {
  reproduceOffspringFish,
  runAcceleratedHeadlessTraining,
  spawnFoundingFish,
  stepEcosystemSimulation,
} from './simulation';
import { createInitialEcosystemState } from './storage';

test('Individual fish brains do not share mutable weight references between mother and offspring', () => {
  const species = DEFAULT_SPECIES_LIST[0];
  const mother = spawnFoundingFish(species, 0, 5.0, 0);
  const child = reproduceOffspringFish(
    mother,
    null,
    species,
    DEFAULT_EVOLUTION_CONFIG,
    5.0
  );

  assert.equal(child.lineage.motherId, mother.lineage.fishId);
  assert.equal(child.lineage.generation, mother.lineage.generation + 1);
  assert.notEqual(child.brain.inheritedWeights, mother.brain.inheritedWeights);
  assert.notEqual(child.brain.inheritedWeights[0], mother.brain.inheritedWeights[0]);

  // Mutating child weight in-place must never mutate mother's brain
  const originalMotherWeight = mother.brain.inheritedWeights[0][0];
  child.brain.inheritedWeights[0][0] = originalMotherWeight + 99.0;
  assert.equal(mother.brain.inheritedWeights[0][0], originalMotherWeight);
});

test('Simulation clock obeys 1x vs 24x timeMultiplier and stops completely when paused', () => {
  const eco = createInitialEcosystemState(250, 0, 1);
  const startHours = eco.simHoursTotal;

  // At 1x speed, 3600 real seconds = 1.0 simulation hour
  const res1x = stepEcosystemSimulation(eco, [], [], 3600);
  assert.equal(Number(res1x.simHoursDelta.toFixed(4)), 1.0);
  assert.equal(Number((eco.simHoursTotal - startHours).toFixed(4)), 1.0);

  // At 24x speed, 3600 real seconds = 24.0 simulation hours
  eco.timeMultiplier = 24;
  const before24x = eco.simHoursTotal;
  const res24x = stepEcosystemSimulation(eco, [], [], 3600);
  assert.equal(Number(res24x.simHoursDelta.toFixed(4)), 24.0);
  assert.equal(Number((eco.simHoursTotal - before24x).toFixed(4)), 24.0);

  // When paused, simulation time does not advance
  eco.paused = true;
  const beforePause = eco.simHoursTotal;
  const resPaused = stepEcosystemSimulation(eco, [], [], 3600);
  assert.equal(resPaused.simHoursDelta, 0);
  assert.equal(resPaused.liveFishUpdated, 0);
  assert.equal(eco.simHoursTotal, beforePause);
});

test('Offline Fish Simulation Service skips active-session tanks and starves neglected fish', () => {
  const eco = createInitialEcosystemState(250, 0, 24);
  eco.autoFeederCountByTank = {}; // No auto-feeder food
  const starterTankId = eco.fishes[0].lineage.tankId;

  // 1. When starterTankId is marked as an active in-game session, 0 offline fish are updated
  const skippedStep = stepEcosystemSimulation(eco, [], [], 60, {
    allowAutoFeeders: false,
    onlyOfflineFish: true,
    activeSessionTankIds: [starterTankId],
  });
  assert.equal(skippedStep.liveFishUpdated, 0);

  // 2. When tank is offline (not in activeSessionTankIds) and no food is given, fish lose energy and starve
  for (const f of eco.fishes) {
    f.state.energy = 0.02;
    f.state.health = 0.1;
  }
  const starveStep = stepEcosystemSimulation(eco, [], [], 120, {
    allowAutoFeeders: false,
    onlyOfflineFish: true,
    activeSessionTankIds: [],
  });
  assert.ok(starveStep.deathsThisStep > 0, 'Unfed fish with depleted energy must die of starvation');
  assert.equal(eco.fishes[0].lineage.alive, false);
  assert.equal(eco.fishes[0].lineage.causeOfDeath, 'starvation');

  // 3. Subsequent ticks must not update brains of deceased fish
  const decisionsBefore = eco.fishes[0].state.metrics.decisionsMade;
  const postDeathStep = stepEcosystemSimulation(eco, [], [], 120, {
    allowAutoFeeders: false,
    onlyOfflineFish: true,
    activeSessionTankIds: [],
  });
  assert.equal(postDeathStep.liveFishUpdated, 0);
  assert.equal(eco.fishes[0].state.metrics.decisionsMade, decisionsBefore);
});

test('Brain validation and headless training enforce complexity and evaluation gates', () => {
  const validMetrics = validateAndEstimateBrain(DEFAULT_BRAIN_CONFIG, 4096);
  assert.equal(validMetrics.valid, true);
  assert.ok(validMetrics.parameterCount > 100);

  const base = createBaseBrainInstance(DEFAULT_BRAIN_CONFIG, 42);
  const out = forwardFishBrain(base, new Float32Array(DEFAULT_BRAIN_CONFIG.inputCount), 0);
  assert.equal(out.length, DEFAULT_BRAIN_CONFIG.outputCount);

  const eco = createInitialEcosystemState(250, 0, 1);
  const trainRes = runAcceleratedHeadlessTraining(
    eco,
    DEFAULT_SPECIES_LIST[0].id,
    3,
    12,
    999 // Impossible promotion threshold so existing base model is protected
  );
  assert.equal(trainRes.generationsCompleted, 3);
  assert.equal(trainRes.promoted, false);
  assert.equal(
     inheritOffspringBrain(base, null, DEFAULT_BRAIN_CONFIG, DEFAULT_EVOLUTION_CONFIG, 5).brain
      .architecture.outputCount,
    DEFAULT_BRAIN_CONFIG.outputCount
  );
});
