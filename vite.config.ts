import { defineConfig } from "vite";

// GitHub Pages project site: https://bl4202.github.io/WE-WILL-WIN/
// A project site is served from a subpath, not "/", so the production
// bundle must prefix every emitted asset URL with the repo name. Keyed off
// `mode` (not `command`): both `vite build` and `vite preview` run in
// production mode, so this keeps a locally-previewed production build
// consistent with what's actually built — `command`-only would make
// `npm run preview` serve at "/" while dist/index.html points at
// "/WE-WILL-WIN/assets/...", breaking local preview. `vite dev` stays in
// development mode and keeps serving at "/" for everyday convenience.
// src/world.ts already reads import.meta.env.BASE_URL for its fetches, so
// this is the only change needed for the deployed bundle to resolve its
// assets and world data correctly.
export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/WE-WILL-WIN/" : "/",
}));
