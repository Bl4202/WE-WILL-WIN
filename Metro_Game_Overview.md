# Metro — Game Overview

**Run a real city's public transit system. In your browser. Built on real data.**

*A plain-language companion to the full Game Design Document, written for investors, partners, and prospective players.*

---

## What is Metro?

Metro is a city transit management game that runs in your web browser. You play as the head of a city's transit authority — the organization that decides where the trains and buses go, how often they run, what riders pay, and how the whole system gets funded.

Here's what makes it different from every other city or transit game you've played:

**The city is real.** Metro doesn't invent fictional cities. It builds its game worlds from real, publicly available data — actual street maps, actual transit schedules, actual population and employment figures. When you play Chicago, you inherit Chicago's real transit network, its real neighborhoods, and its real commuter patterns. The people in the simulation live where real people live and travel where real people travel.

**Your decisions matter — and stick.** This is not a game where you slap down a subway line, watch it fail, and delete it. Building transit is slow and expensive, just like in real life. There's no undo button on a tunnel. The game rewards players who study the data, plan carefully, and think several moves ahead.

**Nothing is a black box.** The simulation underneath is deep, but every number on screen can be explained. If ridership on your new line disappoints, you can click a "why?" button and see exactly what happened — maybe the trains were too crowded, maybe the station entrance was on the wrong side of a busy road, maybe your fare hike pushed people back into their cars. You always get an answer, and the answer always makes sense.

---

## The Core Experience: What You Actually Do

Playing Metro means working across three timescales at once, just like a real transit authority does.

### 1. The Big Picture — Planning (years)

This is where the biggest decisions live. You study the city: Where do people live? Where do they work? Where are people trying to travel but can't, because there's no good transit option? The game shows you all of this visually — heatmaps of demand, maps of congestion, gaps in coverage.

Then you propose projects: extend a subway line, add a new station, build a bus rapid transit corridor. Before you commit, the game gives you an honest forecast — "this extension should attract around 18,400 riders a day, give or take" — along with the price tag.

Then you have to pay for it. You can spend saved-up surplus, issue bonds (which you'll have to pay back with interest), or win grants by hitting goals the city cares about, like expanding coverage to underserved neighborhoods.

Then you wait while it's built — construction takes time and money, and canceling midway is painful.

Finally, you watch what actually happens, compare it to your forecast, and learn. Then the cycle begins again, and you're a smarter planner than you were before.

### 2. The Day-to-Day — Operations (weeks)

Once lines are built, you decide how they run:

- **How often do trains come?** Every 3 minutes at rush hour? Every 15 at night? More frequent service means happier riders but higher costs.
- **Which trains run where?** Longer trains carry more people but cost more to run — and they only fit at stations with long enough platforms.
- **What do riders pay?** A flat fare? Pay-by-distance? Free transfers? Every fare decision trades revenue against ridership, and hits low-income riders differently than wealthy ones.
- **Keeping the fleet healthy.** Trains need regular maintenance. You can skip it to save money in the short term — but neglected trains break down more, breakdowns cause delays, delays drive riders away. The game lets you make that bad decision and then teaches you why it was bad.

### 3. The Live City — Watching It All Work (a simulated day)

While you plan and manage, the city runs continuously in front of you. Trains and buses move along their routes. Simulated passengers leave home, walk to stations, wait, board, transfer, and arrive at work. Rush hour crowds build and subside. Occasionally a train breaks down and you watch the delay ripple down the line.

You mostly don't intervene here — you observe. You can pause time, slow it down, or speed it up to a full day per minute. You can click on any train, station, or line to see exactly what's happening with it. This is where your planning decisions become visible, for better or worse.

---

## The Money: Realistic, But Fair

Metro models transit finance the way it actually works, which is more interesting than the usual "make profit, buy more stuff" game loop:

- **Building things** (tracks, stations, trains) comes from a capital budget — big, one-time expenditures funded by surplus, bonds, and grants.
- **Running things** (electricity, wages, maintenance) comes from an operating budget — ongoing costs covered by fares and subsidies.

Here's the key insight: **real transit systems almost never turn a profit, and the game doesn't ask you to.** Most real systems recover only 20–70% of operating costs from fares — the rest is public subsidy, because transit's value to a city goes beyond the farebox. Your job isn't to get rich. Your job is to deliver on your mandate — ridership, coverage, reliability, and fair access for all neighborhoods — while staying within your subsidy.

But you *can* fail. Overspend persistently, and your credit rating drops, borrowing gets more expensive, you're forced to cut service, riders leave, revenue falls further — a death spiral. It's never a random "disaster event." If it happens, it happens because of decisions you made, and you'll be able to trace exactly how.

---

## The Signature Mechanic: Getting Graded Against Reality

This is Metro's most distinctive idea, and worth explaining carefully.

Before a city goes into the game, the simulation is tuned until it accurately reproduces that city's *real* transit performance — the real ridership on each line, the real speeds, the real revenue. Only when the simulation faithfully mirrors reality does it become playable. That means your starting point isn't a designer's guess. It's a working model of the actual city.

From there, everything you build changes the city outward from that realistic baseline. And every time you propose a project, two numbers get created:

1. **The forecast** — what the planning model predicts your project will achieve.
2. **The reality** — what actually happens when the full simulation plays out, with all its messy real-world effects: overcrowding, missed transfers, traffic, riders changing their habits.

The gap between those two numbers becomes your **Forecast Accuracy score**. Players who learn to read the city well — who can predict what a project will actually do — earn institutional credibility: cheaper loans, easier grants, better planning tools. In other words, *understanding how cities really work* is the skill the game rewards. Not clicking fast. Not memorizing a tech tree. Genuine insight.

---

## Building Things: Real Engineering, Made Playable

Everything you build in Metro is made of realistic parts with real trade-offs:

**Trains** aren't "Level 1, Level 2, Level 3." Each fleet has real characteristics: how many people fit, how fast it accelerates, how many doors it has (more doors = faster boarding = shorter stops), how reliable it is, what it costs to buy and maintain. A packed train genuinely accelerates slower than an empty one, which slows down the whole rush-hour schedule — a real phenomenon, emerging naturally from the game's physics.

**Stations** are the most detailed things you build. You choose how they're constructed (a cheap surface station or an expensive deep tunnel?), how long the platforms are (short platforms mean short trains — forever, unless you pay to extend them), and — crucially — **where the entrances go**. This sounds small but it's one of the deepest strategic choices in the game: a station entrance placed on the right side of a river or highway can double the number of people who can conveniently reach it. The game calculates actual walking routes to every entrance, so this is real strategy, not decoration.

**Fourteen transport modes**, from heavy metro to trams, bus rapid transit, ferries, gondolas, bike-share, and on-demand shuttles. Each has a natural niche based on cost and capacity. And here's the important part: **the game never forces the "right" answer, but the data makes it visible.** Build an expensive metro line through a sleepy suburb and you'll bleed money. Run little buses on a corridor that needs a metro and you'll drown in overcrowding. The city's real demand data tells you which tool fits — reading it correctly is the game.

**Networks beat lines.** A cheap feeder bus route can dramatically boost ridership on an expensive rail line it connects to, because it makes the whole door-to-door journey easier. Great transfer hubs — short walks, no stairs, timed connections — unlock trips that would never happen otherwise. The best players don't build impressive individual lines; they build systems that work together.

---

## How Riders Decide: The Brain of the Game

Every simulated resident of the city makes travel choices the way real people do — by weighing their options. Take the car or the train? The decision depends on total door-to-door time, cost, how long the wait is, how many transfers, how crowded it'll be. Improve any of those and more people choose transit. Make transit worse and they quietly go back to driving.

This is the same category of model that real city planning agencies use to evaluate billion-dollar projects — Metro essentially puts a professional planning tool inside a game and makes it playable.

Some of the most satisfying (and challenging) dynamics fall out of this naturally, with no scripting:

- **Traffic and transit interact.** Buses stuck in car traffic run late. Build a dedicated bus lane and watch reliability visibly improve. Grade-separated rail glides above it all — that's what the extra money buys.
- **Crowding compounds.** A late train picks up extra passengers, which makes its stops take longer, which makes it later. Anyone who's watched three buses arrive at once has lived this — and in Metro it emerges from the simulation naturally, and can be fixed with the right tactics.
- **Success creates new demand.** Make transit faster and less crowded, and new riders appear over time — which can quietly eat the improvement you just built if you don't keep growing capacity. Just like real cities.

---

## What It Looks Like

The map *is* the game. The whole screen is a living, moving view of the city — thousands of vehicles, lines, and neighborhoods — and the interface stays out of the way until you need it.

- A slim strip along the top shows the essentials at a glance: the clock, your money, and four health gauges (ridership, coverage, reliability, crowding) that turn amber or red if something needs attention.
- Click anything — a train, a station, a line — and a panel slides in with everything about it, organized in tabs so it never overwhelms.
- Drag a slider (say, to run trains more often) and the game shows you the projected impact *before* you commit.
- Toggle map overlays to see the city like a planner: where demand is hottest, where people want transit but don't have it, how far people can walk to each station, where congestion is worst, which neighborhoods have fair access to jobs.
- Zoom from the whole city down into a single station's interior in 3D, where you place platforms, escalators, and entrances by hand.

Every metric on screen has a "why?" button, and it's the game's soul: press it and the game explains, in plain terms, what's driving that number. It doubles as the tutorial — the game teaches you how cities work by letting you interrogate it.

---

## Playing With (and Against) Others

Because every player's copy of a city is identical, and the simulation always produces the same result from the same decisions, Metro supports three kinds of multiplayer:

**Leaderboards & Ghosts.** Everyone tackles the same city and scenario solo, ranked on results. You can overlay a top player's network on your map as a translucent "ghost" to study how they solved the same puzzle. And because the game can replay anyone's decisions to verify the score, cheating is structurally impossible.

**Co-op.** Two to four friends run one transit authority together, splitting the real jobs: one draws the lines, one runs the service, one manages the money. Big spending decisions can require a second approver — just like a real organization.

**Competition.** The most novel mode: rival operators serve the *same city and the same riders*. Passengers choose between you and your competitor exactly the way they choose between car and train — whoever offers the better trip wins the rider. Undercut a rival's fares and steal their customers (and hurt your own bottom line). Fight over a corridor and you both might lose money. Or discover that your rival's express line actually *feeds* passengers into your local network at a shared hub. The rivalries and alliances emerge from real economics, not game rules.

---

## Who Is This For?

- **Simulation and management game players** — the audiences of Cities: Skylines, Mini Metro, NIMBY Rails, Factorio, and Football Manager — who want more depth and realism than the genre usually delivers.
- **Transit enthusiasts and urbanists** — a large, passionate, underserved community that debates transit projects on forums, YouTube, and social media every day. Metro lets them test their ideas against a rigorous model of their own city. "I fixed my hometown's transit" is inherently shareable content.
- **Students, educators, and professionals** — the game embeds genuine planning methodology; it's a natural fit for classrooms and a credible sandbox for anyone curious how transit decisions actually get made.

**Why the browser matters:** there's no download, no install, no console. A link is the whole onboarding funnel — one click from a Reddit thread or a YouTube video to playing your own city. That radically lowers the barrier for a genre that traditionally hides behind a purchase and a large install.

---

## How We'll Build It

The roadmap moves from a focused core to the full vision:

1. **Proof of concept** — one real city, rail only, with the core planning experience and forecasting working end to end.
2. **Living operations** — the full day-to-day simulation: crowding, delays, maintenance, and the operating economy.
3. **All modes** — buses in real traffic, transfer hubs, and the full choice between transport modes.
4. **The meta-game** — forecast accuracy scoring, progression, grants and bonds, scenarios and leaderboards.
5. **Scale and polish** — the largest cities, additional city bundles, the 3D station builder, full accessibility.
6. **Multiplayer** — leaderboards, co-op, and competing operators.

Each stage is a playable, testable product on its own — the design de-risks itself as it goes.

---

## The One-Sentence Pitch

**Metro is the first transit game where the city is real, the outcomes are honest, and the winning skill is genuinely understanding how cities move — playable instantly, in any browser.**

---

*For technical depth — architecture, data pipeline, simulation algorithms, and multiplayer engineering — see the full Game Design Document ([Transit_Authority_GDD.md](Transit_Authority_GDD.md)).*
