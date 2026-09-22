/**
 * Logo slot. The mark is a white tile with black silhouettes; drop the final file at
 * public/logo.svg (or change LOGO_SRC) and every surface picks it up.
 */
const LOGO_SRC = "/logo.svg";

export default function Logo({ size = 32, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="logo">
      <img src={LOGO_SRC} width={size} height={size} alt={withWordmark ? "" : "Notestack"} className="logo-mark" />
      {withWordmark && <span className="logo-word">Notestack</span>}
    </span>
  );
}
