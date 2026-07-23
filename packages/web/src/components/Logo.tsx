import { ART } from "./logo-art";

export default function Logo() {
  return (
    <pre className="ascii-logo" role="img" aria-label="demo locker">
      {ART}
    </pre>
  );
}
