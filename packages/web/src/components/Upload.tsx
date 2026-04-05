import { useRef, useState } from "react";
import { tracks as tracksApi } from "../lib/api";

type Props = {
  playlistId: string;
  onUpload: () => void;
};

export default function Upload({ playlistId, onUpload }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  async function handleFiles(files: FileList | null) {
    if (!files) return;

    const fileList = Array.from(files);
    setUploading(true);
    setProgress({ current: 0, total: fileList.length });

    for (let i = 0; i < fileList.length; i++) {
      setProgress({ current: i + 1, total: fileList.length });
      await tracksApi.upload(playlistId, fileList[i]);
    }

    setUploading(false);
    setProgress({ current: 0, total: 0 });
    onUpload();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files)}
      />
      {uploading ? (
        <span style={{ color: "var(--accent)", fontSize: "12px" }}>
          uploading {progress.current}/{progress.total}...
        </span>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          title="Upload audio files (WAV, MP3, AIFF, M4A)"
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--accent)",
            fontFamily: "var(--font)",
            fontSize: "13px",
            padding: "0.5rem 1rem",
            cursor: "pointer",
          }}
        >
          [+ upload]
        </button>
      )}
    </div>
  );
}
