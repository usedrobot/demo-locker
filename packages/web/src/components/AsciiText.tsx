import figlet from "figlet";
import dosRebel from "figlet/importable-fonts/DOS Rebel.js";

figlet.parseFont("DOS Rebel", dosRebel);

type Props = {
  text: string;
};

// Renders text in the same DOS Rebel figlet font as the logo. Falls back to
// plain text if the font can't render the string (exotic characters, etc.).
export default function AsciiText({ text }: Props) {
  let art: string | null = null;
  try {
    art = figlet.textSync(text, { font: "DOS Rebel" });
  } catch {
    art = null;
  }
  if (!art || !art.trim()) {
    return (
      <h2 style={{ color: "var(--fg)", fontSize: "18px", fontFamily: "var(--font)", fontWeight: "normal" }}>
        {text}
      </h2>
    );
  }
  const trimmed = art
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
  // Scale down so long names still fit the ~816px content column
  // (monospace glyphs are ~0.62em wide).
  const cols = Math.max(...trimmed.split("\n").map((l) => l.length));
  const fontSize = Math.max(4, Math.min(8, Math.floor(816 / (cols * 0.62))));
  return (
    <pre
      className="ascii-logo ascii-title"
      style={{ fontSize: `${fontSize}px` }}
      role="heading"
      aria-level={2}
      aria-label={text}
    >
      {trimmed}
    </pre>
  );
}
