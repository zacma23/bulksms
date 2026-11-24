export function ZacmaBrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="40" height="40" rx="10" fill="#1D4ED8" />
      <path d="M10 12H30L16 28H30" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="26" y="8" width="6" height="6" rx="1.5" fill="#DC2626" />
    </svg>
  );
}
