import { useState, useEffect, useCallback, useMemo } from "react";
import { comments as api, type Comment } from "../lib/api";
import { avatarColor } from "../lib/avatar";

type Props = {
  trackId?: string;
  playlistId?: string;
  isOwner?: boolean;
  currentTime?: number;
  onSeek?: (time: number) => void;
};

type Filter = "open" | "all";

const DELETE_TOKENS_KEY = "commentDeleteTokens";

function loadDeleteTokens(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DELETE_TOKENS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveDeleteToken(commentId: string, token: string) {
  const all = loadDeleteTokens();
  all[commentId] = token;
  localStorage.setItem(DELETE_TOKENS_KEY, JSON.stringify(all));
}

function removeDeleteToken(commentId: string) {
  const all = loadDeleteTokens();
  delete all[commentId];
  localStorage.setItem(DELETE_TOKENS_KEY, JSON.stringify(all));
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function Comments({
  trackId,
  playlistId,
  isOwner = false,
  currentTime,
  onSeek,
}: Props) {
  const [items, setItems] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [authorName, setAuthorName] = useState(
    () => localStorage.getItem("commentName") || ""
  );
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");

  const load = useCallback(() => {
    if (trackId) {
      api.forTrack(trackId).then((r) => setItems(r.comments));
    } else if (playlistId) {
      api.forPlaylist(playlistId).then((r) => setItems(r.comments));
    }
  }, [trackId, playlistId]);

  useEffect(() => {
    load();
  }, [load]);

  // Counts (top-level only — replies aren't part of the resolve workflow)
  const { openCount, totalCount, visible } = useMemo(() => {
    const open = items.filter((c) => c.resolvedAt == null).length;
    const total = items.length;
    const v = filter === "open" ? items.filter((c) => c.resolvedAt == null) : items;
    return { openCount: open, totalCount: total, visible: v };
  }, [items, filter]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || !authorName.trim()) return;

    localStorage.setItem("commentName", authorName);

    const r = await api.create({
      trackId: trackId || undefined,
      playlistId: playlistId || undefined,
      authorName: authorName.trim(),
      body: body.trim(),
      timestampSec: trackId && currentTime ? currentTime : undefined,
      parentId: replyTo || undefined,
    });

    if (r.comment.deleteToken) {
      saveDeleteToken(r.comment.id, r.comment.deleteToken);
    }

    setBody("");
    setReplyTo(null);
    load();
    window.dispatchEvent(
      new CustomEvent("comments:updated", { detail: { trackId, playlistId } })
    );
  }

  async function handleResolve(comment: Comment) {
    await api.resolve(comment.id);
    load();
    window.dispatchEvent(
      new CustomEvent("comments:updated", { detail: { trackId, playlistId } })
    );
  }

  async function handleDelete(comment: Comment) {
    const tokens = loadDeleteTokens();
    const token = tokens[comment.id];
    if (!isOwner && !token) return;
    if (!confirm("Delete this comment?")) return;
    try {
      await api.remove(comment.id, token);
      if (token) removeDeleteToken(comment.id);
      load();
      window.dispatchEvent(
        new CustomEvent("comments:updated", { detail: { trackId, playlistId } })
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "delete failed");
    }
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "0.4rem",
        }}
      >
        <div className="box-header" style={{ marginBottom: 0 }}>
          {trackId ? "track comments" : "playlist comments"}
          {totalCount > 0 && (
            <span style={{ marginLeft: "0.5rem", color: "var(--fg-dim)" }}>
              ({openCount} open / {totalCount})
            </span>
          )}
        </div>
        {totalCount > 0 && (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <FilterChip active={filter === "open"} onClick={() => setFilter("open")}>
              open
            </FilterChip>
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              all
            </FilterChip>
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }}>
        {visible.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.5rem 0" }}>
            {totalCount === 0
              ? "no comments yet"
              : filter === "open"
                ? "no open comments — all clear ✓"
                : "no comments"}
          </div>
        )}
        {visible.map((comment) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            isOwner={isOwner}
            ownDeleteTokens={loadDeleteTokens()}
            onReply={(id) => setReplyTo(id)}
            onSeek={onSeek}
            onResolve={handleResolve}
            onDelete={handleDelete}
            isTrack={!!trackId}
          />
        ))}
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: "0.75rem" }}>
        {replyTo && (
          <div style={{ color: "var(--fg-dim)", fontSize: "12px", marginBottom: "0.25rem" }}>
            replying to comment{" "}
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              style={{ ...linkBtn, fontSize: "12px" }}
            >
              [cancel]
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <input
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            placeholder="your name"
            required
            style={{ ...inputStyle, width: "150px", flex: "none" }}
          />
          {trackId && currentTime != null && (
            <span style={{ color: "var(--fg-dim)", fontSize: "12px", alignSelf: "center" }}>
              @ {formatTime(currentTime)}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={trackId ? "comment at current timestamp..." : "comment on playlist..."}
            required
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="submit" style={btnStyle}>
            [send]
          </button>
        </div>
      </form>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#000" : "var(--fg-dim)",
        border: "1px solid var(--border)",
        fontFamily: "var(--font)",
        fontSize: "11px",
        padding: "2px 8px",
        cursor: "pointer",
        textTransform: "lowercase",
      }}
    >
      {children}
    </button>
  );
}

function CommentThread({
  comment,
  isOwner,
  ownDeleteTokens,
  onReply,
  onSeek,
  onResolve,
  onDelete,
  isTrack,
}: {
  comment: Comment;
  isOwner: boolean;
  ownDeleteTokens: Record<string, string>;
  onReply: (id: string) => void;
  onSeek?: (time: number) => void;
  onResolve: (c: Comment) => void;
  onDelete: (c: Comment) => void;
  isTrack: boolean;
}) {
  const initial = (comment.authorName?.trim()?.[0] ?? "?").toUpperCase();
  const color = avatarColor(comment.authorName || "?");
  const resolved = comment.resolvedAt != null;
  const canDelete = isOwner || !!ownDeleteTokens[comment.id];

  return (
    <div
      style={{
        padding: "0.5rem 0",
        borderBottom: "1px solid var(--border)",
        opacity: resolved ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
        <span
          aria-hidden
          style={{
            position: "relative",
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: color,
            color: "#000",
            fontFamily: "var(--font)",
            fontSize: 11,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
          }}
        >
          {initial}
          {resolved && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                bottom: -3,
                right: -3,
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "#6c6",
                color: "#000",
                fontSize: 9,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid var(--bg)",
              }}
              title="Resolved"
            >
              ✓
            </span>
          )}
        </span>
        {isTrack && comment.timestampSec != null && (
          <button
            onClick={() => onSeek?.(comment.timestampSec!)}
            style={{ ...linkBtn, color: "var(--accent)", fontSize: "12px", fontVariantNumeric: "tabular-nums" }}
            title="Jump to this moment"
          >
            {formatTime(comment.timestampSec)}
          </button>
        )}
        <span style={{ color: "var(--fg)", fontSize: "12px" }}>
          {comment.authorName}
        </span>
        <span
          style={{
            flex: 1,
            textDecoration: resolved ? "line-through" : "none",
          }}
        >
          {comment.body}
        </span>
        {isOwner && (
          <button
            onClick={() => onResolve(comment)}
            style={{
              ...linkBtn,
              color: resolved ? "var(--fg-dim)" : "#6c6",
              fontSize: "12px",
            }}
            title={resolved ? "Mark as open" : "Mark as resolved"}
          >
            {resolved ? "[reopen]" : "[✓ resolve]"}
          </button>
        )}
        <button
          onClick={() => onReply(comment.id)}
          style={{ ...linkBtn, color: "var(--fg-dim)", fontSize: "12px" }}
        >
          [reply]
        </button>
        {canDelete && (
          <button
            onClick={() => onDelete(comment)}
            style={{ ...linkBtn, color: "var(--fg-dim)", fontSize: "12px" }}
            title="Delete comment"
          >
            [x]
          </button>
        )}
      </div>

      {comment.replies && comment.replies.length > 0 && (
        <div style={{ marginLeft: "2rem", marginTop: "0.25rem" }}>
          {comment.replies.map((reply) => (
            <div
              key={reply.id}
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "baseline",
                padding: "0.25rem 0",
                color: "var(--fg-dim)",
              }}
            >
              <span style={{ fontSize: "12px" }}>└</span>
              <span style={{ color: "var(--accent)", fontSize: "12px" }}>
                {reply.authorName}
              </span>
              <span>{reply.body}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  padding: "0.4rem 0.5rem",
};

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  color: "var(--accent)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  padding: "0.4rem 0.75rem",
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  fontFamily: "var(--font)",
  cursor: "pointer",
  padding: 0,
};
