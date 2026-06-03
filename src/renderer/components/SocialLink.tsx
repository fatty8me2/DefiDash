import React from 'react';

interface Props {
  href: string;
  label: string;
  title: string;
  className?: string;
}

// Small inline social button used on the live-flow cards (X / Telegram /
// website). Stops propagation so it doesn't trigger the card's lookup click;
// opens in the system browser via the main-process window-open handler.
export default function SocialLink({ href, label, title, className }: Props) {
  function onOpen(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  return (
    <button
      onClick={onOpen}
      title={title}
      className={
        className ??
        'inline-flex items-center justify-center w-4 h-4 rounded text-[10px] leading-none text-slate-500 hover:text-emerald-400 hover:bg-slate-800/60 shrink-0'
      }
    >
      {label}
    </button>
  );
}
