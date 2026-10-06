# myAI Build 137

A recording card is one row shorter. The retention countdown (⏳ audio 6d, 📝 text 29d) used to take a row of its own under the size bar, while the right half of the size bar's row stood empty. It now sits in that room, at the right end of the row, under the format badge. Database version stays at 13.

- The size bar and its label stay on the left, the countdown goes to the right end. The bar still grows to at most 340 px on a wide screen.
- On a narrow screen the bar gives way first: it can shrink to 24 px, and the gaps are a little tighter (10 px between the two groups, 8 px inside the bar's group), so the row still fits on a 360 px phone with both countdowns showing and a size label as long as "113.0 KB · 2.0%". Below that the countdown wraps under the bar, at the right.
- A recording without audio has no bar; its countdown then starts at the left of the row, as before.

Tests: `user-journeys` records a clip, gives it a transcript so both countdowns show, and checks at the desktop width, at 390 px and at 360 px that the countdown is on the bar's row, at its right end, after the label.

22 suites passed; 0 skipped (portable gate) in 10 min 39 s; slowest mutation-guards (5 min 53 s)
