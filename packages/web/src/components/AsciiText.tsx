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
  // Publish the rendered width as --cols and let CSS size the type against the
  // real viewport. Sizing against a hardcoded desktop column here instead meant
  // phones got glyphs scaled for a screen four times wider, and the title
  // overflowed sideways. CSS also re-solves this on rotate and resize for free.
  const cols = Math.max(...trimmed.split("\n").map((l) => l.length));
  return (
    <div className="ascii-fit">
      <pre
        className="ascii-logo ascii-title"
        style={{ "--cols": cols } as React.CSSProperties}
        role="heading"
        aria-level={2}
        aria-label={text}
      >
        {trimmed}
      </pre>
    </div>
  );
}
