# Visual Target Roadmap

*This document uses ASD-STE100 Simplified Technical English.*

A reference screenshot of 2026-08-22 sets the visual target for this game. This
document is a checklist of the features in that image. It is not a plan of the
phases. Most of these features come after Phase 1, which is the current phase.
Some of them agree with items in Phase 3 and Phase 4 of
`Transit_Authority_GDD.md`. The notes below show where they agree. Use this
document to examine future work.

**Status of 2026-09-02.** A checked box shows a feature that the game has now.
Section 1 and section 2 are mostly complete. The station panel of section 3 and
the chrome of sections 4, 6, and 7 are the largest open items.

The reference image shows a 3D transit map at night. The city is New York, in
Brooklyn: Flatbush Av, Tillary St, Jay St, and Fulton Mall. The image contains
a station panel, live departures, an economy display, and the full control
chrome. The groups below give all the detail that is visible in the image.

---

## 1. Map rendering — the 3D city and the day/night cycle

- [x] **3D building extrusion.** The city blocks are 3D blocks with a height.
      The height comes from the data of the building footprint. They are not
      flat 2D areas. In the reference the buildings are one dark grey, with no
      colour for the type of building. *Complete. The game uses a
      `fill-extrusion` layer at full opacity, with a colour ramp of five steps
      by height. The ramp is a deliberate difference from the reference: a
      single grey made the towers of downtown Houston one solid mass.*
- [x] **A control to change between 2D and 3D.** In the reference this control
      is at the bottom right, and its label is "2D". It changes the camera
      between the flat view from above and a 3D view at an angle. *Complete,
      but at the top right, not the bottom right. The 2D mode also hides the
      road structures and returns to a flat planning camera.*
- [ ] **A day/night light cycle.** The light of the basemap changes with the
      clock of the simulation. It is not a fixed dark theme. The sky, the
      shade on the buildings, and the ambient tone all change. The reference
      shows 23:17 in the simulation, and it looks like true night. The sky is
      dark blue, there is no light from the sun or the moon, and the buildings
      are dark shapes, not lit surfaces.
- [ ] **Water areas and green areas.** There is a large dark blue area at the
      top of the image. It looks like a bay or a river. There are smaller teal
      areas near the centre of the map. *Not sure: the smaller teal areas can
      be water, such as a pond or a basin, or they can be parks. The colour
      alone does not give the answer at this resolution. Make a decision about
      a two-colour rule for water and green space. Do not decide this at the
      time of the implementation.*
- [x] **A road network below the 3D buildings.** The image shows thin grey and
      tan lines that make a full street grid. There is also a highway
      interchange with curved ramps at the top centre. Thus the basemap holds
      all the road detail, not only the large roads. *Complete. The game draws
      its own carriageways as MapLibre line layers. They are above the basemap
      roadway, below the labels, and below the extrusions, thus the buildings
      hide them. A ramp draws at 8 m and a tunnel does not draw. **One item is
      open:** a line has its width in screen pixels, thus a road does not
      become smaller with its distance from the camera.*
- [x] **Camera controls for pitch and rotation.** The camera must do more than
      pan and zoom. *Complete. The 3D mode starts at 58° of pitch, with a
      maximum of 65°, and it permits the rotation. The 2D mode returns the
      pitch and the bearing to 0 and stops the rotation.*
- [ ] ~~**Round corners on the chrome.**~~ **Decision made on 2026-08-31:
      square corners win. Do not do this item.** Each panel, button, and chip
      in the reference has soft round corners. The game deliberately uses hard
      square corners, from the visual system in `style.md`: a pure black
      ground, hairline white rules, and flat surfaces. Six controls stay
      circular by decision. This closes open decision (a) at the end of this
      document.

## 2. Rendering of the lines, the stations, and the vehicles

- [x] **The lines have a real thickness.** They are not flat paths of 2 px.
      A line looks almost like a raised ribbon that follows the street grid.
      There is a light shadow below it. *Complete. The game draws a wider
      casing below each track segment, then the segment, then a centre line.
      An elevated segment gets a wider casing than a surface segment.*
- [x] **Parallel tracks in a shared corridor.** Two or more lines can use the
      same corridor. Draw them as separate parallel strands. Do not draw them
      as one line. *Complete. The game divides a shared trunk into strands of
      equal width, one for each line, and moves each one to its own side.*
- [ ] **The line colours agree with the real world** in this New York example.
      A red badge is for the 1, 2, and 3 lines. A green badge is for the 4, 5,
      and 6 lines. An orange badge is for the B, D, F, and M lines. These are
      the real MTA colours. *Houston has no equivalent real palette. But make
      a decision about the default colours of the lines that the player draws.
      A strong palette with a high contrast can be better than the current
      light palette.*
- [ ] **Station markers.** A marker has a small white circle, a name label,
      and a row of coloured badges. There is one badge for each line at that
      stop. An example is the badges "5" and "2" adjacent to "Flatbush Av". A
      badge is a small filled circle with a bold white letter or digit. The
      panel uses the same badge style.
- [x] **A highlight for the selected station.** The station in the panel looks
      different from the other stations on the map. *Complete. The selected
      station gets a blue ring, a wider stroke, and its own icon for an
      interchange. The label emphasis of the reference is not done.*
- [ ] **A square overlay for the platform.** There is a translucent light-blue
      rectangle at each station. It is different from the simple dot at other
      positions.
      **A correction to the first version of this document:** this rectangle
      applies to **each** station, not only to the stations with many
      passengers. The earlier text said that the rectangle "rises from busier
      stations". That was an incorrect reading. This rectangle is the default
      view of the physical footprint of a station, and it is present at each
      station.
      **This rectangle is the visual start of a future feature to edit the
      design of a station.** The rectangle is a substitute for the parts that
      the player will configure later. These parts are the length and the
      width of the platform, the position of the entrance, and the form of the
      station. The form is elevated or below the ground. Do not build the
      rectangle as decoration only. Design it as the object that a future
      station editor changes.
- [ ] **A train is a row of connected white squares.** This is visible in the
      bottom right of the reference, on the track. A train is **not** one dot
      or one circle. The current game uses large coloured circles. A train is
      a short row of separate white squares, connected end to end along the
      line. Each square is one car. This is the target design for a train.
  - **The number of cars is the length of the train on the screen.** The row
    of squares shows the number of cars in the train. Thus the length of the
    train must become a real property that the player can examine. Now the
    simulation uses one constant, `TRAIN_CAPACITY`, in `src/constants.ts`. A
    train with 2 cars and a train with 8 cars must look different. A different
    number alone is not sufficient.
  - The squares are white. This is the same colour as the station dot. They
    are **not** the colour of the line. The current vehicle markers use the
    colour of the line. The line itself and its badges carry the identity. The
    train does not repeat it.
  - Each square must turn to the local direction of the line. Thus the cars
    lie flat along the track. A circle does not need a direction, but a square
    does. Examine a closer part of the image to confirm this.

## 3. The station panel (click a station to open it)

This is the largest new *feature* in the image. It is not only a visual change.
It is a real data panel. The full layout, from the top to the bottom, is this:

- [ ] **The header row.** There is a back arrow at the far left, the title
      "Station Details" at the centre, and a close button at the far right.
- [ ] **The name row.** There is a text field with the name of the station in
      it, for example "Flatbush Av". The player can change this text. There is
      a small square button at the right of the field. Its icon is two
      circular arrows. This button makes a new name for the station. Thus the
      game can also make station names automatically.
- [ ] **The badge row.** This row is below the name field. There is one round
      badge for each line at this station. In the image these are a red "2"
      and a green "5". The map uses the same badge style.
- [ ] **The "Ridership" section**, with a bold header:
  - There is one row for each line. The row has a small coloured badge at the
    left, a horizontal bar, and a number at the right. The *length* of the bar
    changes with the value. The green "5" bar is clearly longer than the red
    "2" bar, because the values are 12,171 and 9,108.
  - The last row is the **"Total"** row. It has no badge and no bar. It has
    the label at the left and the sum at the right. The sum is 21,279, which
    is exactly 12,171 + 9,108. Thus the total is a simple sum. It is not a
    count of unique passengers.
- [ ] **The "Departures" section**, with a bold header. The rows are in groups,
      one group for each line:
  - Each group has a header with a round coloured badge and a label, for
    example "2 Train".
  - Below the header there is one row for each direction. The row shows the
    **name of the destination** at the left. At the right it shows two numbers
    with a comma between them and then "min". Examples are "Prospect Pk — 1,
    6 min" and "125 St — 2, 6 min". *The first number is not clear.* It can be
    a platform number, a track number, a position in a queue, or an
    identification number of a train. Do not guess at the time of the
    implementation. Make a decision about the correct meaning. The current
    game has no platform number and no track number.
  - The "2 Train" group shows two directions: Prospect Pk and 125 St. The "5
    Train" group also shows two: 121 St and Eastern Pkwy. Thus each line at a
    station shows both of its directions. It does not show only the next train.
- [ ] **The "Current Usage" section**, with a bold header and one line of text
      below it:
  - A full state shows a live count of the passengers. The image shows the
    **empty state**: "No passengers at station", in a weaker text colour.
- [ ] **The "Nearby Stations" section**, with a bold header. Three rows are
      visible:
  - Each row has a pin icon at the left. The name of the station is on the
    first line, in bold. Below the name there is smaller, weaker text. This
    text gives the **distance in metres** and the **walk time**, with a dot
    between them, for example "268m • 4 min walk". At the right of the row are
    the badges of the lines at that station. Tillary St has F and 6. Jay St
    has 1, F, and 6. Fulton Mall has 3 only.
  - These stations are *not* on the lines of the selected station. This is a
    list of transfers on foot. It is separate from the connections on the same
    line.
  - The rows are in order of increasing distance: 268 m, 441 m, and 500 m.
- [ ] **The chrome of the panel.** The panel is above a translucent dark
      background. All its corners are round. It is at the left edge of the
      screen. Its width is approximately one third of the viewport.

## 4. The icon row at the top right

- [ ] An icon for the map style and the layers. The icon is a folded map.
- [ ] An icon for the sound. The icon is a speaker with sound arcs. Thus the
      game has ambient sound or effects, and the player can stop them.
- [ ] An icon for the **theme**, dark or light. The icon is a crescent moon.
      This is different from the day/night light of the simulation in §1. This
      icon changes the theme of the interface. It does not change the state of
      the simulation.
- [ ] A menu icon with three horizontal lines. It opens a settings menu. The
      image does not show the contents of this menu.
- [ ] The four icons are in one translucent round row at the top right corner.
      The size and the space of the icons are the same.

## 5. The time bar and the economy bar at the bottom

The order below is from the left to the right, as it is in the image.

- [ ] A play/pause button at the far left.
- [ ] **A day counter** ("Day 48") and a **live clock** ("23:17:02", with the
      seconds). The current game has an equivalent, with the day and the hours
      and minutes. But the current game does not show the seconds, and its
      position is different.
- [ ] **A moon icon** immediately after the clock. It shows the time of day.
      It agrees with the day/night light cycle in §1. This icon shows that it
      is night. It is different from the theme icon in §4.
- [x] **Controls to make the time fast**, with two or three steps. *Complete.
      The game has a pause control and the speeds ½, 1×, 10×, and 60×, plus a
      maximum step. The reference wants a different style, not a new
      function.*
- [x] **A money chip**, separate from the time group. It has a small icon that
      looks like a card or a bank note. After the icon is the balance and a
      live green value. Thus this is a real capital account that the game shows
      continuously. *Complete, and earlier than the GDD expected. The bottom
      bar shows the capital balance, the daily cashflow with its sign and its
      colour, and the number of active passengers.*
- [ ] **A chip with the count of the active vehicles.** It has a small train
      icon and a number ("123"). Thus 123 trains are in service in the full
      network. This is cheap to add now. It is only `vehicles.length` in a
      chrome position. It needs no new simulation.
- [ ] Each group is its own round chip. The three groups are the time, the
      money, and the vehicle count. Keep this separation. Do not put them
      together in one strip.

## 6. The tool icons at the bottom left

There are four square icon buttons in a row at the bottom left corner.

- [ ] **A wrench icon** for the build mode and the tools. The current game has
      a build mode for the lines.
- [ ] **A branch icon**, which is two lines that separate from a point, with a
      dot at each end. It looks like a view to plan a route or a line. The
      icon alone does not give the exact function.
- [ ] **A bar icon**, which looks like a list. It is probably a list of the
      lines and the stations. This is a summary of the full network. It is
      different from the single-station panel in §3.
- [ ] **A share icon**, which is a curved arrow. It exports or shares the
      current network. This is a new feature with no support today. Thus the
      game needs a state that a player can share. This can be a save format, a
      link, or an image. The icon does not show which one.

## 7. The map controls at the right

These are in a vertical group at the bottom right corner. Each one is a
separate round square button.

- [ ] **A compass button** at the top of the group. It sets the camera to
      north. It has a use only after the map rotation is available. See §1.
- [ ] **The "2D" button.** See §1. It is in this group, immediately below the
      compass.
- [ ] **A zoom-in button and then a zoom-out button** below it. These are the
      usual map zoom controls. Now the game has no zoom buttons on the screen.
      The player must use the scroll wheel.

---

## Note about the order of the work

Most of §1 and the economy display in §5 are not possible until later GDD
phases are complete. The 3D rendering needs work on the geometry and the level
of detail. Phase 5 contains this work: "Large-metro LOD, 3D station inspector".
The money display needs the capital account from Phase 3 and Phase 4.

Two parts of this image are possible now, on the *current* Phase 1 game. They
do not need a larger simulation kernel. These parts are the **station panel
(§3)** and the **chrome changes (§4, §6, §7)**. They are mostly new interface
elements around data that `simulation.ts` already holds. That data is the
ridership, the departures, and the nearby stations. It is cheap to calculate.

One decision is closed and one is open.

- **(a) Closed on 2026-08-31: square corners win.** This reference has round
  corners only. The game keeps its hard square corners, from the visual system
  in `style.md`. Do not make the corners round.
- **(b) Open.** The meaning of the two numbers in each row of the Departures
  section. The current simulation has no platform number and no track number
  for the first number. Make this decision before the implementation. Do not
  guess at the time of the work.
