// The serializers' own attribution gate, tested directly.
//
// resolveDisplayNames already refuses a reader who is not a member of the
// locker being read, so through most routes this check is invisible. It is
// deliberate defence in depth: it makes "a route resolves names and then serves
// them to someone outside the locker" impossible rather than merely absent.
// Untested defence in depth is just code that looks reassuring, so these call
// the serializers with a POPULATED map that is nonetheless marked refused — the
// shape a future route could produce by mistake — and pin the refusal.
//
// The refusal is not redundant for the DEPARTED-member snapshot: that name
// lives in a column on the row rather than in the map, so nothing about an
// empty map would have withheld it. `allowed` is the only thing that does.
import { describe, it, expect } from "vitest";
import { publicTrack, type TrackRow } from "./public-track.js";
import { publicPlaylist, type PlaylistRow } from "./public-playlist.js";
import { NO_NAMES, type DisplayNames } from "./display-name.js";

const NAMES: DisplayNames = { allowed: true, byId: new Map([["u-jimmy", "Jimmy"]]) };

// What a reader outside the locker is handed: refused, but carrying names, so
// the assertion measures the gate rather than an empty map.
const REFUSED: DisplayNames = { allowed: false, byId: new Map([["u-jimmy", "Jimmy"]]) };

const trackRow = (over: Partial<TrackRow> = {}): TrackRow =>
  ({
    id: "t-1",
    playlistId: null,
    ownerId: "u-owner",
    title: "a demo",
    position: 1,
    originalKey: "k",
    streamKey: null,
    waveformData: null,
    duration: null,
    sizeBytes: null,
    uploadedAt: new Date(0),
    uploadedBy: "u-jimmy",
    uploadedByName: null,
    ...over,
  }) as TrackRow;

const playlistRow = (over: Partial<PlaylistRow> = {}): PlaylistRow =>
  ({
    id: "p-1",
    ownerId: "u-owner",
    name: "a set",
    artworkKey: null,
    isPublic: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: "u-jimmy",
    createdByName: null,
    ...over,
  }) as PlaylistRow;

describe("publicTrack attribution", () => {
  it("serves the name to a locker session", () => {
    expect(publicTrack(trackRow(), "u-owner", NAMES).uploadedByName).toBe("Jimmy");
  });

  it("refuses to name anyone for a reader outside the locker, even when handed names", () => {
    const t = publicTrack(trackRow(), "u-outsider", REFUSED);
    // Pins that this is the same row that WOULD have been named — otherwise a
    // null could mean the serializer simply never saw an uploader.
    expect(t.title).toBe("a demo");
    expect(t.uploadedByName).toBeNull();
  });

  // The anonymous share holder, in the shape resolveDisplayNames actually
  // hands back for them.
  it("names nobody for an anonymous reader", () => {
    const t = publicTrack(trackRow(), null, NO_NAMES);
    expect(t.title).toBe("a demo");
    expect(t.uploadedByName).toBeNull();
    expect(t.uploadedByMe).toBe(false);
  });

  it("serves null for an id the lookup did not cover", () => {
    const t = publicTrack(trackRow({ uploadedBy: "u-gone" }), "u-owner", NAMES);
    expect(t.title).toBe("a demo");
    expect(t.uploadedByName).toBeNull();
  });

  it("serves null when nothing is attributed", () => {
    expect(publicTrack(trackRow({ uploadedBy: null }), "u-owner", NAMES).uploadedByName).toBeNull();
  });
});

describe("publicPlaylist attribution", () => {
  it("serves the name to a locker session", () => {
    expect(publicPlaylist(playlistRow(), "u-owner", NAMES).createdByName).toBe("Jimmy");
  });

  it("refuses to name anyone for a reader outside the locker, even when handed names", () => {
    const p = publicPlaylist(playlistRow(), "u-outsider", REFUSED);
    expect(p.name).toBe("a set");
    expect(p.createdByName).toBeNull();
  });

  it("serves null for an id the lookup did not cover", () => {
    const p = publicPlaylist(playlistRow({ createdBy: "u-gone" }), "u-owner", NAMES);
    expect(p.name).toBe("a set");
    expect(p.createdByName).toBeNull();
  });

  it("serves null when nothing is attributed", () => {
    expect(
      publicPlaylist(playlistRow({ createdBy: null }), "u-owner", NAMES).createdByName
    ).toBeNull();
  });
});

// The snapshot columns: the name of a member who has since been removed,
// written onto their rows at removal so the demos they left do not go blank.
// Live account first, snapshot only as the fallback — while the person is here
// their current name wins and a rename propagates for free.
describe("attribution after the uploader's account is gone", () => {
  const departed = (over = {}) =>
    trackRow({ uploadedBy: null, uploadedByName: "Departing", ...over });

  it("falls back to the snapshot when the uploader row is gone", () => {
    expect(publicTrack(departed(), "u-owner", NAMES).uploadedByName).toBe("Departing");
  });

  it("prefers the live name over a stale snapshot while the account exists", () => {
    const t = publicTrack(
      trackRow({ uploadedBy: "u-jimmy", uploadedByName: "Jim from before" }),
      "u-owner",
      NAMES
    );
    expect(t.uploadedByName).toBe("Jimmy");
  });

  it("refuses the departed-member snapshot to a reader outside the locker", () => {
    const t = publicTrack(departed(), "u-outsider", REFUSED);
    // Pins the row that WOULD have been named — a null here must mean refused,
    // not "there was nothing to say".
    expect(t.title).toBe("a demo");
    expect(t.uploadedByName).toBeNull();
    // and the raw column does not travel under its own name either
    expect(JSON.stringify(t)).not.toContain("Departing");
  });

  it("serves null when neither an uploader nor a snapshot is recorded", () => {
    expect(publicTrack(departed({ uploadedByName: null }), "u-owner", NAMES).uploadedByName)
      .toBeNull();
  });

  it("does the same for a playlist whose creator is gone", () => {
    const row = playlistRow({ createdBy: null, createdByName: "Departing" });
    expect(publicPlaylist(row, "u-owner", NAMES).createdByName).toBe("Departing");

    const anon = publicPlaylist(row, "u-outsider", REFUSED);
    expect(anon.name).toBe("a set");
    expect(anon.createdByName).toBeNull();
    expect(JSON.stringify(anon)).not.toContain("Departing");
  });

  it("prefers a playlist's live creator name over its snapshot", () => {
    const row = playlistRow({ createdBy: "u-jimmy", createdByName: "Jim from before" });
    expect(publicPlaylist(row, "u-owner", NAMES).createdByName).toBe("Jimmy");
  });
});
