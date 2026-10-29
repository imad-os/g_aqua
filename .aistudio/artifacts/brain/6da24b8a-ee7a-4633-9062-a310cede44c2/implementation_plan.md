# Implementation Plan: 3D FPS Optimization, Authoritative Trainer Keeper Service & Firestore Quota Management

## 1. Deep 3D FPS & Graphics Optimization (`src/components/AquariumCanvas3D.tsx`, `src/App.tsx`)

### Root Causes Identified
1. **Main-Thread Serialization & React Re-render Stalls**: `App.tsx` called `saveEcosystemState(eco)` (synchronous `JSON.stringify` of all 50 species, neural network weights, and history) and `setEcosystem({ ...eco })` every `320ms` inside the `requestAnimationFrame` callback.
2. **Per-Frame CPU Vertex Deformation & PCIe Uploads**: `deformFishSpineSWave()` looped over 520–2,700 vertices per fish on the CPU every frame and flagged `posAttr.needsUpdate = true`.
3. **Heavy Dual `MeshPhysicalMaterial` + `DoubleSide` Shading**: Every fish used two `MeshPhysicalMaterial` instances with `clearcoat`, `bumpMap`, `transparent: true`, and `THREE.DoubleSide` (doubling fragment shader work) even in Low quality mode.
4. **High Draw-Call Count**: Each fish spawned 12 separate child `THREE.Mesh` objects, and tank rocks/corals created dozens of unmerged meshes and duplicate materials.

### Optimization Architecture
- **GPU Vertex Shader Spine Undulation (`onBeforeCompile`)**:
  - Inject custom vertex displacement into the fish body material shader driven by per-fish uniforms (`uTailPhase`, `uSwimAmp`).
  - Eliminate the per-frame JavaScript `deformFishSpineSWave` loop and `posAttr.needsUpdate = true` buffer uploads completely.
- **Merged Geometry & Draw-Call Reduction**:
  - Merge static anatomical sub-meshes on each fish (gill operculum plates, dorsal fin, anal fin, pelvic fins, and eye spheres) so each fish requires only **3 draw calls** (sculpted body+eyes+gills mesh, articulated caudal tail mesh, and sculling pectoral wing mesh) instead of 12+.
  - Batch static rock arch geometries and coral colony geometries in `buildTankEnvironment` into merged buffers per material, and freeze kelp matrix updates when in Low quality mode.
- **Quality-Tiered Materials & Backface Culling (`FrontSide`)**:
  - Switch closed 3D body and volumetric fin geometries to `THREE.FrontSide` to cut fragment shader invocations in half.
  - Use fast `MeshLambertMaterial` on `low` quality, `MeshStandardMaterial` on `mid` quality, and `MeshPhysicalMaterial` on `high` quality.
  - Skip `PMREMGenerator` environment map generation and shadow map passes when `qualityTier === 'low'`.
- **Decoupled Storage & 1Hz HUD Sync (`src/App.tsx`)**:
  - Remove `saveEcosystemState(eco)` from the 60FPS render callback; persist to `localStorage` on a 20-second background timer and immediately on user/admin actions or page unload.
  - Throttle React HUD state synchronization to `1000ms` (1Hz) so React never interrupts WebGL frame pacing.
- **Greyed-Out Dead Fishes in 3D & UI**:
  - Generate a dedicated desaturated monochrome greyscale skin & fin texture pair (`getOrCreateDeadFishGreyscaleTextures()`) and apply neutral grey material properties (`color: #9ca3af`, `emissiveIntensity: 0`, `roughness: 0.85`, `uSwimAmp: 0`) whenever `!fish.lineage.alive`.
  - Dead fishes immediately turn unmistakably grey in color in the 3D tank and float belly-up near the surface.

---

## 2. Trainer Keeper Service: Clickable Users, All Fishes, Live Kill Sync & Give/Replace Fish (`src/components/TrainerApp.tsx`, `src/engine/firebaseBrainer.ts`, `src/App.tsx`)

### Clickable Users List & All Fishes View
- Expand `fetchAllUserBrainRecordsFromFirestore` and `subscribeToAllUserBrainRecords` to query up to 100 user records and merge with the local owner profile so **all users and all their fishes** are always visible.
- Make the **Users List** in the Keeper tab interactive and clickable:
  - Clicking a user selects that owner and displays all of their fishes (live offline in Keeper, live online in Owner Game, and dead/starved) with full details and actions.
  - Include an **"All Users (Combined)"** view toggle so the admin can also view and filter every fish across all users at once.

### Give Fish to User & Change/Replace Existing Fish
- **Give Fish to User Modal / Panel**:
  - Allow the admin to select any user, choose any species (from the active species list or the 50 Famous Aquarium Fishes catalog), and gift 1 or more fishes (initialized with that species' promoted Base Model brain) directly to the user's aquarium, bypassing the standard 3–6 player tank capacity limit.
- **Change / Replace Fish Action**:
  - In the Selected Fish Inspector and fish row actions, add a **"Change / Replace Fish Species"** selector and button that swaps the selected fish's species, 3D visual traits, lifespan config, and brain architecture/weights with the newly chosen species while preserving or resetting its vitals.

### Authoritative Live Admin Kill / Action Sync (Even When Owner Has Game Open)
- Add `adminOverrideId` and `adminOverrideAtMs` fields to `CloudUserBrainRecord` and `SavedEcosystemState`.
- Whenever the admin executes **Starve (Kill)**, **Revive**, **Reproduce**, **Give Fish**, or **Change/Replace Fish** in the Trainer:
  1. If the target user is the local profile, write the authoritative override to `localStorage` and Firestore immediately, and prevent the Trainer's background loop from overwriting it with stale local game state.
  2. In `src/App.tsx`, subscribe to the active user's `mypc_user_brains/{username}` document via `onSnapshot` (in addition to `window.addEventListener('storage')`).
  3. When `App.tsx` detects a newer `adminOverrideAtMs` (whether from Firestore or `localStorage`), it immediately merges the admin's changes into the live `ecosystemRef.current` and `setEcosystem` state **before** the next simulation tick.
  4. Result: Even if the owner has the game open while the admin kills a fish, the fish immediately turns dead and greyed-out in the owner's live 3D aquarium and stays dead when the owner re-opens the game.

---

## 3. Model Version Cap (Max 10 per Species) & Single Save at End of Training (`src/engine/simulation.ts`, `src/components/TrainerApp.tsx`, `src/engine/firebaseBrainer.ts`)

- **Single Version Creation at End of Multi-Generation Training**:
  - Update `runAcceleratedHeadlessTraining` to accept an option `commitVersionToRegistry?: boolean` (or separate the evolutionary step from final version creation).
  - During a multi-generation run in `handleStartCpuThrottledTraining` (e.g., training a new fish `SSS` for `100G`), evolve the population and carry forward `bestBrain` across chunks in memory **without** pushing intermediate versions to `modelRegistry` or Firestore.
  - Only when the training run finishes (at generation `100G` or when stopped) is **1 single new `ModelVersionRecord`** created, added to `modelRegistry`, and saved to Firestore once.
- **Max 10 Versions per Fish Species**:
  - Enforce a helper `pruneSpeciesModelVersions(registry, speciesId, maxVersions = 10)` in both local state and `saveModelVersionToFirestore`.
  - Whenever a version is added for a species, keep at most the **10 most recent versions** for that species (always preserving the currently promoted active base version within the 10) and delete any older overflow version documents (`base_models/{speciesId}__{oldVersionId}`) from Firestore.

---

## 4. Firestore Write Optimization (Respect 20k Daily Quota) (`src/engine/firebaseBrainer.ts`, `src/App.tsx`, `src/components/TrainerApp.tsx`)

- **Remove High-Frequency Polling Writes**:
  - Remove the `1800ms` `setUserOnlineStatusInFirestore` interval and `10000ms` `syncUserBrainsToFirestore` interval in `src/App.tsx`.
  - Remove the per-tick (`150ms–600ms`) Firestore `setDoc` inside `TrainerApp.tsx`'s Keeper interval.
- **Range-Throttled Checkpoints (Every 3–5 Minutes) + Instant Event Writes**:
  - Write to Firestore **immediately** only on high-value state transitions:
    - Game session open / close (`visibilitychange`, `pagehide`, `beforeunload`)
    - Fish death (starvation / old age) or natural baby birth
    - Shop fish purchase, tank upgrade, or auto-feeder purchase
    - Admin action in Trainer (Kill/Starve, Revive, Reproduce, Give Fish, Replace Fish, Reset Fishes, Save/Promote Model at end of training)
  - For continuous background simulation (both in-game and in the 24/7 Keeper), batch dirty state updates and write to Firestore only once every **4 minutes (`240,000ms`)** if state has changed.
  - Skip redundant `base_models` writes unless the user explicitly finishes training, promotes a version, or clicks Save Properties.
