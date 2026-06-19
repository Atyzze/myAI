# How to Vibe Code (From Someone Who Wrote Code Before LLMs)

*The minimal toolset to become a self-reliant builder — plus a working AI-native voice app and exactly how to talk to the model.*

---

I've been programming for over a decade — long enough that "the AI writes the code now" landed on me as a working professional, not a beginner. So I want to say the thing people dance around:

**LLMs removed the barrier to *writing* code. They did not remove the barrier to *being self-reliant*.**

Those are different walls. The first one — "how do I write this loop, this query, this socket" — is basically gone. You can describe what you want in plain language and get working code back. But the second wall is still standing: knowing *what to want*, expressing it as something you can *verify*, and owning the ground it runs on so you can keep it alive without asking anyone.

That second wall is the whole game now. And nobody hands you the map over it, because the map isn't syntax — it's a small set of concepts and tools you have to *own*. This post is that map. At the end you should be able to take an idea, talk it into existence with an AI, put it on a real Linux box behind real HTTPS, and maintain it yourself, forever, without a teacher.

I'll prove it with a real app I built this way — a browser-based, AI-native voice recorder — and then give you the crash course on the part the AI *can't* do for you: standing up the backend.

---

## Part 1 — The one principle that makes AI coding actually work

Here it is, and everything else hangs off it:

> **Define your functionality as a list of tests. Let the AI write the code that makes them pass.**

That's it. That's the paradigm. I think of it as **bifurcation** — you split your project into two systems that talk to each other:

1. **A list of features, each paired with a test that verifies it.** This is *what you want*, written down in a form a machine can check.
2. **The code that makes those tests pass.** This is *how*, and increasingly it's the AI's job, not yours.

Function emerges from the conversation between those two halves. Your job migrates almost entirely into the first half: translating fuzzy human desire into concrete, checkable statements. That, by the way, is the thing programmers were *always* secretly being trained to do — turn "I want it to feel snappy" into "this request returns in under 200ms." We just used to spend most of our hours on the second half. Now we don't have to.

### Why this works: AI is reliable exactly where verification is cheap

An AI coding session is an *exploration of possibilities*. Most possibilities it tries are good. Some collapse — it makes mistakes, same as we do, and there is **no way to guarantee in advance** that a given change won't break something elsewhere. That's not a flaw to be fixed; it's the nature of the thing.

So you don't fight it. You *fence* it. The fence is your test suite.

The clearest example: say one of your features is "the app serves a webpage at this address, on this port." You can write a five-line check that hits that socket and asks: is it up? Yes/no. The moment it's "no," you know instantly, and you know *which* change broke it. Now imagine that for every feature you care about. Your functionality *is* that list of tests. Define the list, and you can let the AI do nearly everything else — architecture, refactors, optimization loops — because every change gets graded against the list before you trust it.

This also tells you precisely where AI **stops** being magic: anywhere you can't write a cheap test. "Make the rendered waveform look right." "Make this robot crack an egg." "Make this nurse read the room." Those have a thousand context-dependent details you can't reduce to pass/fail, and that's exactly where you still need human judgment in the loop. Knowing that boundary is half of being good at this.

A rule of thumb I actually use: **keep the size of your code and the size of your tests roughly in balance.** If you have ten times more test code than app code, you probably need more app code to satisfy it; if you have almost no tests, you're flying blind. The two halves should grow together.

---

## Part 2 — How to actually talk to the AI

The workflow is dumber than people expect:

1. **Give it the whole thing.** Zip your entire codebase — every source file, every config, even the output files — and hand it over with one line: *"full in-depth code review, please."* Repeat that in fresh contexts and watch the suggestions get less obvious over time as the codebase tightens. The model holds the whole shape in its head better than I can hold three files in mine.

2. **Describe the feature however you actually think.** You don't have to write a spec. You can *talk* — ramble into a recording, transcribe it, and paste the transcript on top of the zip: "somewhere in here I describe a feature I want; build it." It genuinely works. (This very post exists because I did exactly that.) Your decade of experience still shows up here, but as *taste*, not typing: you'll know to say "this should be a two-file change, not a rewrite," and you'll be right.

3. **Make it write the tests too.** Don't just ask for the feature. Ask: *"analyze all the code, infer the intended behavior, and define as many reasonable tests as you can."* Now every future change has a net under it. This is the single highest-leverage sentence in your whole vocabulary.

4. **Respect the limit out loud.** Tell it — and remind yourself — that it can be wrong, that's why the tests exist, and that an *error message is a gift*. Seeing an error isn't "it doesn't work." It's the pipeline telling you *why*, which is strictly more information than silence. Be happy when you get one.

That's the loop. Intent in → inferred spec → code + tests out → grade against the suite → repeat. You're not writing software anymore so much as *curating* it.

---

## Part 3 — The worked example: an AI-native voice recorder

Here's the app, so this isn't all theory. It's a Progressive Web App — runs in a browser, installs to your phone, works offline. What it does:

- **Records audio** straight in the browser, drawing a live waveform, auto-gain-controlled, flushing the audio to on-device storage in **4-second WAV chunks** as it goes (so a crash never costs you more than a few seconds).
- **Transcribes** each recording — either on-device (local Whisper) or via a cloud endpoint.
- **Replies** with an LLM — local or cloud — and lets you **chain conversations**, feeding one recording's transcript and the AI's reply forward as context into the next.
- Stores everything in **IndexedDB**, survives reloads, recovers half-finished recordings after a crash, and serves the whole app shell from a **service worker** so it loads with no network.

The newest feature — the one I talked into existence on top of the zip — is **play-while-recording**: a real play bar on the *in-progress* recording so you can scrub back and hear what you just said without stopping. And it was tiny, because the architecture already followed the principle above: the audio was *already* being persisted as 4-second chunks, and the stop-time logic *already* stitched those chunks into a playable file. The new feature just had to do that same stitch non-destructively, on a timer.

That last point is the lesson, not a footnote. When I added the feature, I pulled the chunk-stitching out into a **pure function** — no browser, no database, just bytes in, bytes out — and moved it into a file that has no side effects when imported. *Why?* Because a pure function is testable in plain Node with no browser and no install. I wrote two dozen assertions against it. They run with literally `node tests/pure.test.mjs` — no framework, no `npm install`, green or red in half a second.

That's bifurcation made concrete: I pushed the *logic* down into a place I could fence with cheap tests, and left only the un-fenceable part (the actual `<audio>` element, the timer, the DOM) to be confirmed by hand. Which is the honest boundary — the play bar itself, I verify by hitting record, waiting four seconds, and pressing play. No test in Node can stand in for a human ear. **Know which half you're in.**

---

## Part 4 — The part the AI can't do for you: your backend

Here's where the free ride ends. The AI will write you a flawless front-end. But a browser app that talks to AI models still needs *somewhere to live* and *something to talk to*. You have to stand that up yourself. Good news: the minimum is small, and once you've done it once, you own it.

Before the commands, the mental model — because the commands are meaningless without it.

### Abstraction levels (the ladder you're standing on)

Everything you touch is a stack of layers, each one hiding the one below:

```
electrons in silicon
   → logic gates (and / or / not)
      → machine code the CPU runs
         → a programming language (JavaScript, Python…)
            → functions
               → classes / modules
                  → services talking over a network
                     → your app
```

You do **not** need to master every rung. You need to know the ladder *exists* and to always know **which rung you're standing on**. When something breaks, debugging is mostly "which layer is lying to me?" The whole stack is the same trick repeated: math (pure relation) becomes numbers (math pinned down), numbers get forced into matter (technology), and technology gets handed instructions (a program). Math that runs is a program — and a program, unlike math, can *fail*. Which is the entire reason Part 1 exists.

For a web app, the rung that matters most is the network one. So:

### Basic networking principles

- An **IP address** is a machine's location (`203.0.113.5`). **DNS** is the phone book that turns `yourdomain.com` into that number.
- A **port** is a numbered door on that machine. Web traffic uses **80** (HTTP) and **443** (HTTPS). Your app might run on **3000** internally; an AI model might run on **11434**.
- An address + a port = a **socket**. "Serving a website behind a port" just means: a program is listening at one specific door, and when a request knocks, it answers.
- **`localhost` (127.0.0.1)** means "this same machine, don't go out to the network." **`0.0.0.0`** means "listen on every interface" — i.e., the outside world can reach it. Getting these two confused is the #1 reason "it works on my machine" and nothing else.
- A **request/response** is the whole dance: a client opens a connection to a socket, sends an HTTP request, gets a response back. That's the web, top to bottom.
- **HTTPS** is HTTP wrapped in encryption (TLS). You want it always. The encryption needs a **certificate**, which you can now get for free and automatically (more below).
- A **reverse proxy** is a doorman that sits on ports 80/443 and routes incoming requests to the right internal program — your static app to one place, your AI model to another — while presenting one clean HTTPS front door to the world.

### Spinning up a Linux box

Rent the smallest cloud Linux server you can (any provider; pick the cheapest Ubuntu LTS instance). Then, from your own terminal:

```bash
# 1. Connect (you'll get an IP and a temporary root login from the provider)
ssh root@YOUR_SERVER_IP

# 2. Make a normal user with admin rights — don't live as root
adduser you
usermod -aG sudo you

# 3. Update everything, immediately and often
apt update && apt upgrade -y
```

Then set up **key-based login** instead of passwords (far safer). On *your own* machine:

```bash
ssh-keygen                 # if you don't already have a key
ssh-copy-id you@YOUR_SERVER_IP
```

Then on the server, edit `/etc/ssh/sshd_config`, set `PasswordAuthentication no`, and restart SSH (`sudo systemctl restart ssh`). Now only someone holding your key can get in.

### Basic firewall rules

The principle is one sentence: **expose the minimum.** Default to denying everything inbound, then open only the doors you actually use. Ubuntu ships with `ufw` (uncomplicated firewall):

```bash
sudo ufw default deny incoming     # block everything coming in…
sudo ufw default allow outgoing    # …let the server reach out freely
sudo ufw allow OpenSSH             # door 22, so you can still log in
sudo ufw allow 80/tcp              # HTTP
sudo ufw allow 443/tcp             # HTTPS
sudo ufw enable
sudo ufw status                    # confirm what's open
```

Three doors open, everything else shut. That's a sane baseline for a personal app.

### Serving the app + reaching the AI: the reverse proxy

For a static PWA like the voice recorder, the "server" is genuinely simple: serve the front-end files, and proxy any AI calls through to the local model. **Caddy** is the easiest tool for this because it fetches and renews your HTTPS certificate *automatically* — no manual cert wrangling. A minimal `Caddyfile`:

```caddy
yourdomain.com {
    # serve the app's static files
    root * /var/www/myai
    file_server

    # forward AI calls to a model running locally on the box
    reverse_proxy /ollama/* localhost:11434
    reverse_proxy /transcribe/* localhost:9000
}
```

(Adjust paths and ports to your setup — treat this as the shape, not gospel.) Caddy now terminates HTTPS at the front door, serves your app, and quietly relays `/ollama` and `/transcribe` to the models running behind `localhost`, which the firewall never exposes directly. That last bit matters: the AI services listen only on `localhost`, so the outside world can *only* reach them through your proxy, on your terms.

### Keeping things running

If part of your stack is a long-running program (a Node server, a model), you want it to start on boot and restart if it dies. That's a **systemd** service — a tiny text file at `/etc/systemd/system/myapp.service`:

```ini
[Unit]
Description=My app
After=network.target

[Service]
ExecStart=/usr/bin/node /home/you/app/server.js
Restart=always
User=you

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now myapp
```

`Restart=always` means a crash self-heals. That's "which patterns persist, which patterns fade" turned into one config line.

### A word on "security by unguessable URL"

My own voice app uses no login tokens — it leans on a long, random, unguessable URL, plus monitoring: if some IP keeps probing for URLs that don't exist, ban it, with escalating ban times the more it tries (a minute, an hour, a day — but I'd avoid *permanent* bans; that's a longer story). For a low-stakes personal tool, that's a reasonable, pragmatic posture.

But I'll be straight with you, because a guide for newcomers has to be: **obscurity is not authentication.** A secret URL is a weak lock — fine for your own scratch tools, *not* fine for anything sensitive (personal data of others, anything you'd be hurt to lose or leak). The moment stakes rise, add real auth — actual accounts, actual tokens. Know the difference between "good enough for me and my notes" and "good enough to be trusted with someone else's information." Conflating those is how people get burned.

---

## Part 5 — The minimal toolset

So, the question this whole post is really about: **what's the minimal set you have to own to never need a teacher again?** Here it is. It's smaller than you'd think.

1. **A terminal + a shell** (`bash`/`zsh`). The command line is the one interface that exposes every layer.
2. **One language you're comfortable in.** Pick *one* and go deep. JavaScript is a strong single choice because it runs in the browser *and* on the server (Node), so one language covers your whole stack.
3. **Git + a host** (GitHub or similar). Version control isn't optional; it's your undo button across time and your backup.
4. **An editor / IDE.** Whatever you'll actually open every day.
5. **A Linux server (a cheap VPS) + SSH.** Your patch of ground on the internet.
6. **A reverse proxy with automatic HTTPS** (Caddy is the gentlest). Your front door.
7. **A way to keep things running** (systemd, or just your proxy serving static files).
8. **Browser DevTools.** The X-ray for the front-end layer.
9. **An LLM.** The new compiler — it turns intent into code.
10. **A test runner** — even a zero-dependency script you run with `node`. The fence around everything the LLM gives you.

That's the kit. Notice how short it is. Notice that half of it (1, 3, 4, 8) you may already have, and the other half you set up *once*.

---

## Part 6 — Once you have it: what can you make, maintain, and manage?

The payoff isn't just *making* things. Self-reliance is **make + maintain + manage** — and this toolset covers all three, which is the part teachers-and-tutorials rarely get you to.

**Make:** Progressive Web Apps (like the voice recorder), web services and APIs, automation scripts, data pipelines, personal dashboards, bots, static sites, scrapers, little tools that scratch your own itch. If you can describe it and test it, you can build it.

**Maintain:** Because *you* own the test suite, you can change a working app *without fear* — make the edit, run the suite, trust the green. When something breaks in production, you can trace the data stream down through the abstraction ladder and find the layer that's lying. You're not stuck praying; you're debugging.

**Manage:** Because you own the box, the firewall, the proxy, and the deploy, you can keep the thing *alive* — update it, secure it, restart it, scale it a little. It's *yours*. Nobody can deprecate your stack out from under you.

That triad — build it, keep it healthy, run it — is what "self-reliant programmer" actually means. Not knowing everything. Knowing how to **find out**, and how to **check**.

---

## The thing LLMs can't hand you

The model can write any function you ask for. What it *can't* give you is the trail to comfort — the lived sense of which rung you're on, what to want, and how to verify it. That comfort is the entire difference between someone who needs a teacher and someone who doesn't. And it doesn't come from the model writing more code for you. It comes from owning two things: **the ladder of abstraction** and **the verification loop.** Get those, and the teacher you no longer need is the specific one who used to tell you what to type. The judgment you keep — *what to build, and how to know it works* — was always the real job.

Here's the loop I keep noticing, and I'll leave you on it: I rambled an idea into a microphone, pasted the transcript onto a zip, and got working, tested code back. Intent in, software out. I was describing the bridge and walking across it at the same time.

That's the whole craft now. Go build something, fence it with tests, put it on a box that's yours, and keep it alive.
