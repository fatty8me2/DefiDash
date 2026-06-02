import React, { useState } from 'react';

export default function SearchBar({
  onSubmit,
  loading
}: {
  onSubmit: (contract: string) => void;
  loading: boolean;
}) {
  const [value, setValue] = useState('');

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0xToken… or Solana mint address"
        className="mono flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
      />
      <button
        type="submit"
        disabled={loading || !value.trim()}
        className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white px-4 py-2 rounded text-sm font-medium"
      >
        {loading ? 'Looking up…' : 'Look up buyers'}
      </button>
    </form>
  );
}
