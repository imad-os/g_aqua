# Abyssal Evo — 3D Aquarium, Living TV Screensaver & AI Evolution Lab

**Abyssal Evo** (`id: abyssal-evo`) is a dual-application ecosystem built for **My PC** (Samsung Smart TVs running Tizen 8/9, desktop browsers, and mobile devices): a refined **3D Aquarium Game & Multi-Hour TV Screensaver** (`index.html`) paired with a standalone **AI Trainer, Evolution Lab & Offline Fish Life Service** (`trainer.html`) that shares the same deterministic simulation, neural network, genetics, and serialization engine.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> Please review the confirmed architecture and 3-phase rollout below. Click **Proceed** to begin building **Phase 1 (Playable 3D Aquarium with Individual Fish AI, Upgradable Tanks & TV Screensaver Mode)**, or let us know if you would like any adjustments to the phases.

- **Confirmed Decision — Upgradable Multi-Tank Progression**: Players start with a compact **Starter Nano Cube** and earn bio-credits through thriving generations and milestones to purchase larger, richer habitats: **Planted Tropical Lagoon**, **Bioluminescent Coral Sanctuary**, and **Apex Deep-Sea Bio-Dome**, each expanding carrying capacity, lighting caustics, environmental zones, and automated feeding slots.
- **Confirmed Decision — Refined 3D Multi-Hour TV Screensaver Mode**: Designed for continuous multi-hour display on Samsung Smart TVs (`allow_background_running: true`), featuring a zero-burn-in/zero-occlusion **Cinema Screensaver Mode** with damped autonomous camera choreography, underwater caustic light projection, composite 3–12 part procedural fish models with skeletal-style fin/tail kinematics, and adaptive quality scaling (`low` / `mid` / `high` TV tiers) with zero garbage collection in the render loop.
- **Confirmed Decision — 100% Free / Open-Source Procedural Assets**: All 3D geometries, PBR surface textures (`CanvasTexture` / `DataTexture` normal, roughness, and caustic maps), SVG iconography, and ambient underwater hydrophone/marimba soundscapes are generated procedurally using open-source algorithms and Web Audio synthesis—guaranteeing zero external 404s and full offline capability.
- **Confirmed Decision — Offline Fish Life Service in the AI Trainer App**: The separate **AI Trainer & Evolution Lab** includes a background **Offline Fish Simulation Service**. Using a real-time active-session lease lock, it filters out any tank/fish currently open in an active game session (preventing state collisions) and continuously simulates the neural brains, hunger, foraging, aging, and reproduction of **only live offline fish**. If offline fish run out of food, their energy depletes and they die of starvation (halting brain updates for deceased fish). Operators can toggle anytime between a **Live Visual View** and a **Headless Stats-Only View** (0% GPU overhead) showing live offline fish counts, tick throughput, hunger levels, and mortality logs.
- **Confirmed Decision — My PC SDK First**: Full controller-first mapping via `MyPC.gamepad` (up to 4 pads + TV remote arrows/OK), profile persistence via `MyPC.save` / `MyPC.load`, leaderboards via `MyPC.submitScore`, owner tuning via `MyPC.app_config`, and optional AI Marine Biologist insights via `MyPC.ai`.

---

### 1. Overview & 3-Phase Rollout Strategy

#### Phase 1: Playable 3D Aquarium with Individual AI Brains, Tank Shop & TV Screensaver (Immediate Deliverable)
- **My PC SDK Foundation**: Complete `mypc-app.json` manifest, `.nojekyll`, `CLAUDE.md`, `MyPC.init` lifecycle (`onInit`, `onStart`, `onPause`, `onResume`, `onDestroy`), `MyPC.gamepad` (sticks, triggers, A/B/X/Y, LB/RB) + TV remote arrow/OK navigation, and `MyPC.save` / `MyPC.load` persistence.
- **Shared Core Simulation & Neural Engine**: Individual fish brain instances (configurable MLP with recurrent memory buffer, exploration/exploitation control, experience replay reward learning, and personality vectors), configurable biological clock (simulation hours, maturity, gestation, metabolism, starvation mortality, and time multiplier `1x`–`24x`), and mother-first brain inheritance with configurable paternal trait crossover and mutation.
- **Refined 3D Aquarium & Upgradable Tanks**: Studio PBR Three.js aquarium with composite 3–12 part procedural fish species, swaying botanical flora, bubble columns, underwater caustics, and an interactive **Aquarium Shop** to buy bigger and better tanks, auto-feeders, and environmental enrichments.
- **Multi-Hour TV Screensaver Mode & AI Marine Advisor**: Toggleable (or auto-activated on idle) HUD-free **TV Screensaver Mode** with slow damped camera orbits and follow-cams, plus on-demand `MyPC.ai` natural-language fish lineage & ecosystem analysis (with deterministic offline fallback when AI providers are unconfigured).

#### Phase 2: Dedicated AI Trainer Web App & Offline Fish Background Service
- **Standalone Trainer Interface (`trainer.html`)**: Independent Vite entry sharing the core engine without duplicating simulation or genetics code.
- **Offline Fish Life Service**: Background simulation daemon that detects which fish/tanks are not actively being played via session heartbeat locks, simulates only **live offline fish** (updating their neural brains, hunger, and life cycles, with real starvation death when unfed), displays live offline fish telemetry, and provides a one-click toggle between **Visual Tank Preview** and **Stats-Only Headless Mode**.
- **Species Manager, Base Brain Lab & Training Lab**: Visual editors for species biological timing, neural architecture (inputs, hidden layers, activations, memory retention, compute budget validation), and accelerated headless batch training across thousands of generations.

#### Phase 3: Deep Multi-Generation Evolution Lab, Experiments, Lineage & Model Registry
- **Evolution Milestones & Environmental Pressures**: Configurable Generation 1 / 10 / 20 / 30 milestones, structural & weight mutation budgets, predator/scarcity/temperature selection pressures, and separate tracking for DNA traits vs. lifetime learned memories.
- **Population & Lineage Inspector + Controlled A/B Experiments**: Interactive family trees, mutation diffs, trait frequency timelines, and side-by-side benchmark evaluations (foraging efficiency, hazard avoidance, memory retention, energy budgeting) comparing parent vs. offspring models.
- **Versioned Model Registry & Quality Control Gate**: JSON model/config import & export, automatic promotion thresholds (preventing regressions from overwriting stable base models), one-click rollback, and final My PC Section 11 verification checklist.

---

### 2. User Experience & Visual Design

#### A. 3D Aquarium Game & Living TV Screensaver (`index.html`)
- **Key User Flows**:
  1. **Title Screen & Tank Selection**: Live 3D aquarium backdrop with bespoke SVG title lockup, active profile indicator (`info.profile.name`), and single-button launch into the active tank or **TV Screensaver Mode**.
  2. **Active Caretaker & Inspector Flow (Gamepad & TV Remote)**:
     - **Left Stick / D-Pad**: Move the 3D Caretaker Cursor inside the aquarium or navigate the bottom dock.
     - **Right Stick**: Smoothly orbit, pitch, and zoom the camera around the tank (`LT` / `RT` control simulation time multiplier or depth zoom).
     - **B / Confirm (Bottom / Remote OK)**: Drop nutrient pellets at cursor or select a fish to lock the **Follow-Cam & Brain Inspector**.
     - **A / Cancel (Right)**: Release camera lock or close active drawer.
     - **X (Top)**: Toggle the **Live Neural Brain & Lineage HUD** for the focused fish.
     - **Y (Left)**: Open the **Tank Progression & Upgrade Shop** (buy larger aquariums, kelp forests, oxygenation rigs, and timed auto-feeders).
     - **LB / RB**: Cycle focus across live fish in the tank or switch tabs.
     - **Select / Screen Toggle**: Enter **Pure 3D TV Screensaver Mode** (100% unobstructed viewport with choreographed camera glides).
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Atmospheric bioluminescent & sunlit marine sanctuary crafted for 55"+ 4K living-room TVs and desktop monitors.
  - *Color Palette*: Deep abyssal slate (`#060D18`) and pelagic teal (`#0B2135`) 60% canvas, dark translucent HUD surfaces (`rgba(9, 18, 32, 0.84)` with `1px solid rgba(148, 163, 184, 0.16)`—no `backdrop-filter` over WebGL to maintain 60fps on Tizen TVs), and 10% bioluminescent cyan (`#06B6D4`) and coral amber (`#F59E0B`) accents.
  - *Typography*: `Plus Jakarta Sans` for crisp television-legible headings and controls, paired with `JetBrains Mono` (`tabular-nums`) for simulation clocks, generation counters, and neural telemetry.
  - *Viewport Budget*: Collapsible bottom control dock occupying `< 12%` of the viewport height; 100% unobstructed viewport in Screensaver Mode.

#### B. AI Trainer, Evolution Lab & Offline Fish Service (`trainer.html`)
- **Aesthetic Direction**: High-precision scientific & biotech instrumentation console following the Asymmetric Split Console pattern.
- **Color Palette**: Deep obsidian lab background (`#07090E`), flat slate instrument panels (`#111827`) with `1px` hairline borders (`#1E293B`), and calibrated phosphor accents (cyan `#06B6D4` for neural telemetry, emerald `#10B981` for survival/promotion, amber `#F59E0B` for hunger/mutation drift, and rose `#F43F5E` for starvation/regression alerts).
- **Offline Fish Service Banner & Toggle**: Persistent top telemetry ribbon displaying `OFFLINE SERVICE: ACTIVE`, live count of **Offline Fish Updating**, **Active In-Game Fish (Locked/Skipped)**, **Starved / Deceased Count**, simulation ticks/sec, and the instant `[ Visual View | Stats-Only Headless ]` switch.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Shared Pure-TypeScript Simulation Core with Dual Entry Points**
  - *Chosen Approach*: Decouple the entire simulation, neural network forward/learning pass, genetics, and clock into a pure, zero-DOM engine module imported by both the 3D Game (`index.html`) and the AI Trainer (`trainer.html`).
  - *Why*: Guarantees 100% behavioral parity between headless accelerated training (thousands of ticks per second) and real-time 60fps 3D gameplay, while preventing code duplication.
- **Decision 2: Session Presence Lock for the Offline Fish Simulation Service**
  - *Chosen Approach*: When the main game (`index.html`) is actively playing a tank, it broadcasts a lightweight heartbeat lease (`BroadcastChannel` + storage timestamp). When the Trainer's **Offline Fish Service** runs, it checks active leases and updates **only offline fish** (and only fish with `alive === true`). If an offline fish's energy reaches `0` due to lack of food, it dies naturally and stops receiving brain updates.
  - *Why*: Directly fulfills the requirement that fish stay alive and evolving when users are not playing—and starve if neglected—without ever corrupting or interrupting the brain updates of fish currently being played with in an active game session.
- **Decision 3: Tizen TV Performance & Software-WebGL Safety**
  - *Chosen Approach*: Pre-allocate all `THREE.Vector3`, `Matrix4`, and `Quaternion` scratch objects outside the `requestAnimationFrame` loop; use procedural geometries and textures with zero external network fetches; scale particle counts and shadow maps using `MyPC.info().quality.tier`; and avoid CSS `backdrop-filter` over the WebGL canvas.
  - *Why*: Ensures buttery-smooth multi-hour screensaver operation on low-resource 2024+ Samsung Smart TVs (Chromium 108) without frame drops or memory leaks.

---

### 4. Technical Architecture & Data Strategy

#### A. System & Component Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        MY PC SDK & HOST ENVIRONMENT                          │
│  MyPC.init · MyPC.gamepad · MyPC.save/load · MyPC.submitScore · MyPC.ai      │
└───────────────────┬──────────────────────────────────────┬───────────────────┘
                    │                                      │
                    ▼                                      ▼
┌───────────────────────────────────────┐  ┌───────────────────────────────────┐
│   3D AQUARIUM & TV SCREENSAVER APP    │  │  AI TRAINER & EVOLUTION LAB APP   │
│            (index.html)               │  │          (trainer.html)           │
├───────────────────────────────────────┤  ├───────────────────────────────────┤
│ • Three.js Studio PBR Aquarium Stage  │  │ • Offline Fish Life Service       │
│   - 4 Upgradable Tank Environments    │  │   - Active-Session Lease Filter   │
│   - 3-12 Part Procedural Fish Meshes  │  │   - Live vs Starved Fish Tracker  │
│   - Caustics, Flora & Bubble Systems  │  │   - [Visual | Stats-Only] Toggle  │
│ • Multi-Hour TV Screensaver Director  │  │ • Species & Lifespan Manager      │
│   - Damped Orbit & Fish Follow-Cam    │  │ • Base Brain Architecture Lab     │
│   - Auto-Hide Zero-Occlusion HUD      │  │ • Headless Accelerated Trainer    │
│ • Caretaker HUD & Bottom Control Dock │  │ • Evolution & Milestone Config    │
│   - Feed / Tank Shop / Speed Controls │  │ • Lineage Tree & A/B Experiments  │
│   - Live Fish Brain & Lineage Drawer  │  │ • Versioned Model Registry (JSON) │
└───────────────────┬───────────────────┘  └─────────────────┬─────────────────┘
                    │                                        │
                    └───────────────────┬────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                 SHARED SIMULATION, NEURAL & GENETICS ENGINE                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ • SimulationClock: Configurable sim-hours, speed (1x-24x+), pause/resume     │
│ • FishBrain: Per-fish MLP weights, recurrent memory, reward learning, bounds │
│ • GeneticsEngine: Mother brain copy + paternal trait mix + bounded mutations │
│ • Lifecycle & Ecology: Hunger, foraging, maturity, gestation, starvation     │
│ • BenchmarkSuite: Standardized foraging, threat-evasion & energy tests       │
│ • ModelSerializer: Versioned JSON import/export, rollback & MyPC.save sync   │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### B. Core Data Models & Separation of Concerns

Each fish entity maintains four strictly separated data categories so learned lifetime behaviors are never conflated with genetic DNA:

1. **Lineage & Identity Metadata**: `fishId`, `speciesId`, `generation`, `modelVersion`, `motherId`, `fatherId`, `birthSimHour`, `alive`, `causeOfDeath` (`null | 'starvation' | 'old_age' | 'predation' | 'stress'`), and `isOfflineSimulated`.
2. **Genetic Traits (DNA)**: Heritable physical and metabolic parameters (`maxSpeedGene`, `sizeGene`, `metabolismEfficiency`, `sensorRangeGene`, `colorHueGene`, `stressToleranceGene`, `mutationHistory[]`).
3. **Individual Brain Model (`FishBrainInstance`)**:
   - Architecture config (`inputCount`, `hiddenLayers[]`, `outputCount`, `activation`, `recurrentMemorySize`).
   - Cloned weight & bias tensors inherited from the mother's brain (with optional paternal layer crossover and bounded Gaussian mutation on birth).
   - Separate `inheritedWeightsSnapshot` vs. `lifetimeDeltaWeights` so inheritance rates for learned parameters (`0.0` pure Baldwinian to `1.0` Lamarckian blend) are configurable.
4. **Lifetime Memory, Personality & Biological State**:
   - Episodic short-term memory ring buffer (recent food coordinates, threat encounters, energy delta).
   - Personality vector (`boldness`, `socialAffinity`, `curiosity`).
   - Biological state (`ageSimHours`, `lifeStage: 'egg' | 'juvenile' | 'adult' | 'elder'`, `energy`, `hunger`, `health`, `stress`, `reproductionCooldown`).

#### C. Interactive Component & State Mapping

- **Aquarium Tank Upgrade Progression**:
  - *Tier 1 — Starter Nano Cube*: 6 fish capacity, warm desk lamp lighting, basic gravel bed.
  - *Tier 2 — Planted Tropical Lagoon*: 14 fish capacity, swaying Vallisneria kelp, driftwood arches, 1 auto-feeder slot.
  - *Tier 3 — Bioluminescent Coral Sanctuary*: 24 fish capacity, procedural branching corals, dynamic caustic shader, 2 auto-feeder slots, predator/threat training toggle.
  - *Tier 4 — Apex Deep-Sea Bio-Dome*: 40 fish capacity, multi-zone thermal vents, full ecological selection arenas, 4 programmable auto-feeders.
- **Offline Fish Simulation Service State Flow**:
  - Starting the service in `trainer.html` launches a deterministic simulation loop (configurable `1x` to `1000x` headless speed).
  - On each tick, the service reads the shared population store, skips any fish belonging to a tank with an active game lease (`lastHeartbeat < 3000ms`), and updates only offline fish where `alive === true`.
  - Offline fish sense food particles (from scheduled auto-feeders or residual tank food), execute their neural network forward pass, consume energy proportional to movement and brain complexity, and die of starvation if `energy <= 0`.
  - Clicking **Toggle Visuals / Stats-Only** mounts or unmounts the 3D/2D canvas renderer immediately while keeping the background simulation loop running uninterrupted.
