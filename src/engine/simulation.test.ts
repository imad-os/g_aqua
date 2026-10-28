import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBaseBrainInstance,
  forwardFishBrain,
  inheritOffspringBrain,
  validateAndEstimateBrain,
} from './brain';
import {
  DEFAULT_BRAIN_CONFIG,
  DEFAULT_EVOLUTION_CONFIG,
  DEFAULT_SPECIES_LIST,
  TANK_TIERS,
} from './defaults';
import {
  createSpeciesConfigFromFamousFish,
  FAMOUS_AQUARIUM_FISHES_50,
} from './famousFishCatalog';
import {
  awardOwnerXp,
  getTankBoundsAtZ,
  reproduceOffspringFish,
  runAcceleratedHeadlessTraining,
  spawnFoundingFish,
  stepEcosystemSimulation,
} from './simulation';
import { createInitialEcosystemState } from './storage';

test('Full-Screen TV Frustum Tank geometry is smaller in front and larger in back so front fishes never clip off-screen', () => {
  const tank = TANK_TIERS[0];
  const halfD = tank.depth * 0.44;
  const frontBounds = getTankBoundsAtZ(tank, halfD, true, 16 / 9);
  const centerBounds = getTankBoundsAtZ(tank, 0, true, 16 / 9);
  const backBounds = getTankBoundsAtZ(tank, -halfD, true, 16 / 9);

  assert.ok(
    frontBounds.halfW < centerBounds.halfW && centerBounds.halfW < backBounds.halfW,
    'Frustum tank width must be smaller in front and larger in back'
  );
  assert.ok(
    frontBounds.halfH < centerBounds.halfH && centerBounds.halfH < backBounds.halfH,
    'Frustum tank height must be smaller in front and larger in back'
  );
  assert.ok(
    frontBounds.halfW < frontBounds.frustumHalfW,
    'Front fish swimming width must stay strictly inside the camera visible frustum width'
  );

  // Verify fish pushed to extreme front-right corner is clamped inside visible front frustum
  const eco = createInitialEcosystemState(250, 0, 1);
  eco.fishes[0].state.z = halfD;
  eco.fishes[0].state.x = 999;
  stepEcosystemSimulation(eco, [], [], 0.05);
  const updatedSlice = getTankBoundsAtZ(tank, eco.fishes[0].state.z, true, 16 / 9);
  assert.ok(
    Math.abs(eco.fishes[0].state.x) <= updatedSlice.halfW + 0.001,
    'Fish at front of tank must be clamped within narrower front frustum width'
  );
});

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

  const originalMotherWeight = mother.brain.inheritedWeights[0][0];
  child.brain.inheritedWeights[0][0] = originalMotherWeight + 99.0;
  assert.equal(mother.brain.inheritedWeights[0][0], originalMotherWeight);
});

test('Tank capacities are 3, 4, 5, and 6 (max 6) and babies are allowed to exist over max capacity', () => {
  assert.deepEqual(
    TANK_TIERS.map((t) => t.maxFishCapacity),
    [3, 4, 5, 6]
  );

  // Create Tank 0 (capacity 3) and place 3 mature, well-fed adult fishes in it
  const eco = createInitialEcosystemState(250, 0, 1);
  const sp = eco.speciesList[0];
  eco.fishes = [
    spawnFoundingFish(sp, 0, 10, 0),
    spawnFoundingFish(sp, 0, 10, 1),
    spawnFoundingFish(sp, 0, 10, 2),
  ];
  for (const f of eco.fishes) {
    f.state.ageSimHours = sp.lifespan.sexualMaturityAgeHours + 2.0;
    f.state.lifeStage = 'adult';
    f.state.energy = 95;
    f.state.reproductionCooldownHours = 0;
  }
  // Trigger gravid state and gestation completion
  eco.fishes[0].state.isGravid = true;
  eco.fishes[0].state.gestationHoursRemaining = 0.001;

  const stepRes = stepEcosystemSimulation(eco, [], [], 36);
  assert.equal(stepRes.birthsThisStep, 1, 'Babies must be allowed to hatch over the tank adult max of 3');
  assert.equal(eco.fishes.filter((f) => f.lineage.alive).length, 4);

  // Now when that baby matures into a 4th adult (4 adults > maxFishCapacity of 3),
  // it stays safely in the tank and new breeding is paused
  for (const f of eco.fishes) {
    f.state.ageSimHours = sp.lifespan.sexualMaturityAgeHours + 2.0;
    f.state.lifeStage = 'adult';
    f.state.energy = 95;
    f.state.isGravid = false;
    f.state.reproductionCooldownHours = 0;
  }
  stepEcosystemSimulation(eco, [], [], 36);
  assert.equal(
    eco.fishes.some((f) => f.state.isGravid),
    false,
    'New breeding must pause when adult count exceeds tank capacity'
  );
});

test('50 Top Famous Aquarium Fishes catalog contains 50 distinct species with valid configs', () => {
  assert.equal(FAMOUS_AQUARIUM_FISHES_50.length, 50);
  const first = createSpeciesConfigFromFamousFish(FAMOUS_AQUARIUM_FISHES_50[0]);
  const fiftieth = createSpeciesConfigFromFamousFish(FAMOUS_AQUARIUM_FISHES_50[49]);
  assert.equal(first.id, 'neon-tetra');
  assert.ok(first.lifespan.lifespanSimHours > 0);
  assert.equal(fiftieth.id, 'black-ghost-knifefish');
  assert.ok((fiftieth.requiredOwnerLevel || 1) >= 1);
});

test('Offline Fish Keeper dynamically skips online game tanks and checks owner auto-feeder when override is off', () => {
  const eco = createInitialEcosystemState(250, 0, 24);
  const starterTankId = eco.fishes[0].lineage.tankId;

  // 1. When starterTankId is marked as an active in-game session, 0 offline fish are updated in Keeper
  const skippedStep = stepEcosystemSimulation(eco, [], [], 60, {
    allowAutoFeeders: false,
    useOwnerAutoFeederWhenOverrideOff: true,
    onlyOfflineFish: true,
    activeSessionTankIds: [starterTankId],
  });
  assert.equal(skippedStep.liveFishUpdated, 0);

  // 2. When Trainer override feeder is OFF (`allowAutoFeeders: false`), Keeper checks owner's own auto-feeder (`autoFeederCountByTank = 1`)
  eco.autoFeederCountByTank = { [starterTankId]: 1 };
  const pellets: any[] = [];
  stepEcosystemSimulation(eco, pellets, [], 120, {
    allowAutoFeeders: false,
    useOwnerAutoFeederWhenOverrideOff: true,
    onlyOfflineFish: true,
    activeSessionTankIds: [],
  });
  assert.ok(
    pellets.length > 0,
    'Keeper must dispense pellets using owner auto-feeder when Trainer override feeder is disabled'
  );

  // 3. When BOTH Trainer override feeder AND owner auto-feeder are 0, neglected fish lose energy and starve
  eco.autoFeederCountByTank = {};
  for (const f of eco.fishes) {
    f.state.energy = 0.02;
    f.state.health = 0.1;
  }
  const starveStep = stepEcosystemSimulation(eco, [], [], 120, {
    allowAutoFeeders: false,
    useOwnerAutoFeederWhenOverrideOff: true,
    onlyOfflineFish: true,
    activeSessionTankIds: [],
  });
  assert.ok(starveStep.deathsThisStep > 0);
  assert.equal(eco.fishes[0].lineage.alive, false);
});

test('Owner XP leveling and extended headless training work cleanly', () => {
  const eco = createInitialEcosystemState(250, 0, 1);
  assert.equal(eco.ownerLevel, 1);
  const lvRes = awardOwnerXp(eco, 185);
  assert.equal(lvRes.leveledUp, true);
  assert.equal(eco.ownerLevel, 3);

  const validMetrics = validateAndEstimateBrain(DEFAULT_BRAIN_CONFIG, 4096);
  assert.equal(validMetrics.valid, true);

  const base = createBaseBrainInstance(DEFAULT_BRAIN_CONFIG, 42);
  const out = forwardFishBrain(base, new Float32Array(DEFAULT_BRAIN_CONFIG.inputCount), 0);
  assert.equal(out.length, DEFAULT_BRAIN_CONFIG.outputCount);

  const trainRes = runAcceleratedHeadlessTraining(
    eco,
    DEFAULT_SPECIES_LIST[0].id,
    5,
    12,
    999
  );
  assert.equal(trainRes.generationsCompleted, 5);
  assert.equal(trainRes.promoted, false);
  assert.equal(
    inheritOffspringBrain(base, null, DEFAULT_BRAIN_CONFIG, DEFAULT_EVOLUTION_CONFIG, 5).brain
      .architecture.outputCount,
    DEFAULT_BRAIN_CONFIG.outputCount
  );
});
