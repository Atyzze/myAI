# myAI Build 97

Build 97 fixes the battery half of the recording line. No storage format or protocol change, and the space figure is untouched.

## The device was not on power

Build 94 showed `🔌 on power` on a device that was running on battery. That was not a misreading of a real value; it was a real value being misread by this app.

The Battery Status API specifies that an implementation which is unable or unwilling to report the battery must answer `charging: true`, `chargingTime: 0`, `dischargingTime: Infinity`, `level: 1.0`. Those are the "I will not say" values, and several browsers return them as a privacy default rather than exposing the real battery. Build 94 took `charging === true` at face value and announced the device was plugged in.

## Nothing is said about a battery unless the battery was measured

The line now carries a battery figure only when there is a real one:

- Charging, or reporting the values above: nothing. The line is exactly what it would be on a machine with no battery interface at all.
- Discharging but not yet measured: nothing.
- Discharging, and at least `BATTERY_MIN_DROP` of the battery has actually drained during this recording, which is 4%: `🔋 about 5 h of battery`.
- A platform that supplies its own `dischargingTime` is believed straight away, because that value only exists when the platform genuinely knows.

`🔌 on power` and `🔋 battery: measuring` are both gone. A figure that cannot be trusted is worse than no figure, and an absent battery estimate is not a state worth narrating.

## What counts as measured

`nextBatteryDrain` now accumulates `dropped`, the total fall in level observed across the recording, alongside the smoothed per-second rate it already kept. A single one-percent step is a quantisation edge and says almost nothing about the hours ahead; four of them is a trend. The count is cumulative over the session rather than per step, and charging back up does not erase what was already learned, it only stops adding to it.

On a phone recording with the screen on, 4% is usually fifteen to thirty minutes in. Shorter notes will therefore never show a battery figure, which is correct: a note that short has no battery deadline worth reporting.

## Saying why, once

The first time a recording reads the battery, the console gets one line with the raw `charging`, `level` and `dischargingTime`, and says either that these are the values a browser reports when it will not disclose the battery, or how much has to drain before an estimate appears. This is the only way to tell a private browser from a plugged-in one from the outside, and it costs one log line per recording.

## Contracts

`RUNWAY-001` now states that the battery figure appears only once the battery has been measured. New guards `MUT-BATTERY-GUESS-TOO-EARLY`, `MUT-BATTERY-ON-POWER-SHOWN`, `MUT-BATTERY-DROP-FORGOTTEN`.

Release gate: 16 suites passed (strict gate)
