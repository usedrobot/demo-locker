import { useRef } from "react";

type Props = {
  onPick: (files: File[]) => void;
};

export default function Upload({ onPick }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    onPick(Array.from(files));
    if (inputRef.current) inputRef.current.value = "";
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
    </div>
  );
}
