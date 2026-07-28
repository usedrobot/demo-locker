import type { PendingUpload } from "../lib/use-upload-queue";

export default function PendingTrackRow({
  item,
  position,
  onTitleChange,
  onStart,
  onCancel,
}: {
  item: PendingUpload;
  position: number;
  onTitleChange: (title: string) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const pct = Math.round(item.progress * 100);
  const isDecoding = item.status === "decoding";
  const isEncoding = item.status === "encoding";
  const isUploading = item.status === "uploading";
  const isError = item.status === "error";
  // No rendition: the browser couldn't decode or encode this one, so it will
  // stream as-is. Say so quietly rather than looking identical to a success.
  const noRendition = item.status === "ready" && !item.stream;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.5rem 0.25rem",
        borderBottom: "1px solid var(--border)",
        position: "relative",
        background: "transparent",
      }}
    >
      {/* Progress fill behind the row */}
      {isUploading && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: "var(--accent-dim)",
            transition: "width 0.15s linear",
            pointerEvents: "none",
          }}
        />
      )}

      <span
        style={{ color: "var(--fg-dim)", fontSize: "11px", userSelect: "none", position: "relative" }}
        title="Pending upload"
      >
        ⠿
      </span>

      <span
        style={{
          color: "var(--fg-dim)",
          width: "2ch",
          textAlign: "right",
          fontSize: "12px",
          position: "relative",
        }}
      >
        {String(position).padStart(2, "0")}
      </span>

      <span style={{ width: "1.5ch", color: "var(--accent)", fontSize: "12px", position: "relative" }}>
        {isUploading ? "↑" : ""}
      </span>

      <input
        value={item.title}
        onChange={(e) => onTitleChange(e.target.value)}
        disabled={isUploading}
        placeholder="track title"
        style={{
          flex: 1,
          background: "transparent",
          border: "1px solid var(--border)",
          color: "var(--fg)",
          fontFamily: "var(--font)",
          fontSize: "13px",
          padding: "0.25rem 0.5rem",
          position: "relative",
        }}
      />

      {isUploading && (
        <span
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            width: "3ch",
            textAlign: "right",
            position: "relative",
          }}
        >
          {pct}%
        </span>
      )}

      {isDecoding && (
        <span
          className="dots"
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            position: "relative",
          }}
        >
          decoding
        </span>
      )}

      {isEncoding && (
        <span
          className="dots"
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            position: "relative",
          }}
        >
          encoding
        </span>
      )}

      {noRendition && (
        <span
          title="No streaming rendition could be made in this browser — the file will stream at its original size."
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            position: "relative",
          }}
        >
          will stream at full size
        </span>
      )}

      {!isUploading && !isDecoding && !isEncoding && (
        <button
          onClick={onStart}
          title="Start upload"
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--accent)",
            fontFamily: "var(--font)",
            fontSize: "12px",
            padding: "0.25rem 0.5rem",
            cursor: "pointer",
            position: "relative",
          }}
        >
          {isError ? "[retry]" : "[upload]"}
        </button>
      )}

      <button
        onClick={onCancel}
        disabled={isUploading}
        title="Remove"
        style={{
          background: "none",
          border: "none",
          color: "var(--fg-dim)",
          fontFamily: "var(--font)",
          fontSize: "12px",
          cursor: isUploading ? "default" : "pointer",
          padding: "0 0.25rem",
          position: "relative",
          opacity: isUploading ? 0.4 : 1,
        }}
      >
        [x]
      </button>

      {isError && (
        <div
          style={{
            position: "absolute",
            left: "5rem",
            bottom: "-1.1rem",
            color: "#f44",
            fontSize: "11px",
          }}
        >
          {item.error}
        </div>
      )}
    </div>
  );
}
