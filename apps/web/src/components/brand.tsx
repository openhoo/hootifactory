import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Hootifactory logomark — a line-art owl framed in a honeycomb cell
 * (hoot ⨉ factory). Drawn entirely with `currentColor` strokes so it reads on
 * any surface; set the color with a text-* class.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-7 text-primary", className)}
    >
      {/* honeycomb cell */}
      <path d="M16 2.6 27.6 9.3v13.4L16 29.4 4.4 22.7V9.3z" strokeWidth="2" />
      {/* owl eyes */}
      <circle cx="11.7" cy="14.4" r="3.05" strokeWidth="1.7" />
      <circle cx="20.3" cy="14.4" r="3.05" strokeWidth="1.7" />
      {/* pupils */}
      <circle cx="11.7" cy="14.4" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="20.3" cy="14.4" r="0.95" fill="currentColor" stroke="none" />
      {/* beak */}
      <path d="M16 18.1 17.7 21 14.3 21z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Wordmark — the mark plus "Hootifactory" set in the display face. */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="font-heading text-[1.05rem] leading-none font-semibold tracking-tight">
        Hootifactory
      </span>
    </span>
  );
}

/**
 * A seamless honeycomb texture for atmospheric backgrounds. Tints itself with
 * `currentColor`; control intensity with text-* + opacity on the element.
 */
export function HexPattern({ className }: { className?: string }) {
  // Unique id so multiple HexPattern instances (e.g. desktop sidebar + open
  // mobile sheet) don't collide on a shared SVG pattern id.
  const id = `hex${useId().replace(/:/g, "")}`;
  return (
    <svg
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    >
      <defs>
        <pattern
          id={id}
          width="28"
          height="49"
          patternUnits="userSpaceOnUse"
          patternTransform="scale(1.6)"
        >
          <path
            d="M13.99 9.25l13 7.5v15l-13 7.5L1 31.75v-15l12.99-7.5zM3 17.9v12.7l10.99 6.34 11-6.35V17.9l-11-6.34L3 17.9zM0 15l12.98-7.5V0h-2v6.35L0 12.69v2.3zm0 18.5L12.98 41v8h-2v-6.85L0 35.81v-2.3zM15 0v7.5L27.99 15H28v-2.31h-.01L17 6.35V0h-2zm0 49v-8l12.99-7.5H28v2.31h-.01L17 42.15V49h-2z"
            fill="currentColor"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
