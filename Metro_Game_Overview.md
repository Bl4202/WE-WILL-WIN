# Metro — Game Overview

**Operate the public transit system of a real city, in a web browser, on real data.**

*This document uses ASD-STE100 Simplified Technical English.*

*This is a companion to the full game design document. It is for investors,
partners, and new players.*

---

## What is Metro?

Metro is a transit management game. It operates in a web browser.

The player is the head of the transit authority of a city. The transit
authority makes these decisions:

- The routes of the trains and the buses.
- The frequency of the service.
- The fare that the passengers pay.
- The source of the money for the system.

Three properties make Metro different from other city games and transit games.

**The city is real.** Metro does not make imaginary cities. It makes its worlds
from open public data. The data contains real street maps, real transit
schedules, and real population and employment records. If you play Chicago, you
get the real transit network of Chicago, its real areas, and its real travel
patterns. The persons in the simulation live where real persons live. They
travel where real persons travel.

**The decisions of the player are permanent.** The player cannot build a metro
line, look at its failure, and then delete it. Transit construction is slow and
expensive, as it is in the real world. There is no undo function for a tunnel.
The game gives a reward to the player who reads the data and makes a careful
plan for the future.

**No part of the simulation is hidden.** The simulation is deep, but the game
can explain each number on the screen. If the ridership of a new line is too
low, push the "why?" button. The game then shows the cause. These are
possible causes:

- The trains were too full.
- The station entrance was on the incorrect side of a busy road.
- The increase in the fare sent the passengers back to their cars.

The game always gives an answer, and the answer is always reasonable.

---

## The core experience: what the player does

The player operates in three different time ranges at the same time. A real
transit authority does the same.

### 1. The large view — planning (years)

The largest decisions are here. Study the city and answer these questions:

- Where do the persons live?
- Where do the persons work?
- Where do the persons want to travel, but cannot, because there is no good
  transit?

The game shows this data on the map. It shows heatmaps of the demand, maps of
the congestion, and the gaps in the coverage.

Then propose the projects. You can make a metro line longer, add a station, or
build a corridor for a bus rapid transit service. Before you commit, the game
gives an honest forecast and a price. An example forecast is this: "this
extension will attract approximately 18,400 passengers each day."

Then find the money. You can use the surplus that you kept, or you can issue
bonds. You must pay the interest on a bond. You can also apply for a grant. To
get a grant, satisfy a goal of the city. An example goal is more coverage in
the areas with a poor service.

Then wait for the construction. Construction needs time and money. If you stop
the work in the middle, the loss is large.

Then look at the result, compare it with your forecast, and learn from the
difference. Then the cycle starts again, and you are a better planner.

### 2. The daily view — operations (weeks)

After the construction of a line, you control its operation.

- **The frequency of the trains.** Do the trains come each 3 minutes at the
  peak, or each 15 minutes at night? A more frequent service makes the
  passengers more satisfied, but it costs more.
- **The assignment of the trains.** A long train carries more persons, but it
  costs more to operate. A long train also needs a station with a long
  platform.
- **The fare.** Is the fare flat? Does the fare change with the distance? Are
  the transfers free? Each fare decision is a compromise between the revenue
  and the ridership. A fare change also has a different effect on a passenger
  with a low income and on a passenger with a high income.
- **The condition of the fleet.** A train needs regular maintenance. You can
  omit the maintenance and keep the money. But a train without maintenance
  fails more frequently. A failure makes a delay, and a delay sends the
  passengers away. The game lets you make this bad decision. Then it shows you
  why the decision was bad.

### 3. The live view — one simulated day

The city operates continuously while you plan and manage. The trains and the
buses move along their routes. The simulated passengers leave their homes, walk
to the stations, wait, get on, transfer, and arrive at their work. The peak
crowds increase and then decrease. Sometimes a train fails, and you see the
delay move along the line.

Usually you do not do an action here. You observe. You can stop the time, make
it slow, or make it fast. The maximum speed is one day each minute. Click on a
train, a station, or a line to see its condition. Here you see the results of
your plan.

---

## The money: realistic, but fair

Metro models the finance of a transit system as it is in the real world. This
is more interesting than the usual game loop, which is "make a profit, then buy
more".

- **Construction** of the track, the stations, and the trains comes from the
  capital account. These are large, single payments. The money comes from the
  surplus, from bonds, and from grants.
- **Operation** of the system pays for the electricity, the wages, and the
  maintenance. This money comes from the operating account. The revenue comes
  from the fares and from the subsidy.

The important point is this: **a real transit system almost never makes a
profit, and this game does not ask you to make one.** Most real systems get
only 20% to 70% of their operating cost from the fares. The public subsidy pays
for the remainder. This is correct, because a transit system gives more value to
a city than the money in the farebox. Your task is not to become rich. Your
task is to satisfy your mandate and to stay in your subsidy limit. The mandate
contains the ridership, the coverage, the reliability, and fair access for all
the areas.

But you *can* fail. If you spend too much for a long time, your credit rating
decreases. Then a loan costs more, and you must decrease the service. Then the
passengers go away and the revenue decreases more. This is a decline that
continues. It is never a random disaster event. If it occurs, it occurs because
of your decisions, and you can find the full cause.

---

## The primary mechanic: a comparison with reality

This is the most unusual part of Metro.

Before a city goes into the game, the persons who make the game tune the
simulation. They tune it until it agrees with the *real* transit performance of
that city. The simulation must agree with the real ridership on each line, the
real speeds, and the real revenue. The city becomes playable only after the
simulation agrees with reality. Thus your start condition is not an estimate by
a designer. It is a correct model of the real city.

From this start condition, all your work changes the city. Each time that you
propose a project, the game makes two numbers:

1. **The forecast.** This is the result that the planning model calculates.
2. **The real result.** This is the result of the full simulation. That
   simulation includes the complex effects of the real world. The effects are
   too many passengers, missed transfers, road traffic, and new habits.

The difference between the two numbers is your **forecast accuracy** score. A
player who reads the city correctly can predict the result of a project. This
player gets institutional credibility, which gives cheaper loans, easier
grants, and better planning tools. Thus the game gives its reward for
*knowledge about the operation of a city*. It does not give a reward for fast
clicks or for memory of a technology tree.

---

## Construction: real engineering that a player can use

Each object that you build in Metro has real parts and real compromises.

**Trains** do not have levels. Each fleet class has real properties: the
capacity, the acceleration, the number of doors, the reliability, the purchase
cost, and the maintenance cost. More doors give a faster boarding and thus a
shorter stop. A full train has a lower acceleration than an empty train. This
makes the full peak schedule slow. This is a real effect, and it comes out of
the physics of the game.

**Stations** are the most complex objects that you build. You make these
choices:

- The construction method. A station on the surface is cheap. A station in a
  deep tunnel is expensive.
- The length of the platform. A short platform permits only a short train, and
  this is permanent unless you pay to make the platform longer.
- **The position of the entrances.** This is important.

The position of an entrance looks like a small decision, but it is one of the
deepest decisions in the game. An entrance on the correct side of a river or a
highway can double the number of persons who can walk to the station easily.
The game calculates the real walk routes to each entrance. Thus this decision
is real strategy, not decoration.

**There are fourteen transport modes.** They include the heavy metro, the tram,
the bus rapid transit, the ferry, the gondola, the bike-share, and the shuttle
that comes on demand. Each mode has its correct use, which its cost and its
capacity control. The game never tells you the correct answer, but the data
shows it. If you build an expensive metro line through an area with few
persons, you lose money. If you operate small buses in a corridor that needs a
metro, the passengers cannot get on. The real demand data of the city shows you
which mode is correct. To read that data correctly is the game.

**A network is better than a line.** A cheap bus route can increase the
ridership of an expensive rail line that it connects to. This occurs because
the bus route makes the full journey easier. A good transfer hub has short
walks, no stairs, and connections at the correct times. Such a hub permits
journeys that are not possible without it. The best players do not build large
single lines. They build systems in which the parts help each other.

---

## How the passengers decide

Each simulated person in the city makes a travel decision as a real person
does. The person compares the available options. Is the car better than the
train? The decision depends on the full door-to-door time, the cost, the wait,
the number of transfers, and the number of other passengers. If you make any of
these better, more persons select transit. If you make transit worse, they use
their cars again.

Real city planning agencies use the same type of model to examine projects that
cost billions. Metro puts a professional planning tool in a game and makes it
playable.

Some of the most interesting effects come out of this model. No script controls
them.

- **The road traffic and the transit interact.** A bus in car traffic is late.
  Build a dedicated bus lane, and the reliability becomes visibly better. A
  rail line above the traffic is not affected. This is the value of the
  additional money.
- **Full vehicles make the problem worse.** A late train collects more
  passengers. Then its stops become longer, and thus it becomes more late. Many
  persons have seen three buses that arrive together. In Metro this effect
  comes out of the simulation, and the correct tactics can correct it.
- **Success makes new demand.** If you make transit faster and less full, new
  passengers come with time. These new passengers can remove the improvement
  that you made, unless you continue to add capacity. Real cities have the same
  problem.

---

## The appearance of the game

The map *is* the game. The full screen shows a live view of the city, with
thousands of vehicles, lines, and areas. The interface stays out of the way
until you need it.

- A thin strip at the top shows the necessary data: the clock, your money, and
  four gauges. The gauges show the ridership, the coverage, the reliability,
  and how full the vehicles are. A gauge becomes amber or red if it needs
  attention.
- Click on an object. A panel comes in with all the data about the train, the
  station, or the line. Tabs hold the data, thus the panel is never too full.
- Move a slider, for example to make the trains more frequent. The game then
  shows you the calculated effect *before* you commit.
- Switch on a map overlay to see the city as a planner sees it. The overlays
  show these items:
  - Where the demand is highest.
  - Where the persons want transit but do not have it.
  - How far the persons can walk to each station.
  - Where the congestion is worst.
  - Which areas have fair access to the jobs.
- Change the zoom from the full city to the interior of one station in 3D.
  There you position the platforms, the escalators, and the entrances.

Each value on the screen has a "why?" button. This button is the centre of the
game. Push it, and the game explains the cause of that value in simple words.
The button is also the tutorial. The game teaches the operation of a city
because the player can ask it questions.

---

## Play with other persons and against them

The copy of a city is the same for each player. The simulation always gives the
same result from the same decisions. Thus Metro can have three types of
multiplayer.

**Leaderboards and ghosts.** Each player operates the same city and the same
scenario alone. The game puts the results in order. You can put the network of
a good player on your map as a translucent ghost. Then you can study the
solution of that player. The game can do the decisions of any player again to
examine the score. Thus a false score is not possible.

**Cooperative play.** Two to four persons operate one transit authority
together. They divide the real tasks. One person draws the lines, one person
controls the service, and one person controls the money. A large payment can
need a second approval, as it does in a real organization.

**Competitive play.** This is the most unusual mode. Two or more operators give
a service to the *same city and the same passengers*. A passenger selects
between you and your competitor. The passenger uses the same method that
selects between a car and a train. The operator with the better journey gets
the passenger. Decrease your fare below the fare of your competitor, and you
take their passengers, but you also decrease your own revenue. If you and your
competitor fight for one corridor, both of you can lose money. Or you can find
that the express line of your competitor sends passengers into your local
network at a shared hub. The competition and the cooperation come out of real
economics, not out of game rules.

---

## The users of the game

- **Players of simulation games and management games.** These are the players
  of Cities: Skylines, Mini Metro, NIMBY Rails, Factorio, and Football Manager.
  They want more depth and more realism than the usual game in this class.
- **Persons with an interest in transit and cities.** This is a large group
  with a strong interest, and few games serve it. Each day these persons
  discuss transit projects on forums, on YouTube, and on social media. Metro
  lets them test their ideas on a correct model of their own city. "I corrected
  the transit of my city" is content that a person wants to share.
- **Students, teachers, and professionals.** The game contains real planning
  methods. Thus it is correct for a classroom. It is also a good tool for any
  person who wants to know how a transit decision occurs.

**The importance of the browser:** there is no download, no installation, and
no console. A link is the full introduction. One click from a Reddit page or a
YouTube video starts the game with your own city. This makes the game much
easier to start. Games in this class usually need a purchase and a large
installation.

---

## The development plan

The plan starts with a small core and then adds the full design.

1. **Proof of concept.** One real city, rail only, with the core planning
   experience and the forecast.
2. **Live operations.** The full daily simulation: too many passengers,
   delays, maintenance, and the operating economy.
3. **All the modes.** Buses in real traffic, transfer hubs, and the full
   selection between the transport modes.
4. **The meta-game.** The forecast accuracy score, the progression, the grants
   and the bonds, the scenarios, and the leaderboards.
5. **Size and quality.** The largest cities, more city bundles, the 3D station
   editor, and full accessibility.
6. **Multiplayer.** Leaderboards, cooperative play, and competitive operators.

Each stage is a complete product that a person can play and test. Thus the
design decreases its own risk as it continues.

---

## The pitch in one sentence

**Metro is the first transit game with a real city, honest results, and one
necessary skill: real knowledge about the movement of a city. It plays
immediately, in any browser.**

---

*For the technical data, read the full game design document
([Transit_Authority_GDD.md](Transit_Authority_GDD.md)). It contains the
architecture, the data pipeline, the simulation algorithms, and the multiplayer
engineering.*
