import { useRef } from "react";
import { tracks as tracksApi } from "../lib/api";

type Props = {
  playlistId: string;
  onUpload: () => void;
};

export default function Upload({ playlistId, onUpload }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files) return;

    for (const file of Array.from(files)) {
      await tracksApi.upload(playlistId, file);
    }

    onUpload();
  }

  return (
    <>
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
    </>
  );
}
