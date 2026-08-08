// The serializers' own attribution gate, tested directly.
//
// Through the routes this is unobservable: resolveDisplayNames already returns
// an empty map for a reader with no locker session, so the name comes back null
// whether or not publicTrack/publicPlaylist check as well. A mutation run
// confirmed exactly that — deleting the `actingUserId != null &&` from either
// serializer failed nothing. The check is deliberate defence in depth: it is
// what makes "a route resolves names and then serves them to an anonymous share
// holder" impossible rather than merely absent today. Untested defence in depth
// is just code that looks reassuring, so these call the serializers with a
// populated map and no session — the shape a future route could produce by
// mistake — and pin the refusal.
import { describe, it, expect } from "vitest";
import { publicTrack, type TrackRow } from "./public-track.js";
import { publicPlaylist, type PlaylistRow } from "./public-playlist.js";

const NAMES = new Map([["u-jimmy", "Jimmy"]]);

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
    ...over,
  }) as PlaylistRow;

describe("publicTrack attribution", () => {
  it("serves the name to a locker session", () => {
    expect(publicTrack(trackRow(), "u-owner", NAMES).uploadedByName).toBe("Jimmy");
  });

  it("refuses to name anyone for a reader with no session, even when handed names", () => {
    const t = publicTrack(trackRow(), null, NAMES);
    // Pins that this is the same row that WOULD have been named — otherwise a
    // null could mean the serializer simply never saw an uploader.
    expect(t.title).toBe("a demo");
    expect(t.uploadedByName).toBeNull();
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

  it("refuses to name anyone for a reader with no session, even when handed names", () => {
    const p = publicPlaylist(playlistRow(), null, NAMES);
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
