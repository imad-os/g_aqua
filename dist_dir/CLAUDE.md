# My PC App / Game Repository Rules (CLAUDE.md)

1. Always read the official My PC SDK Guide before editing:
   https://raw.githubusercontent.com/imad-os/g/main/sdk/GUIDE.md
2. Load `<script src="https://imad-os.github.io/g/sdk/mypc-sdk.js"></script>` first in `index.html`.
3. Target Samsung Smart TVs (2024+, Tizen 8/9, Chromium 108+). Avoid allocations in the 60 Hz update/render loop.
4. Design for game controllers first (`MyPC.gamepad`), while keeping every action reachable with TV remote arrows + OK (`onInput`).
5. Persist saves via `MyPC.save` / `MyPC.load`, submit scores via `MyPC.submitScore`, and read owner settings from `MyPC.app_config`.
