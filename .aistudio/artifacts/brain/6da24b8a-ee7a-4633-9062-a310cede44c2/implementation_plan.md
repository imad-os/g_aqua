# Abyssal Evo — Controller Support, Owner-Level Fish Shop, 3–6 Tank Capacities & Advanced AI Trainer Plan

## 1. Overview & Goals
This update upgrades both the **Main 3D Aquarium TV Game (`index.html`)** and the **Standalone Back-Office AI Trainer & 24/7 Fish Keeper (`trainer.html`)**, then compiles the static production bundle into **`/dist_dir`**:

1. **TV Remote & Game Controller Support (`index.html`)**:
   - **Open/Close Owner Menu**: Triggered by **TV Remote `Play/Pause`** (`MediaPlayPause`, Tizen keyCodes `415` / `19` / `10252` / `179`, or `MyPC.onInput('pause' | 'menu')`) and **Gamepad `+` / `Select` / `Start`** buttons.
   - **Full Spatial D-Pad / Arrow Navigation**: Navigate both the live 3D aquarium HUD actions (*Drop Food*, *Clean Water*, *Switch Tank*, *Open Menu*) and every tab, fish card, shop item, and graphics setting inside the Owner Menu modal using TV remote arrows / Gamepad D-pad, `OK` / `A` (`confirm`), `Back` / `B` (`cancel`), and `LB` / `RB` or Left/Right arrows for tab switching.
   - **Locked 1x Real-Time Simulation**: Remove all time-acceleration controls from the player game so the aquarium always runs at authentic `1x` real-time speed.

2. **Tank Space Upgrades (`3 → 4 → 5 → 6`) & Owner-Level Fish Shop (`index.html`)**:
   - **Tank Capacities for Space Only**:
     - **Base Tank (Tier 0)**: holds **3** adult fishes.
     - **Tank 2 (Tier 1)**: holds **4** adult fishes.
     - **Tank 3 (Tier 2)**: holds **5** adult fishes.
     - **Tank 4 (Tier 3)**: holds **6** adult fishes (maximum capacity is **6**).
   - **Babies Over Capacity**: Autonomous AI breeding can spawn eggs and juveniles (`egg` / `juvenile`) above the tank's adult capacity limit. When those babies mature into adults over the limit, they stay safely in the tank and new breeding pauses until the fish count drops below capacity (or the owner moves to a larger tank).
   - **Owner Level & Fish Shop**:
     - Players earn **Owner XP & Owner Level** (`Level 1` upward) naturally by feeding fishes, maintaining clean water, keeping fishes healthy, and raising offspring.
     - The **Aquarium Shop** lets players purchase fishes from trained Base Models & the Famous Aquarium Fishes catalog **unlocked by their Owner Level**, up to their active tank's space capacity (`3`, `4`, `5`, or `6`).

3. **Dynamic 24/7 Fish Keeper Live Hand-Off & Owner Auto-Feeder (`trainer.html` + `index.html`)**:
   - **Dynamic Live Hand-Off**:
     - When a user opens `index.html`, their `mypc_user_brains/{username}` document immediately updates `isOnlineInGame: true` (with a live heartbeat + `beforeunload` / `visibilitychange` offline listener).
     - The Trainer's **24/7 Fish Keeper** subscribes to Firestore (`onSnapshot`) and local storage events in real time: as soon as a user opens the game, their fishes are **immediately removed from the Fish Keeper simulation** so they live exclusively in the user's running aquarium. When the user exits the game, their fishes **immediately return to the Fish Keeper**.
   - **Owner Auto-Feeder Check**:
     - When the Trainer's global auto-feeder override is **disabled**, the Fish Keeper inspects each offline owner's saved aquarium state (`autoFeederCountByTank` and `autoFeederStock`). If the owner has an active auto-feeder and pellet stock in their tank, the Fish Keeper automatically dispenses pellets from the owner's supply to keep their fishes fed.

4. **Restored Advanced AI Trainer Studio & 50 Famous Aquarium Fishes (`trainer.html`)**:
   - **50 Top Famous Aquarium Fishes Catalog**: A built-in biological library of 50 iconic real-world freshwater and marine aquarium species (*Neon Tetra, Discus, Freshwater Angelfish, Betta Splendens, Fancy Guppy, Clownfish, Regal Blue Tang, Mandarin Dragonet, Oscar, German Blue Ram, Cardinal Tetra, Corydoras Panda, Bristlenose Pleco, Asian Arowana, Flowerhorn, Koi, Oranda Goldfish, Boesemani Rainbowfish, Harlequin Rasbora, Killifish, Electric Yellow Cichlid, Frontosa, Dwarf Puffer, Lionfish, Moorish Idol, Celestial Pearl Danio, Cherry Barb, Kuhli Loach, Glass Catfish, Rummy Nose Tetra*, etc.) with realistic 3D body silhouettes, colors, lifespans, owner-level requirements, and metabolic traits.
   - **Base Model Property & Lifespan Editor**: Edit any species / base model's biological and gameplay properties (`lifespanHours`, `requiredOwnerLevel`, `shopPrice`, `maturityAgeHours`, `reproductionIntervalHours`, `metabolismRate`, `baseSpeed`, `bodyStyle`, `finScale`, `tailScale`, `primaryColor`, `secondaryColor`) and persist directly to Firestore `base_models`.
   - **Extended Generations Training (`5` to `1,000+` Gens)**: Preset generation buttons (`5`, `15`, `30`, `50`, `100`, `250`, `500`, `1000` generations) plus custom generation count input, paired with the **CPU Usage Limit (`10%` to `Max`)** throttle slider.
   - **Restored Advanced Studio Tabs with `?` Help Modals**:
     1. **24/7 Fish Keeper Service** (Live online/offline owner hand-off, owner auto-feeder check, CPU throttle)
     2. **Train Base Models** (Up to 1,000+ generations, live fitness curve, Firestore `base_models` publishing)
     3. **Species & Base Model Editor + 50 Famous Fishes Catalog** (Create from 50 famous species or custom, edit lifespan & properties)
     4. **Neural Brain Architecture Lab** (Hidden layers, neurons per layer, activation functions, mutation rate/strength, topology visualizer)
     5. **Evolution & Environment Rules** (Selection pressure, elitism, metabolic cost, hazard density, water decay rates)
     6. **Lineage, A/B Experiments & JSON Registry** (Generation ancestry tree, side-by-side brain benchmark, JSON import/export)
     7. **Gmail Admins (`admins` collection)**

---

## 2. Key Technical Changes
- **`/src/engine/types.ts` & `/src/engine/defaults.ts`**:
  - Update the 4 aquarium tanks to `maxFishCapacity: 3`, `4`, `5`, and `6` (removing species-tier gating from tanks so tanks only govern space capacity and volume).
  - Add `ownerLevel` and `ownerXp` to `SimulationState`, and add `requiredOwnerLevel` and `shopPrice` to `SpeciesDefinition`.
- **`/src/engine/famousFishCatalog.ts` *(New)***:
  - Define all **50 famous aquarium fish species** with scientific names, 3D body styles (`tropical`, `discus`, `angelfish`, `eel`, `goldfish`, `tetra`, `shark`), colors, lifespans, and owner-level unlock tiers.
- **`/src/engine/simulation.ts`**:
  - Enforce tank capacity (`3 / 4 / 5 / 6`) for shop purchases while allowing autonomous AI breeding to birth `egg` / `juvenile` offspring above capacity; pause new breeding whenever total fish count in the tank is at or above `maxFishCapacity`.
  - Remove user time-scale acceleration from the player simulation loop.
  - Award Owner XP for feeding, cleaning water, fish growth, and autonomous births to progress `ownerLevel`.
- **`/src/engine/firebaseBrainer.ts`**:
  - Add real-time `onSnapshot` listener for `mypc_user_brains` and explicit `setUserGameOnlineStatus(username, isOnline)` with `autoFeederStock` / `autoFeederCountByTank` metadata so the Fish Keeper immediately hands fishes off when the owner opens/closes the game and respects the owner's auto-feeder when the trainer override feeder is off.
- **`/src/App.tsx`**:
  - Implement comprehensive **TV Remote (`MediaPlayPause` / `PlayPause` / arrow keys / `OK` / `Back`)** and **Gamepad (`+` / `Start` / `Select` / D-Pad / `LB` / `RB` / `A` / `B`)** navigation across the aquarium bar and all Owner Menu tabs/items with clear visual focus rings.
  - Add **Buy Fishes (Unlocked by Owner Level)** in the Aquarium Shop tab up to the current tank's `3 / 4 / 5 / 6` limit.
- **`/src/components/TrainerApp.tsx`**:
  - Restore the full multi-tab Advanced AI Trainer alongside the `?` plain-English guide modals, 50 Famous Fishes picker, Base Model Lifespan & Property Editor, 1,000+ generation training options, and dynamic live Fish Keeper hand-off.
- **`/vite.config.ts` & `/dist_dir`**:
  - Set `base: './'` and `build.outDir: 'dist_dir'` so `npm run build` outputs relative asset paths ready for GitHub Pages in `/dist_dir`.
