import { useId } from "react";
/* Jeu d'icônes linéaires du Design System NuitSignal (repris de cockpit.js). */
const PATHS: Record<string, string> = {
  inbox: "M3 13h4l1.5 3h7L17 13h4M3 13l2.6-7.1A2 2 0 0 1 7.5 4.6h9a2 2 0 0 1 1.9 1.3L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  folder: "M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2.4H19a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  history: "M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V10h5.2M12 8v4.4l3.2 1.9",
  chart: "M4 20V4M4 20h16M8 20v-6.5M12.5 20V8.5M17 20v-9.5",
  sliders: "M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-4M19 12V4M2.5 14h5M9.5 7h5M16.5 16h5",
  signal: "M4 18V11M9 18V6M14 18v-5M19 18V8",
  calendar: "M7 3v3M17 3v3M4 8.5h16M5 6h14a1.5 1.5 0 0 1 1.5 1.5V19A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6z",
  bulb: "M9.5 18h5M10 21h4M12 3a6 6 0 0 1 3.6 10.8c-.6.5-.9 1-.9 1.7v.5h-5.4v-.5c0-.7-.3-1.2-.9-1.7A6 6 0 0 1 12 3z",
  arrow: "M4 12h15M13.5 6.5 20 12l-6.5 5.5",
  back: "M20 12H5M10.5 6.5 4 12l6.5 5.5",
  check: "M4.5 12.5 9.5 17.5 19.5 6.5",
  cross: "M6 6l12 12M18 6 6 18",
  alert: "M12 9v4.5M12 16.8v.2M12 3.8 21 19.5H3z",
  shield: "M12 21s7-3.3 7-9V5.6L12 3 5 5.6V12c0 5.7 7 9 7 9z",
  info: "M12 11v6M12 7.6v.2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  caret: "M9 5l7 7-7 7",
  clock: "M12 7.5V12l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  spin: "M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M5.6 5.6l2.5 2.5M15.9 15.9l2.5 2.5M18.4 5.6l-2.5 2.5M8.1 15.9l-2.5 2.5",
  dot: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  undo: "M4 9h9.5a5.5 5.5 0 1 1 0 11H7M4 9l4-4M4 9l4 4",
  home: "M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z",
  team: "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20v-1.2A4.3 4.3 0 0 1 7.3 14.5h2.4A4.3 4.3 0 0 1 14 18.8V20M16 5.3a3 3 0 0 1 0 5.9M17.5 14.6A4.3 4.3 0 0 1 21 18.8V20",
  flag: "M6 21V4M6 4.6h11l-2.2 4.2L17 13H6",
  book: "M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5A1.5 1.5 0 0 0 20 18.5z",
  mail: "M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5zM3.6 7l8.4 6 8.4-6",
  search: "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.8 15.8 20 20",
  chat: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16H5.5A1.5 1.5 0 0 1 4 14.5z",
  pause: "M9.5 5v14M14.5 5v14",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.8 5.8l12.4 12.4",
  doc: "M6 3.5h7.5L19 9v11.5H6zM13 3.5V9h6",
  link: "M10 13.8a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2M14 10.2a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2",
  send: "M4 12 20 4l-5.5 16L12 14z",
  euro: "M16.5 7.4A6 6 0 1 0 16.5 16.6M4.5 10.5h8M4.5 13.5h8",
  plus: "M12 5v14M5 12h14",
  logout: "M14 4.5h4.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H14M10 8l-4 4 4 4M6 12h9",
  plug: "M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4",
};
export type IconName = keyof typeof PATHS | string;
export function Icon({ name, size, style }: { name: IconName; size?: number; style?: React.CSSProperties }) {
  return (
    <svg className="od-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ ...(size ? ({ ["--od-icon-size" as any]: size + "px" }) : {}), ...style }}>
      <path d={PATHS[name] ?? PATHS.dot} />
    </svg>
  );
}
export function Logo({ width = 186 }: { width?: number }) {
  // identifiants uniques : le logo est rendu deux fois (colonne et barre de titre), l'une des deux étant masquée
  const u = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} viewBox="0 0 248 48" role="img" aria-label="NuitSignal">
      <defs>
        <linearGradient id={"nsB" + u} x1="7" y1="4" x2="28" y2="59" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#60A5FA" /><stop offset="1" stopColor="#2563EB" /></linearGradient>
        <linearGradient id={"nsV" + u} x1="64" y1="2" x2="27" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#C4B5FD" /><stop offset=".55" stopColor="#A78BFA" /><stop offset="1" stopColor="#7C3AED" /></linearGradient>
      </defs>
      <g transform="translate(0 1) scale(.72)">
        <path fill={`url(#nsB${u})`} d="M7 9C7 5 11 4 15 7L28 17C20 27 19 39 27 49V59C15 58 7 52 7 43Z" />
        <path fill={`url(#nsV${u})`} d="M49 2C60 5 64 14 64 23V56C64 59 62 60 59 58L39 43C30 36 27 27 30 19L49 36Z" />
      </g>
      <text x="57" y="35" fill="#F4F7FF" fontFamily="Arial, Helvetica, sans-serif" fontSize="35" fontWeight="700" letterSpacing="-1.2">NuitSignal</text>
    </svg>
  );
}
