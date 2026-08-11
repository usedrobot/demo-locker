# Brochure simplification — design

**Date:** 2026-08-11
**Target:** `site/` (the `demo-locker` Pages project, deployed by CI's `deploy-site` on every push to `main`)
**Brief (DL):** "it's too convoluted. I want to make this app super easy."

---

## The problem

The page currently asks a visitor to make a decision before it has told them what
the thing is. Three install snippets stack up in the first screenful — agent
prompt, `npx`, `docker run` — each with its own line of prose between them, and
the only evidence of the product is a static PNG below the fold.

The structure is not wrong. The weighting is: three ways to install, one still
image of the thing being installed.

## Structure

Same order as today, with section 4 doing much more work.

| # | Section | Change |
|---|---|---|
| 1 | ASCII wordmark | unchanged |
| 2 | Blurb | ~50 words → ~30 |
| 3 | Install | three stacked boxes → one box, three tabs |
| 4 | Demo video | replaces the static `comments.png` |
| 5 | Featured locker: dlisok | reframed from "hear one" |
| 6 | Self-hosting / what to bring | absorbs the Docker snippet and the docs links |
| 7 | Footer | unchanged |

### 1. Wordmark — do not touch

Generated from the app's own art by `npx tsx scripts/build-site-logo.mjs`. The
comment above it in `index.html` explains why it is SVG cells and not block
characters in a `<pre>`, and that reasoning is still load-bearing on Android.
Regenerate it, never hand-edit it.

### 2. Blurb

> A private locker for your rough mixes. Your band comments straight onto the
> waveform, you set the running order, and you decide what goes public.
> Hosted by you. No streaming terms, no licensing, no bs, *just tunes*.

No em dashes, matching the voice of the current copy. `just tunes` keeps its
`<em>`. The `<meta name="description">` and the OG description track this text;
they are currently three different wordings of the same idea and should become
one.

### 3. Install — one box, three tabs, no JavaScript

Three `<input type="radio">` in one named group, three `<label>`s, three `<pre>`
panels switched with `:checked ~`. Order: **agent**, **npx**, **docker**.

Radios are chosen over the ARIA tabs pattern deliberately. A real tablist owes
roving `tabindex` and arrow-key handling, which is code I would have to write
and then measure in a browser before claiming it works. A radio group is
keyboard-native: arrows move between options, focus rings come free, and the
whole thing works with `copy.js` blocked. The cost is that it announces as a
radio group rather than a tablist, which is an honest description of what it is.

Each label needs an accessible name that says what it selects (`agent prompt`,
`npx wizard`, `docker`), not just a bare word.

`copy.js` gains one behaviour: the copy button copies whichever panel is
currently checked, rather than a fixed `data-target`.

### 4. The demo video

Replaces `/img/comments.png` in the layout.

**Markup.** `<video>` with `muted loop playsinline`, a `poster`, WebM (VP9)
first and MP4 (H.264, `yuv420p`, `+faststart`) second.

**`autoplay` is deliberately NOT in the markup.** `copy.js` starts playback only
when `matchMedia('(prefers-reduced-motion: reduce)')` does not match. This gives
three correct outcomes from one mechanism:

- motion allowed, JS on → it plays
- reduced motion → poster frame, nothing moves
- JS off → poster frame, nothing moves

Putting `autoplay` in the HTML and trying to stop it afterwards races the
browser, and CSS cannot pause a video at all.

**Budget.** 900px at 2x. **Clarity beats file size — DL's call, 2026-08-11:**
"just have it blow the size budget thats fine." The take runs as long as it
needs to read clearly and the 600 KB target is abandoned rather than cutting the
shot short. WebM still ships first so most visitors get the smaller file, and
the poster keeps the page useful before the video arrives.

**Alt text.** A `<video>` gets no `alt`; the description goes in an adjacent
caption that is visible to everyone, since it is useful copy in its own right.

### 5. Featured locker

The current "hear one" section, retitled `featured locker` and pointed at
`dlisok.com#rough-mixes`. Keeps the sentence explaining that the locker is
private and the playlist is the part made public — that distinction is the
product, not a footnote.

### 6. Self-hosting / what to bring

The existing "what to bring with you" list, plus the three docs links currently
in `.fineprint`.

**Correction to an earlier draft of this spec:** it said this section absorbs
the `docker run` snippet, which contradicted §3 once DL chose the three-tab
install block. Docker stays in the tabs. This section links to the self-hosting
docs and does not repeat the command.

### 7. Footer

Unchanged, including the pinned inline lucide GitHub icon and the comment
explaining why it is pinned.

---

## Producing the video

### Content

Recorded against a local instance seeded with invented metadata over DL's real
rehearsal bounces (`/Volumes/Audio Recording/Freddie Caicos and The Sunburns/
Bounces/Rehearsal_7.29.2026`, DL's own material, used with his authorisation).

**The published video is muted and ships no audio track at all.** Only the
waveform shape, computed from the audio, ever leaves the machine. The recordings
themselves are not published.

Originals only. `Long Haired Country Boy` and `Scare Easy` are covers and are
excluded — not because the muted video creates a licensing question, but because
there is no reason to build a marketing asset on someone else's song.

| shown as | sourced from |
|---|---|
| band: **The Sandspurs** | fictional |
| `Slack Tide` | `Out on the Blue_7.29.26.wav` |
| `Cold Coffee` | `Dead End Street_Rehearsal_7.29.26.wav` |
| commenters: `sam`, `jules`, `marco` | fictional, already the names in today's alt text |

### The shot

About 10 seconds, one continuous take, no cuts:

1. Track playing, playhead crossing the waveform
2. A comment typed into the box
3. Posted, and it lands as a marker on the wave at its timestamp

That sequence is the product's actual argument: the comment is pinned to a
moment in the audio, not to a file.

### Pipeline

1. Seed a local instance (API + web, sqlite, local disk) with the band, playlist,
   two tracks and two existing comments.
2. Drive it with Puppeteer invoked through `npx` **from the scratchpad
   directory**, so nothing is added to the repo's `package.json` or lockfile.
3. Capture frames at ~10fps at 900px, `deviceScaleFactor: 2`.
4. `ffmpeg` (7.1.1, already installed) → WebM, MP4 and the poster PNG.
5. Commit only the three output files to `site/img/`.

---

## Verification

`site/` has no test harness and this design does not invent one for a static
page. Verification is manual and stated as such:

- [ ] Loads with no console errors
- [ ] Install tabs: reachable by Tab, switchable by arrow keys, focus visible on
      each label; copy button copies the **checked** panel
- [ ] `prefers-reduced-motion: reduce` emulated → video does not play, poster
      shows
- [ ] JavaScript disabled → poster shows, all three snippets still readable
- [ ] Page weight measured and reported (no cap — see Budget above)
- [ ] Renders at 375px wide with no horizontal scroll
- [ ] Wordmark regenerated by script, not hand-edited
- [ ] Links resolve: dlisok, GitHub, the three docs pages

This is weaker than the coverage in `packages/`. It is recorded here so nobody
later mistakes "the brochure shipped" for "the brochure is tested."

## Risks

**The video is the only risky item.** Sections 1–3 and 5–7 are markup and CSS.
Driving a seeded instance to a clean take is where this can go wrong. If it
does, the fallback is the synthetic CSS/SVG animation built from the same
pixel-art primitives as the wordmark — but that is a drawing of the app rather
than evidence of it, so it is DL's call and not a silent substitution.
Length is no longer among the risks: the take may run as long as it needs to.

**Deploy is automatic.** `deploy-site` ships `site/` on every push to `main`,
with no runbook and no manual gate. Unlike the app instance, a mistake here is
live immediately.
