import { useState, useEffect } from "react";
import { comments as api, type Comment } from "../lib/api";

type Props = {
  trackId?: string;
  playlistId?: string;
  currentTime?: number;
  onSeek?: (time: number) => void;
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function Comments({ trackId, playlistId, currentTime, onSeek }: Props) {
  const [items, setItems] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [authorName, setAuthorName] = useState(
    () => localStorage.getItem("commentName") || ""
  );
  const [replyTo, setReplyTo] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [trackId, playlistId]);

  function load() {
    if (trackId) {
      api.forTrack(trackId).then((r) => setItems(r.comments));
    } else if (playlistId) {
      api.forPlaylist(playlistId).then((r) => setItems(r.comments));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || !authorName.trim()) return;

    localStorage.setItem("commentName", authorName);

    await api.create({
      trackId: trackId || undefined,
      playlistId: playlistId || undefined,
      authorName: authorName.trim(),
      body: body.trim(),
      timestampSec: trackId && currentTime ? currentTime : undefined,
      parentId: replyTo || undefined,
    });

    setBody("");
    setReplyTo(null);
    load();
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      <div className="box-header">
        {trackId ? "track comments" : "playlist comments"}
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }}>
        {items.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.5rem 0" }}>
            no comments yet
          </div>
        )}
        {items.map((comment) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            onReply={(id) => setReplyTo(id)}
            onSeek={onSeek}
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

function CommentThread({
  comment,
  onReply,
  onSeek,
  isTrack,
}: {
  comment: Comment;
  onReply: (id: string) => void;
  onSeek?: (time: number) => void;
  isTrack: boolean;
}) {
  return (
    <div style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "baseline" }}>
        {isTrack && comment.timestampSec != null && (
          <button
            onClick={() => onSeek?.(comment.timestampSec!)}
            style={{ ...linkBtn, color: "var(--accent)", fontSize: "12px" }}
          >
            [{formatTime(comment.timestampSec)}]
          </button>
        )}
        <span style={{ color: "var(--accent)", fontSize: "12px" }}>
          {comment.authorName}
        </span>
        <span style={{ flex: 1 }}>{comment.body}</span>
        <button
          onClick={() => onReply(comment.id)}
          style={{ ...linkBtn, color: "var(--fg-dim)", fontSize: "12px" }}
        >
          [reply]
        </button>
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
