export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--fg)" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="var(--bg)" strokeWidth="2" />
      <circle cx="17.5" cy="7" r="2" fill="var(--accent)" />
    </svg>
  );
}
