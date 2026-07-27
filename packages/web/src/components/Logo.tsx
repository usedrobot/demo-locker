import { ART } from "./logo-art";

export default function Logo() {
  return (
    <div className="ascii-fit">
      <pre className="ascii-logo" role="img" aria-label="demo locker">
        {ART}
      </pre>
    </div>
  );
}
