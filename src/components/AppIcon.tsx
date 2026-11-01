/** 品牌图标（assets/icon.svg 的内联版，顶栏 / 空态等场景使用）。 */
export function AppIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="app-icon-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5B8DEF" />
          <stop offset="1" stopColor="#2F5FD6" />
        </linearGradient>
        <linearGradient id="app-icon-card" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#EDF2FB" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill="url(#app-icon-bg)" />
      <path
        d="M400 512 C 520 512 520 320 640 320"
        stroke="#FFFFFF"
        strokeOpacity="0.85"
        strokeWidth="30"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M400 512 C 520 512 520 704 640 704"
        stroke="#FFFFFF"
        strokeOpacity="0.85"
        strokeWidth="30"
        fill="none"
        strokeLinecap="round"
      />
      <rect x="176" y="440" width="224" height="144" rx="36" fill="url(#app-icon-card)" />
      <circle cx="234" cy="512" r="21" fill="none" stroke="#8FA3C8" strokeWidth="10" />
      <rect x="272" y="500" width="98" height="24" rx="12" fill="#C4D2EE" />
      <rect x="640" y="248" width="208" height="144" rx="36" fill="#FFFFFF" fillOpacity="0.94" />
      <circle cx="692" cy="320" r="19" fill="none" stroke="#8FA3C8" strokeWidth="9" />
      <rect x="726" y="308" width="88" height="24" rx="12" fill="#C4D2EE" />
      <circle cx="744" cy="704" r="104" fill="#3ECF8E" />
      <path
        d="M700 704 l30 32 l58 -64"
        stroke="#FFFFFF"
        strokeWidth="26"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
