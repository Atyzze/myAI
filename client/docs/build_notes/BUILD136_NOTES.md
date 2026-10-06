# myAI Build 136

An opened text can be read hands-free. A saved reply, a saved transcript or a context item, once opened, gets two small controls floating over the text at the bottom right: ▶ to start and pause auto-scroll, and a speed button that opens a popup to set the speed. It is meant for reading a text aloud while a recording runs, and for reading a long reply without touching the screen. Database version stays at 13.

## The controls

- ▶ starts scrolling from where the text is, and becomes a pause button while it runs. At the end of the text scrolling stops by itself and ▶ comes back; ▶ at the end starts again from the top.
- The speed button shows the speed (`20/min` by default) and opens a popup with a slider and - and + buttons. The speed is in lines a minute, from 2 to 120, and turns into pixels a second from the line height of the text being read, so the same setting reads the same on a phone and in a window. - and + step by 1 below 10 lines a minute, by 2 up to 30 and by 5 above. The speed changes at once and is remembered in this browser (`myai-autoscroll-speed`) for the next opened text.
- Escape, or a tap anywhere else, closes the popup. Escape there closes only the popup, not the view behind it.
- The reader stays in charge. A finger or the mouse on the text holds it still for as long as it is down. Scrolling by hand (a wheel, a drag, the scroll bar) moves the reading position, and auto-scroll carries on from there instead of pulling the text back. A frame that comes late, after the view was in the background, moves the text by at most a tenth of a second's worth, never a screen ahead.
- Play and pause are drawn icons rather than characters: the pause character came out at a fraction of the size of the play triangle on some fonts.

## Where they appear

On every opened text that is finished: saved replies, saved transcripts and both parts of a context item, in the in-page view (phones and narrow windows) and in a pop-up window. A pop-up still has no script of its own: as with the text, the opening tab builds the controls in the pop-up's page and runs them on the pop-up's own frames, and its policy only needed to allow the inline style it already allowed. Closing the view removes the controls. Live views (a reply being written, the live transcript) have none: they follow their own growing text.

`autoscroll-core.js` holds the arithmetic (speed, steps, line height, one frame of scrolling, where play starts); `autoscroll.js` draws the controls and runs the frames. A page that cannot show them, such as the stand-in documents the unit tests use for pop-ups, gets none, and the view opens as before.

## Tests

`pure`: speed limits and steps, line height, pixels a second, where play starts, a frame of scrolling (sub-pixel speeds, the reader's own scrolling, a late frame, holding, the end, a text that fits). `browser-lifecycle`: a saved reply in a real pop-up window shows the controls with the remembered speed, opens the speed popup, - slows down, ▶ scrolls from the top of a text opened at its end, pressing again pauses, the speed is remembered, and the pop-up still has no script. `user-journeys`: on a phone-width screen a long context item opened from its row shows the controls on top of the text and inside the view, the slider sets and remembers the speed, Escape closes only the popup, ▶ scrolls and pauses, scrolling stops at the end by itself, and closing the view removes the controls. Two mutation guards: auto-scroll fighting the reader's own scrolling, and scrolling past the end.

22 suites passed; 0 skipped (portable gate) in 10 min 51 s; slowest mutation-guards (6 min 06 s)
