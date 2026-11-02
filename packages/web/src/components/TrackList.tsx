import { useState, useEffect, type ReactNode, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Announcements,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type { Track } from "../lib/api";
import { tracks as tracksApi, playlists as playlistsApi } from "../lib/api";
import { player } from "../lib/audio";
import Attribution from "./Attribution";
import PlayCount from "./PlayCount";

type Props = {
  tracks: Track[];
  // Called ONCE per drag, on drop, with the final order. Omit it for a reader
  // who cannot reorder (a listen-only share link): the rows then have no handle.
  onReorder?: (trackIds: string[]) => void;
  // Removes the track from THIS playlist. The track and its files survive and
  // stay in every other playlist and in the library. Named onRemove, not
  // onDelete, because it used to call DELETE /tracks/:id while every label
  // said "remove".
  onRemove?: (trackId: string) => void;
  // Which playlist the remove control acts on. Required whenever onRemove is
  // set; without it the control does nothing.
  playlistId?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function ProgressBar({ trackId }: { trackId: string }) {
  const [state, setState] = useState(player.getState());

  useEffect(() => player.subscribe(setState), []);

  if (state.track?.id !== trackId || !state.duration) return null;

  const pct = (state.currentTime / state.duration) * 100;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "2px",
        background: "var(--border)",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "var(--accent)",
          transition: "width 0.3s linear",
        }}
      />
    </div>
  );
}

// One sortable row. The drag starts from the handle only — the old version made
// the whole row draggable, so click-to-play, text selection and drag all fought
// over the same gesture. Other rows slide aside while dragging (transforms
// only); nothing is reordered until the drop.
function SortableRow({
  id,
  index,
  canReorder,
  title,
  onClick,
  style,
  children,
}: {
  id: string;
  index: number;
  canReorder: boolean;
  title: string;
  onClick: () => void;
  style: CSSProperties;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !canReorder });

  return (
    <div
      ref={setNodeRef}
      data-track-row={index}
      onClick={onClick}
      title="Click to play"
      style={{
        ...style,
        transform: CSS.Transform.toString(transform),
        transition,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
        background: isDragging ? "var(--bg)" : style.background,
        outline: isDragging ? "1px solid var(--accent)" : undefined,
        boxShadow: isDragging ? "0 6px 20px rgba(0,0,0,0.6)" : undefined,
      }}
    >
      {canReorder ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${title}`}
          title="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
          className="drag-handle"
          style={{
            background: "none",
            border: "none",
            color: "var(--fg-dim)",
            fontFamily: "var(--font)",
            fontSize: "14px",
            lineHeight: 1,
            // A real target, not an 11px glyph. touch-action:none on the
            // handle alone, so a finger elsewhere on the row still scrolls.
            padding: "0.4rem 0.35rem",
            margin: "-0.4rem 0 -0.4rem -0.1rem",
            cursor: isDragging ? "grabbing" : "grab",
            touchAction: "none",
            userSelect: "none",
          }}
        >
          ⠿
        </button>
      ) : null}
      {children}
    </div>
  );
}

export default function TrackList({ tracks, playlistId, onReorder, onRemove, selectedId, onSelect }: Props) {
  const canReorder = !!onReorder;
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  // A refused detach used to be an unhandled rejection — the row simply stayed
  // put with nothing on screen.
  const [removeError, setRemoveError] = useState("");
  const [playerState, setPlayerState] = useState(player.getState());

  useEffect(() => player.subscribe(setPlayerState), []);

  const sensors = useSensors(
    // A few px of travel before a drag begins, so a tap on the handle is not a
    // drag. Pointer events cover mouse, pen and touch alike.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The list is reordered once, here, from the order at drag START. The old
  // version rewrote the list (and fired a PATCH) on every row crossed; those
  // requests raced and the server could keep an intermediate order.
  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!onReorder || !over || active.id === over.id) return;
    const from = tracks.findIndex((t) => t.id === active.id);
    const to = tracks.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(tracks, from, to).map((t) => t.id));
  }

  const titleOf = (id: string | number) => tracks.find((t) => t.id === id)?.title ?? "track";
  const positionOf = (id: string | number) => tracks.findIndex((t) => t.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}, position ${positionOf(active.id)} of ${tracks.length}.`,
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} is over position ${positionOf(over.id)} of ${tracks.length}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `${titleOf(active.id)} dropped at position ${positionOf(over.id)} of ${tracks.length}.` : `${titleOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Reorder cancelled. ${titleOf(active.id)} returned to its place.`,
  };

  async function handleRemove(e: React.MouseEvent, trackId: string) {
    e.stopPropagation();
    if (confirmRemoveId !== trackId) {
      setConfirmRemoveId(trackId);
      return;
    }
    // Remove from THIS playlist, never destroy: the track keeps its master, its
    // rendition, and its place in every other playlist.
    if (!playlistId) return;
    try {
      await playlistsApi.removeTrack(playlistId, trackId);
    } catch (err) {
      // The row is left where it is and the confirm state cleared, so the
      // control returns to rest rather than staying armed over a track that
      // did not move.
      setConfirmRemoveId(null);
      setRemoveError(err instanceof Error ? err.message : "couldn't remove that track");
      return;
    }
    if (player.getState().track?.id === trackId) player.clear();
    setConfirmRemoveId(null);
    setRemoveError("");
    onRemove?.(trackId);
  }

  if (tracks.length === 0) {
    return (
      <div style={{ color: "var(--fg)", padding: "1rem 0" }}>
        no tracks yet
      </div>
    );
  }

  return (
    <div>
      {removeError && (
        <div role="alert" style={{ color: "#f44", fontSize: "12px", padding: "0.5rem 0" }}>
          {removeError}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
        accessibility={{ announcements }}
      >
      <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      {tracks.map((track, i) => {
        const isPlaying = playerState.track?.id === track.id && playerState.playing;
        const isSelected = selectedId === track.id;

        return (
          <SortableRow
            key={track.id}
            id={track.id}
            index={i}
            canReorder={canReorder}
            title={track.title}
            onClick={() => {
              onSelect?.(track.id);
              player.play(track.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.5rem 0.25rem",
              borderBottom: "1px solid var(--border)",
              cursor: "pointer",
              background: isSelected ? "rgba(68,170,255,0.06)" : "transparent",
            }}
          >
            {/* Track number */}
            <span style={{ color: "var(--fg-dim)", width: "2ch", textAlign: "right", fontSize: "12px" }}>
              {String(i + 1).padStart(2, "0")}
            </span>

            {/* Playing indicator. Decorative — the button below announces the
                same state in its label. */}
            <span aria-hidden style={{ width: "1.5ch", color: "var(--accent)", fontSize: "12px" }}>
              {isPlaying ? "▶" : ""}
            </span>

            {/* Title, as a real button so the row can be reached and fired by
                keyboard — see .row-title-btn. This list is also what the
                anonymous invite view renders (pages/Invite.tsx), so without it
                someone following a share link has no way to play anything
                without a mouse.
                The row keeps its own click handler for mouse users and for
                drag; stopPropagation keeps a click here from firing both.
                minWidth:0 comes from the class, so the title still gives up
                space to the row's secondary items rather than forcing the row
                past its container — the other half of Attribution's contract. */}
            <button
              type="button"
              className="row-title-btn"
              aria-label={`${isPlaying ? "Pause" : "Play"} ${track.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect?.(track.id);
                player.play(track.id);
              }}
              style={{ color: "var(--fg)" }}
            >
              {track.title}
            </button>

            {/* Whose demo. Renders nothing for a reader with no locker session,
                which is what this same list serves on the anonymous invite
                view (pages/Invite.tsx): the API sends them no names. */}
            <Attribution
              mine={track.uploadedByMe}
              name={track.uploadedByName}
              verb="Uploaded"
            />

            {/* Status */}
            {!track.hasStream && (
              <span style={{ color: "var(--fg-dim)", fontSize: "11px" }}>
                processing...
              </span>
            )}

            {/* Plays through this playlist (absent on the invite view) */}
            <PlayCount count={track.plays} scope="playlist" />

            {/* Duration */}
            <span style={{ color: "var(--fg-dim)", fontSize: "12px", width: "5ch", textAlign: "right" }}>
              {track.duration ? formatDuration(track.duration) : "--:--"}
            </span>

            {/* Download the original — the stream is a lossy rendition */}
            <a
              href={tracksApi.downloadUrl(track.id)}
              download
              onClick={(e) => e.stopPropagation()}
              title="Download the original file"
              aria-label={`Download original file for ${track.title}`}
              style={{
                color: "var(--fg-dim)",
                fontFamily: "var(--font)",
                fontSize: "12px",
                padding: "0 0.25rem",
                textDecoration: "none",
              }}
            >
              [↓]
            </a>

            {/* Remove-from-playlist button — detaches, never destroys */}
            {onRemove && (
              <button
                onClick={(e) => handleRemove(e, track.id)}
                onMouseLeave={() => setConfirmRemoveId(null)}
                title={
                  confirmRemoveId === track.id
                    ? "Click again to remove from this playlist"
                    : "Remove from this playlist (the track stays in your library)"
                }
                aria-label={`Remove ${track.title} from this playlist`}
                style={{
                  background: "none",
                  border: "none",
                  color: confirmRemoveId === track.id ? "var(--accent)" : "var(--fg-dim)",
                  fontFamily: "var(--font)",
                  fontSize: "12px",
                  cursor: "pointer",
                  padding: "0 0.25rem",
                }}
              >
                {confirmRemoveId === track.id ? "[remove?]" : "[x]"}
              </button>
            )}

            {/* Progress bar for playing track */}
            <ProgressBar trackId={track.id} />
          </SortableRow>
        );
      })}
      </SortableContext>
      </DndContext>
    </div>
  );
}
