import figlet from "figlet";
import dosRebel from "figlet/importable-fonts/DOS Rebel.js";
import PixelArt from "./PixelArt";

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
  // Drawn as cells rather than text — see PixelArt. The floor is what makes a
  // long title drift sideways instead of shrinking, and it is kept at the same
  // 7px the CSS used so the drift animation is unchanged. Its ORIGINAL reason
  // is gone, though: 7px was where block glyphs stopped tiling and the name
  // turned to mush. Cells do not mush. It now means "do not shrink a title
  // below legible", which is a readability floor, not a rendering one.
  return (
    <div className="ascii-fit ascii-fit-title">
      <PixelArt
        className="ascii-title"
        art={trimmed}
        label={text}
        capPx={8}
        floorPx={7}
        headingLevel={2}
      />
    </div>
  );
}
