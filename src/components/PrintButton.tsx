"use client";

/** Opens the browser's print dialog; from there "Save as PDF" or a printer. */
export function PrintButton() {
  return (
    <button type="button" className="print-btn" onClick={() => window.print()}>
      Print this edition
    </button>
  );
}
