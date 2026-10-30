# Console Game HUD Menu, Instant Cloud Update Sync & Fish Renaming

A complete transformation of the in-game Owner Menu into a sleek, console-grade game HUD with vertical side tabs and glowing accents, continuous 12–15s real-time cloud update polling with audio feedback (birth chime for gifts/babies, low warning tone for death), MyPC return-button input decoupling so system exit works smoothly on TV, and in-game fish renaming with controller-friendly input.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following decisions were confirmed through Phase 1 interactive questions and will guide the build:

- **Confirmed Decision 1 (Menu Aesthetic)**: **Console Game HUD with glowing accents and side tabs**. Replaces the generic website-like modal with a full console game pause HUD featuring a left vertical tab bar (`[LB/RB]` switcher), dark ocean obsidian surfaces, vibrant cyan/gold neon glow focus states, and a bottom TV controller button legend.
- **Confirmed Decision 2 (Fish Renaming)**: **Rename button on each fish card with TV text input**. Players can select any living fish, press "Rename", and type a custom name using on-screen keyboard or remote/gamepad input, which persists locally and syncs to Firestore.
- **Confirmed Decision 3 (Cloud Update Audio)**: **Chime for birth or gifts, low warning tone for death**. When an admin in the Trainer kills/starves, reproduces, gives, or replaces a fish, the game plays an immediate distinct audio cue and presents a scannable toast notification.
- **Confirmed Decision 4 (MyPC Input & Return Button Decoupling)**: Disables capture-phase key interception when the MyPC system menu or return dialog is active, preventing the game from stealing focus away from MyPC OS navigation.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Continuous 12–15s Real-Time Cloud Updates**: Periodically polls and listens to Firestore `mypc_user_brains` so any trainer action (starve/kill, baby birth, fish gift, or species replacement) takes effect in the user's game within seconds, accompanied by sound effects (triumphant birth chime for new/reproduced fish, deep warning chime for death).
  2. **MyPC Menu Focus Protection**: Respects MyPC system pause/return events so players can use TV remote arrows to navigate the MyPC OS menu and exit the game without focus jumping into the 3D tank.
  3. **Fish Renaming**: Allows owners to personalize each fish with a custom name that stays with their lineage across generations and cloud syncs.
  4. **Console Game HUD Redesign**: Re-engineers the menu into a console-grade HUD with left-hand vertical tabs, glowing focus rings, sleek health/energy gauges, and snappy TV remote navigation that stays at 60 FPS.
- **Target Audience**: TV players, game controller users, and desktop caretakers enjoying a living 3D aquarium game.

---

## 2. User Experience & Visual Design

### A. Console Game HUD Layout
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ABYSSAL EVO · SANCTUARY OVERVIEW                   [Keeper] Lv.3 · 450 Cr · Day 12 · 60 FPS   [X]     │
├─────────────────┬──────────────────────────────────────────────────────────────────────────────────────┤
│  [LB]      [RB] │                                                                                      │
│                 │  SELECTED FISH: NEON TETRA (AURELIA)                       Gen 2 · Adult · 14.2h     │
│  [1] MY FISHES  │  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│      4/5 Live   │  │ Fullness / Energy       [████████████████████░░░░░░] 78%                       │  │
│                 │  │ Comfort & Water Care    [██████████████████████████] 95%                       │  │
│  [2] SHOP & TANK│  │ Genes: Speed 1.4x · Vision 2.2 · Brain: v1.0-base                              │  │
│      6 Species  │  └────────────────────────────────────────────────────────────────────────────────┘  │
│                 │                                                                                      │
│  [3] LIGHTS & 3D│  ALL TANK RESIDENTS (4 ALIVE · 0 DEAD):                                              │
│      Day / Bulbs│  ┌────────────────────────┐ ┌────────────────────────┐ ┌────────────────────────┐  │
│                 │  │ ● Aurelia       Gen 2  │ │ ● Zephyr        Gen 1  │ │ ● Coral         Gen 1  │  │
│                 │  │ Neon Tetra · 78% Energy│ │ Guppy · 84% Energy     │ │ Angelfish · 92% Energy │  │
│                 │  │ [RENAME]   [DETAILS]   │ │ [RENAME]   [DETAILS]   │ │ [RENAME]   [DETAILS]   │  │
│                 │  └────────────────────────┘ └────────────────────────┘ └────────────────────────┘  │
├─────────────────┴──────────────────────────────────────────────────────────────────────────────────────┤
│  [OK / A] Select   [B / Back] Close Menu   [Y / Rename] Rename Fish   [LB / RB] Switch Category        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Aesthetic Direction**: Console Game HUD with deep oceanic obsidian backgrounds (`#050d18` / `#08162b`), crisp 1px glowing cyan borders (`#22d3ee` / `#38bdf8`), golden reward accents for credits, and vibrant status bars.
- **Left Vertical Tab Bar**: Sleek vertical pills with gamepad bumper indicators `[LB] / [RB]`.
- **Fish Card Interactions**: Clean cards showing colored species gem, name, generation, energy gauge, and dedicated `[Rename]` and `[Care / Feed]` buttons.
- **Fish Rename Modal**: Minimalist floating dark overlay with a glowing input field, preset random name generator ("Bubbles", "Zephyr", "Aurelia", "Glacier"), and `Confirm [OK]` / `Cancel [Back]` buttons.
- **TV Controller Navigation**: Full D-Pad up/down/left/right navigation across cards with distinct glowing white/cyan focus borders (`ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950`).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Dual Firestore Sync (Snapshot Listener + 15s Periodic Poll Fallback)**
  - *Chosen Approach*: Maintain the low-latency Firestore `onSnapshot` listener and add an active 15s interval check (`loadUserBrainsFromFirestore`) that compares both `adminOverrideAtMs` and `fishBrains` array differences.
  - *Why*: Snapshot WebSockets can silently sleep or throttle on background tabs or low-power TV browsers; a 15-second lightweight polling heartbeat guarantees updates arrive even if WebSockets stall.
- **Decision 2: Audio Synthesis for Death vs. Birth/Gift**
  - *Chosen Approach*: Use Web Audio API oscillators to generate a distinct low-frequency warning tone (`220Hz -> 140Hz -> 90Hz` triangle wave) for fish deaths, and the existing bright crystalline arpeggio (`playBirthChime`) for new fishes, babies, or admin gifts.
  - *Why*: Zero audio asset download overhead; instant, zero-latency playback on any device.
- **Decision 3: MyPC Menu Return-Button Input Isolation**
  - *Chosen Approach*: When MyPC emits `onPause` or when `screenState === 'paused'`, or when focus is outside the app's interactive root, disable `e.preventDefault()` and `e.stopPropagation()` on arrow keys and return keys.
  - *Why*: Allows the native MyPC TV interface to receive arrow keys so the user can navigate MyPC's system exit menu without the game capturing focus.

---

## 4. Technical Architecture & Data Strategy

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            MYPC GAME RUNTIME                                 │
│                                                                              │
│  ┌──────────────────────┐      15s Poll / onSnapshot      ┌───────────────┐  │
│  │ Firestore Brain Sync │ ◄─────────────────────────────► │ Cloud DB      │  │
│  │ (mypc_user_brains)   │                                 │ (User Brains) │  │
│  └──────────┬───────────┘                                 └───────────────┘  │
│             │                                                                │
│             ▼                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ App.tsx: applyCloudRecordToEcosystem()                                 │  │
│  │ - Detects: newly dead fish  ──► playDeathWarningTone() + Warning Toast │  │
│  │ - Detects: newly added fish ──► playBirthChime()       + Gift Toast    │  │
│  │ - Updates ecosystem state asynchronously                               │  │
│  └──────────┬─────────────────────────────────────────────────────────────┘  │
│             │                                                                │
│             ▼                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ ConsoleGameHUD (Redesigned Menu Component / Modal)                     │  │
│  │ - Left Vertical Tabs: [LB] / [RB] Switcher                             │  │
│  │ - Main Content: Fishes Grid, Shop Cards, Lighting & 3D Toggles         │  │
│  │ - In-Game Rename Flow: [Rename] Button ──► Input Dialog ──► Save State │  │
│  │ - Bottom TV Controller Legend                                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Entities Mutated**:
  - `FishLineage.name`: Player-editable string (max 24 characters, sanitized).
  - `SavedEcosystemState.fishes`: Updated upon rename, local save, and cloud sync.
  - `audioEngine.playDeathWarningTone()`: Web Audio synthesized warning cue.

---

## 5. Verification Plan

1. **Compilation**: Run `npm run lint` (`tsc --noEmit`) and `npm run build` to verify zero type errors and confirm `dist_dir` is generated properly.
2. **Cloud Update Verification**: Simulate an admin action (kill or give fish in Trainer) and verify the player game updates within 15 seconds with the appropriate sound effect.
3. **Fish Renaming**: Test renaming a fish in the HUD, confirming it updates the 3D label, the menu card, local storage, and Firestore record.
4. **MyPC Menu & Return Key**: Test pressing Back/Escape/Return when MyPC menu is shown, verifying arrow keys navigate MyPC instead of the game.
