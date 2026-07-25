/**
 * Bootstrap: load the baked Houston world bundle, then wire the game
 * manager, MapLibre+deck.gl renderer, UI, and input together. Sim state
 * flows one way — kernel → snapshot → render/UI — and player actions flow
 * back as commands (GDD §1.1 in miniature).
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Game } from "./game";
import { bindInput } from "./input";
import { MapRenderer } from "./render-map";
import { Ui } from "./ui";
import { loadWorld, zonesFromDemand } from "./world";

async function boot(): Promise<void> {
  const loading = document.getElementById("loading")!;
  try {
    const world = await loadWorld();
    const zones = zonesFromDemand(world.demand, world.projection);

    const game = new Game(zones);
    const renderer = new MapRenderer(document.getElementById("map")!, world);
    const ui = new Ui(game);
    bindInput(renderer, game, () => game.sim.snapshot());

    const demandBtn = document.getElementById("toggle-demand")!;
    const ghostBtn = document.getElementById("toggle-ghost")!;
    demandBtn.addEventListener("click", () => {
      renderer.showDemand = !renderer.showDemand;
    });
    ghostBtn.addEventListener("click", () => {
      renderer.showGhost = !renderer.showGhost;
    });

    renderer.map.once("load", () => loading.classList.add("done"));

    game.start((snap) => {
      renderer.update(snap, game);
      ui.update(snap);
      demandBtn.classList.toggle("active", renderer.showDemand);
      ghostBtn.classList.toggle("active", renderer.showGhost);
    });
  } catch (err) {
    loading.textContent =
      `Failed to load the world bundle — run "npm run bake" first, then reload. (${err})`;
    throw err;
  }
}

void boot();
