import React, { useState } from 'react';

interface Props {
  value: string;
  title?: string;
  className?: string;
}

// Small inline "copy to clipboard" button. Stops propagation so it doesn't
// trigger the parent row's click handler (which runs a lookup).
export default function CopyButton({ value, title, className }: Props) {
  const [copied, setCopied] = useState(false);

  async function onCopy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for environments without async clipboard access.
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      onClick={onCopy}
      title={title ?? 'Copy contract address'}
      className={
        className ??
        'inline-flex items-center justify-center w-4 h-4 rounded text-[10px] leading-none ' +
          'text-slate-500 hover:text-emerald-400 hover:bg-slate-800/60 shrink-0'
      }
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}
